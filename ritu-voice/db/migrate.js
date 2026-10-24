#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Migration runner
//
// Reads every *.sql file in db/migrations/ in alphabetical order, applies
// each one that hasn't been recorded in the `schema_migrations` tracking
// table. Each migration runs inside a transaction so a failed file leaves
// the database unchanged.
//
// Run:   node db/migrate.js
//   or:  npm run db:migrate
//
// Idempotent: re-running skips already-applied migrations.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTracker(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedVersions(pool) {
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  return new Set(rows.map(r => r.version));
}

// ─── THE NO-TRANSACTION ESCAPE HATCH ────────────────────────────────────────
// Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block (25001),
// and this runner wrapped every file in BEGIN/COMMIT. On 2026-08-03 a migration
// containing one was swept into a deploy, prestart exited 1, `start` never ran,
// and the voice line was 502 for an hour. The response at the time was to take
// the file OUT of git — which stopped the crash and left the booking statement
// depending on a column that exists in no tracked migration. Two clinics work
// only because someone applied it by hand once, and nothing records that.
//
// So: a file may opt out of the transaction with a directive on its own line:
//
//     -- @no-transaction
//
// This is what Rails (disable_ddl_transaction!), Django (atomic = False) and
// golang-migrate all do, for exactly this statement class.
//
// THE COST IS REAL AND IS WHY IT IS OPT-IN. Without BEGIN/COMMIT there is no
// rollback: a file that fails halfway leaves the database half-migrated, and a
// CONCURRENTLY build that fails leaves an INVALID index behind. That is
// survivable only if the file is IDEMPOTENT — every statement IF NOT EXISTS —
// so re-running completes it. check-migration-safety.js enforces that pairing;
// it is not left to whoever writes the next one to remember.
const { splitStatements } = require('./splitStatements');
const NO_TRANSACTION = /^\s*--\s*@no-transaction\s*$/m;

async function applyMigration(pool, version, sql) {
  const client = await pool.connect();
  const wrapped = !NO_TRANSACTION.test(sql);
  try {
    if (wrapped) await client.query('BEGIN');
    if (wrapped) {
      await client.query(sql);
    } else {
      // ─── @no-transaction MEANS ONE STATEMENT AT A TIME ────────────────────
      // It used to mean only "skip our BEGIN/COMMIT", which was never enough:
      // `client.query(wholeFile)` is a multi-statement SIMPLE query, and
      // Postgres wraps those in an IMPLICIT transaction. So CREATE INDEX
      // CONCURRENTLY raised 25001 anyway — the directive promised something it
      // could not deliver.
      //
      // PROVEN 2026-08-13 on a virgin Postgres 16, the first time this repo has
      // run its migrations against an empty database:
      //     ✗ 005_booking_integrity failed: CREATE INDEX CONCURRENTLY cannot
      //       run inside a transaction block
      //
      // 005 was worked around by hand-applying it with tools/applyMigration.js
      // and committing it pre-applied so the runner skips it. That covers the
      // clinics already migrated and NOT a new one — and one deploy + one
      // database per clinic is the architecture, so every new clinic
      // crash-loops on first boot unless somebody remembers the manual step.
      //
      // Sent individually, each statement is its own implicit transaction and
      // CONCURRENTLY does what it was asked for: build the index without
      // locking the table the clinic is booking into.
      for (const stmt of splitStatements(sql)) {
        await client.query(stmt);
      }
    }
    // The bookkeeping row is written in the SAME transaction when there is one,
    // so a failed migration can never be recorded as applied. Unwrapped, it is
    // written after the SQL succeeds — the ordering that makes a partial failure
    // re-runnable rather than silently skipped.
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    if (wrapped) await client.query('COMMIT');
  } catch (err) {
    if (wrapped) {
      await client.query('ROLLBACK');
    } else {
      console.error(`  ⚠ ${version} ran WITHOUT a transaction — the database may be partially migrated. It is idempotent by contract: re-run to complete it.`);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  // Visible warning so nobody accidentally migrates production.
  const dbHostHint = process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@').slice(0, 80);
  console.log(`Migrating ${dbHostHint}…`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ensureTracker(pool);
    const already = await appliedVersions(pool);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (already.has(version)) {
        console.log(`✓ ${version} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`→ applying ${version}…${NO_TRANSACTION.test(sql) ? ' (no transaction — see the directive in the file)' : ''}`);
      try {
        await applyMigration(pool, version, sql);
        console.log(`✓ ${version} applied`);
        appliedCount++;
      } catch (err) {
        console.error(`✗ ${version} failed:`, err.message);
        throw err;
      }
    }

    if (appliedCount === 0) console.log('\nNothing to apply.');
    else console.log(`\n✓ ${appliedCount} migration(s) applied.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch(err => {
    console.error('\nFATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate };
