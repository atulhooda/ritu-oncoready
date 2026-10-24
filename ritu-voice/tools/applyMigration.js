#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// HAND-APPLY A MIGRATION (the ones db/migrate.js must not run)
//
// WHY THIS EXISTS: db/migrate.js wraps each file in BEGIN/COMMIT, but
// CREATE INDEX CONCURRENTLY cannot run inside a transaction. 005 uses it (on
// purpose — it builds the double-book indexes WITHOUT locking the appointments
// table, so the clinic keeps booking while it runs). Committing 005 as-is would
// make every boot try it, fail, and crash-loop the server. So it is applied by
// hand, recorded in schema_migrations, and only then committed — after which
// the runner sees it as done and skips it.
//
// Needs no psql: uses the `pg` client the server already depends on. Each
// statement runs STANDALONE (no wrapping transaction), which is exactly what
// CONCURRENTLY requires.
//
// SAFETY, because this points at real clinic databases:
//   • dry-run by default — you must pass --apply to change anything
//   • prints the target host and refuses to continue without --yes
//   • runs 005's PRE-FLIGHT duplicate checks first and REFUSES if any row
//     would violate a new unique index (better to find that now than halfway
//     through an index build)
//   • records the version in schema_migrations only after every statement
//     succeeds
//
// USAGE (demo first, then hospital):
//   DATABASE_URL="postgresql://…" node tools/applyMigration.js db/migrations/005_booking_integrity.sql
//        → dry run: shows the statements and the pre-flight result
//   DATABASE_URL="postgresql://…" node tools/applyMigration.js db/migrations/005_booking_integrity.sql --apply --yes
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');

if (!file) {
  console.error('usage: DATABASE_URL=… node tools/applyMigration.js <migration.sql> [--apply --yes]');
  process.exit(2);
}
const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
if (!fs.existsSync(abs)) { console.error(`no such file: ${abs}`); process.exit(2); }
const version = path.basename(abs).replace(/\.sql$/, '');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
const host = (url.match(/@([^:/]+)/) || [])[1] || 'unknown-host';

// ONE SPLITTER, SHARED WITH db/migrate.js. This file used to keep its own:
// strip `--` lines, split on every `;`. MEASURED on migration 009, which uses a
// DO block, that produced three fragments — "DO $$ BEGIN IF NOT EXISTS (…",
// "END IF", "END $$" — out of one statement. It survived only because 009 was
// never hand-applied. db/splitStatements.js respects dollar-quoted bodies,
// string literals and comments; see tests/test-split-statements.js.
const { splitStatements: statements } = require('../db/splitStatements');

// 005's pre-flight: rows that would violate each new unique index. Both must
// come back empty — a hit means real duplicate bookings that clinic staff need
// to resolve before the index can exist.
const PREFLIGHT = [
  {
    name: 'same patient booked twice with the same doctor',
    sql: `SELECT clinic_id, patient_id, doctor_id, count(*) AS dup_rows,
                 array_agg(id ORDER BY appointment_time) AS appointment_ids
            FROM appointments WHERE status = 'booked'
           GROUP BY 1,2,3 HAVING count(*) > 1`,
  },
  {
    name: 'two scheduled patients in one doctor slot',
    sql: `SELECT a.doctor_id, a.appointment_time, count(*) AS dup_rows,
                 array_agg(a.id) AS appointment_ids
            FROM appointments a WHERE a.status = 'booked'
             AND NOT EXISTS (SELECT 1 FROM doctor_schedules s
                              WHERE s.doctor_id = a.doctor_id AND s.is_walk_in)
           GROUP BY 1,2 HAVING count(*) > 1`,
  },
];

(async () => {
  const client = new Client({ connectionString: url });
  await client.connect();

  console.log(`\n  migration : ${version}`);
  console.log(`  database  : ${host}`);
  console.log(`  mode      : ${APPLY ? '*** APPLY (will change the database) ***' : 'dry run (nothing will change)'}\n`);

  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows: done } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (done.length) {
      console.log(`  already recorded as applied on this database — nothing to do.\n`);
      return;
    }

    // Pre-flight (005 only; harmless to skip elsewhere)
    if (/booking_integrity/.test(version)) {
      console.log('  PRE-FLIGHT — checking for rows that would break the new rules:');
      let blocked = false;
      for (const chk of PREFLIGHT) {
        let r;
        try { r = await client.query(chk.sql); }
        catch (e) { console.log(`    ? ${chk.name}: could not check (${e.message.split('\n')[0]})`); continue; }
        if (r.rows.length) {
          blocked = true;
          console.log(`    ✗ ${chk.name}: ${r.rows.length} conflict(s)`);
          for (const row of r.rows.slice(0, 10)) console.log(`        ${JSON.stringify(row)}`);
        } else {
          console.log(`    ✓ ${chk.name}: none`);
        }
      }
      if (blocked) {
        console.log('\n  REFUSING: resolve these duplicate bookings with clinic staff first');
        console.log('  (cancel the rows the patient does not want), then re-run.\n');
        process.exitCode = 1;
        return;
      }
    }

    const stmts = statements(fs.readFileSync(abs, 'utf8'));
    console.log(`\n  ${stmts.length} statement(s) to run:`);
    stmts.forEach((s, i) => console.log(`    ${i + 1}. ${s.replace(/\s+/g, ' ').slice(0, 96)}…`));

    if (!APPLY) {
      console.log('\n  dry run only. Re-run with --apply --yes to actually apply.\n');
      return;
    }
    if (!YES) {
      console.log(`\n  --apply given but --yes missing. This would modify ${host}. Add --yes to confirm.\n`);
      process.exitCode = 1;
      return;
    }

    console.log('\n  applying (each statement standalone, no wrapping transaction):');
    for (let i = 0; i < stmts.length; i++) {
      process.stdout.write(`    ${i + 1}/${stmts.length} … `);
      await client.query(stmts[i]);          // standalone — CONCURRENTLY needs this
      console.log('ok');
    }
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    console.log(`\n  ✓ applied and recorded as "${version}".`);
    console.log('  db/migrate.js will now SKIP this file, so it is safe to commit.\n');
  } catch (err) {
    console.error(`\n  ✗ FAILED: ${err.message}`);
    if (/concurrently/i.test(err.message)) {
      console.error('  (CONCURRENTLY cannot run inside a transaction — this tool runs each');
      console.error('   statement standalone, so a pooler in transaction mode may be the cause.)');
    }
    console.error('  Nothing was recorded in schema_migrations; safe to fix and re-run.');
    console.error('  If an index build failed midway it may have left an INVALID index:');
    console.error("    SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE NOT i.indisvalid;");
    console.error('  DROP INDEX <name>; then re-run.\n');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
