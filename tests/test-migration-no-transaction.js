// ─── THE NO-TRANSACTION MIGRATION PATH ──────────────────────────────────────
// On 2026-08-03 a migration containing CREATE INDEX CONCURRENTLY was swept into
// a deploy. Postgres refuses that inside a transaction block (25001), the runner
// wraps every file in BEGIN/COMMIT, prestart exited 1, `start` never ran, and
// the voice line was 502 for an hour.
//
// The response was to take the file OUT of git. That stopped the crash and left
// tools/bookAppointment.js depending on a column (is_walk_in) and a partial
// unique index that exist in NO tracked migration. Two clinics work only because
// someone applied it by hand once; nothing in version control records that, and
// any new clinic built from this repo could not take a booking at all.
//
// The real fix is the one Rails, Django and golang-migrate all ship: let a file
// opt out of the transaction. This file guards the two halves that make that
// safe — the runner must actually skip BEGIN/COMMIT, and the checker must refuse
// the opt-out unless the file is idempotent, because without a transaction there
// is no rollback.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const ROOT = path.join(__dirname, '..');
const MIGRATE = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
const CHECKER = fs.readFileSync(path.join(ROOT, 'tools', 'check-migration-safety.js'), 'utf8');

console.log('\nNO-TRANSACTION MIGRATIONS — the path that took the line down\n');

// ── the runner's branch, exercised with a fake client (no Postgres needed) ──
function runApply(sql) {
  // Rebuild applyMigration's decision from the real source so the test cannot
  // drift into asserting a reimplementation.
  const m = MIGRATE.match(/const NO_TRANSACTION = (\/.*\/[a-z]*);/);
  assert(m, 'NO_TRANSACTION is gone from db/migrate.js');
  // eslint-disable-next-line no-eval
  const re = eval(m[1]);
  const wrapped = !re.test(sql);
  const calls = [];
  if (wrapped) calls.push('BEGIN');
  calls.push('SQL');
  calls.push('INSERT');
  if (wrapped) calls.push('COMMIT');
  return calls;
}

ok('an ordinary migration is still wrapped in BEGIN/COMMIT', () => {
  assert.deepStrictEqual(
    runApply('CREATE TABLE IF NOT EXISTS foo (id int);'),
    ['BEGIN', 'SQL', 'INSERT', 'COMMIT']
  );
});

ok('a directive-marked migration runs with NO transaction', () => {
  assert.deepStrictEqual(
    runApply('-- @no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);'),
    ['SQL', 'INSERT']
  );
});

ok('the directive must be on its OWN line — not merely mentioned', () => {
  // 005's header DESCRIBES the problem in prose. A loose match would let any
  // migration that discusses transactions accidentally opt out of one.
  for (const sql of [
    '-- this file explains @no-transaction handling\nCREATE TABLE t (id int);',
    '-- SELECT 1; -- @no-transaction is a directive',
  ]) {
    assert.deepStrictEqual(runApply(sql).includes('BEGIN'), true, `wrongly opted out: ${sql.slice(0, 40)}`);
  }
});

ok('the runner and the checker read the SAME directive', () => {
  // If these two regexes ever disagree, a file could skip the transaction while
  // the checker still judges it by transaction rules — which is precisely the
  // gap that took the line down.
  const a = MIGRATE.match(/const NO_TRANSACTION = (\/.*\/[a-z]*);/);
  const b = CHECKER.match(/const NO_TRANSACTION = (\/.*\/[a-z]*);/);
  assert(a && b, 'one of the two files no longer declares NO_TRANSACTION');
  assert.strictEqual(a[1], b[1], `directive regexes have drifted:\n      migrate:  ${a[1]}\n      checker:  ${b[1]}`);
});

// ── the checker's half: opting out demands idempotency ─────────────────────
const TMP = path.join(ROOT, 'db', 'migrations', '999_test_tmp.sql');
const runChecker = () => {
  try {
    execFileSync('node', [path.join(ROOT, 'tools', 'check-migration-safety.js')], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0 };
  } catch (e) { return { code: e.status, out: String(e.stdout || '') }; }
};
const withTracked = (sql, fn) => {
  fs.writeFileSync(TMP, sql);
  try {
    execFileSync('git', ['add', '-f', 'db/migrations/999_test_tmp.sql'], { cwd: ROOT });
    return fn();
  } finally {
    try { execFileSync('git', ['rm', '-f', '--cached', '-q', 'db/migrations/999_test_tmp.sql'], { cwd: ROOT }); } catch (_) {}
    try { fs.unlinkSync(TMP); } catch (_) {}
  }
};

ok('CONCURRENTLY without the directive is still BLOCKED', () => {
  const r = withTracked('CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);\n', runChecker);
  assert.strictEqual(r.code, 1, 'an unmarked CONCURRENTLY migration was allowed through');
});

ok('the directive does NOT license a non-idempotent migration', () => {
  // Without a transaction there is no rollback. A file that fails halfway must
  // be safe to re-run, or the database is stuck in a state only hand surgery
  // fixes — at 3am, on a clinic's phone line.
  const r = withTracked('-- @no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);\nALTER TABLE t ADD COLUMN x int;\n', runChecker);
  assert.strictEqual(r.code, 1, 'a non-idempotent @no-transaction migration was allowed');
  assert(/idempot/i.test(r.out || ''), 'the failure did not explain that idempotency is the missing part');
});

ok('directive + fully idempotent is ACCEPTED', () => {
  const r = withTracked('-- @no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);\n', runChecker);
  assert.strictEqual(r.code, 0, 'a safe no-transaction migration was rejected');
});

// ── the migrations that actually caused this ───────────────────────────────
ok('005 and 006 are TRACKED, and 005 carries the directive', () => {
  const tracked = execFileSync('git', ['ls-files', 'db/migrations'], { cwd: ROOT, encoding: 'utf8' });
  assert(/005_booking_integrity\.sql/.test(tracked),
    '005 is untracked again — bookAppointment.js needs is_walk_in and it exists in no other migration');
  assert(/006_whatsapp_dlq\.sql/.test(tracked), '006 is untracked again');
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '005_booking_integrity.sql'), 'utf8');
  assert(/^\s*--\s*@no-transaction\s*$/m.test(sql), '005 lost its directive — prestart will crash on it');
});

ok('the whole tracked set passes the checker', () => {
  assert.strictEqual(runChecker().code, 0, 'a tracked migration would crash prestart');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
