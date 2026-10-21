#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// BACKFILL name_latin, AND SHOW THE JUNK WHILE WE ARE HERE
//
// Migration 010 added patients.name_latin so the desk can list callers in a
// script its staff can read. New rows get it from patientIdentity.resolvePatient;
// the rows already in the table need one pass.
//
// DRY RUN BY DEFAULT. This is a clinic's live patient table.
//
//     node tools/backfill-name-latin.js              # show what would change
//     node tools/backfill-name-latin.js --apply      # write it
//
// It also LISTS the rows whose `name` is not a name at all — "your name",
// "[Patient Name]", "Unknown", "ಅಪರಿಚಿತ", "." — because the desk shows those to
// staff as people, and one of them was read back to a caller as his own name in
// four separate calls. Those rows are NOT touched: deleting or renaming a
// patient row is a clinical-records decision with appointments hanging off it,
// and it belongs to the clinic, not to a script. Naming them is the job here.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { latinFormOf } = require('../patientIdentity');
const { cleanPersonName } = require('../nameGuard');

const APPLY = process.argv.includes('--apply');
// SSL only for managed hosts. A local throwaway Postgres does not offer it, and
// forcing it there fails with "the server does not support SSL connections" —
// which reads like a permissions problem rather than a config one.
const URL = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: URL,
  ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
});

(async () => {
  // The column arrives with migration 010, which runs on deploy (prestart). A
  // raw "column does not exist" from the driver tells the operator nothing
  // about what to do next.
  const { rows: col } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'patients' AND column_name = 'name_latin'`);
  if (!col.length) {
    console.error('\n✗ patients.name_latin does not exist yet.');
    console.error('  Migration 010 runs at deploy (npm prestart). Deploy first, then re-run this.');
    console.error('  To apply it by hand against a NON-production database:');
    console.error('    DATABASE_URL=… node db/migrate.js\n');
    await pool.end();
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.clinic_id, p.name, p.name_latin, p.phone, c.name AS clinic
       FROM patients p LEFT JOIN clinics c ON c.id = p.clinic_id
      ORDER BY c.name, p.created_at`
  );

  const junk = [];
  const toWrite = [];
  for (const r of rows) {
    if (!cleanPersonName(r.name)) { junk.push(r); continue; }
    const latin = latinFormOf(r.name);
    if (latin && latin !== r.name_latin) toWrite.push({ ...r, latin });
  }

  console.log(`\n${rows.length} patient row(s)\n`);

  if (toWrite.length) {
    console.log(`── ${toWrite.length} would get a readable form ──`);
    for (const r of toWrite) {
      console.log(`  ${String(r.clinic || '?').slice(0, 14).padEnd(15)} ${r.name.padEnd(22)} -> ${r.latin}`);
    }
  } else {
    console.log('── nothing to romanize (every non-Latin name already has one) ──');
  }

  if (junk.length) {
    console.log(`\n── ${junk.length} row(s) whose NAME IS NOT A NAME ──`);
    console.log('   Shown, not touched. The desk lists these as people; one of them');
    console.log('   ("your name") was spoken back to a caller as his own name in four');
    console.log('   later calls. Deleting or merging them is a clinical-records');
    console.log('   decision with appointments attached — the clinic\'s call, not this');
    console.log('   script\'s. New calls can no longer create them (47aa061, f972115).');
    for (const r of junk) {
      console.log(`  ${String(r.clinic || '?').slice(0, 14).padEnd(15)} ${JSON.stringify(r.name).padEnd(22)} @${r.phone}  ${r.id.slice(0, 8)}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN. Re-run with --apply to write ${toWrite.length} row(s).\n`);
    await pool.end();
    return;
  }

  let n = 0;
  for (const r of toWrite) {
    await pool.query(`UPDATE patients SET name_latin = $1 WHERE id = $2`, [r.latin, r.id]);
    n++;
  }
  console.log(`\n✓ ${n} row(s) updated. The original \`name\` was not changed on any of them.\n`);
  await pool.end();
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
