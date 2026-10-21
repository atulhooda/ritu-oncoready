#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WILL prestart SURVIVE THIS DEPLOY?
//
// WHY THIS EXISTS. On 2026-08-03 the voice server was down for about an hour and
// every call got a 502. Cause:
//
//   package.json:7   "prestart": "node db/migrate.js"
//   db/migrate.js:36-48  applyMigration wraps EVERY file in BEGIN/COMMIT
//   db/migrations/005_booking_integrity.sql:90,95
//                    CREATE UNIQUE INDEX CONCURRENTLY ...
//
// Postgres refuses CONCURRENTLY inside a transaction block (25001). migrate.js
// rethrows, exits 1, `start` never runs, and the server does not exist. 005 was
// written to be applied BY HAND and says so at its own lines 19-21 — it reached
// the deploy because a `git add -A` swept it in from the untracked working tree.
//
// AND ALL THREE GATES PASSED. The frozen suite, the boot-smoke matrix and the
// vendor-claim check are green on that commit, because none of them runs
// prestart. The one failure that removes the entire product was the one thing
// unguarded. This closes that door.
//
// WHY A STATIC CHECK AND NOT A REAL RUN. Running migrate.js for real would APPLY
// migrations — a deploy gate must never mutate a production schema as a side
// effect of being asked "is this safe?". And every TRACKED file is a candidate:
// migrate.js applies anything absent from schema_migrations, so "not applied
// yet" is not a defence. Needs no database, so it cannot be defeated by pointing
// at the wrong one.
//
//   node tools/check-migration-safety.js
//   exit 0 = every migration can survive being wrapped in a transaction
//   exit 1 = a deploy would crash prestart
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIR = path.join(REPO, 'db', 'migrations');

// Statements PostgreSQL refuses inside a transaction block. Each entry is the
// real reason a deploy would die, phrased so the error names the fix.
const UNSAFE = [
  { re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, why: 'CREATE INDEX CONCURRENTLY cannot run in a transaction (25001)' },
  { re: /\bDROP\s+INDEX\s+CONCURRENTLY\b/i,                 why: 'DROP INDEX CONCURRENTLY cannot run in a transaction (25001)' },
  { re: /\bREINDEX\b[\s\S]{0,40}\bCONCURRENTLY\b/i,          why: 'REINDEX CONCURRENTLY cannot run in a transaction' },
  { re: /^\s*VACUUM\b/im,                                    why: 'VACUUM cannot run in a transaction' },
  { re: /\bCREATE\s+DATABASE\b/i,                            why: 'CREATE DATABASE cannot run in a transaction' },
  { re: /\bDROP\s+DATABASE\b/i,                              why: 'DROP DATABASE cannot run in a transaction' },
  { re: /\bCREATE\s+TABLESPACE\b/i,                          why: 'CREATE TABLESPACE cannot run in a transaction' },
  { re: /\bALTER\s+SYSTEM\b/i,                               why: 'ALTER SYSTEM cannot run in a transaction' },
  // The runner opens its own transaction; a file that also opens one leaves the
  // connection in a state the runner's COMMIT/ROLLBACK will not resolve.
  { re: /^\s*BEGIN\s*;/im,                                   why: 'the file opens its own transaction — migrate.js already wraps it' },
  { re: /^\s*COMMIT\s*;/im,                                  why: 'the file commits — migrate.js already wraps it' },
];

// Comments must not trip the check: 005 DESCRIBES the problem in its header, and
// a checker that fired on the explanation would be crying wolf about prose.
// Kept in step with db/migrate.js — a file may opt out of the runner's
// BEGIN/COMMIT with this directive on its own line. The two regexes must agree
// or a file could opt out of the transaction while this checker still judges it
// by transaction rules, which is the failure mode that took the line down.
const NO_TRANSACTION = /^\s*--\s*@no-transaction\s*$/m;

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/^\s*--.*$/gm, ' ');        // line comments
}

function trackedMigrations() {
  // Only files GIT WILL DEPLOY. An untracked file on someone's disk cannot reach
  // production — and conflating the two is exactly how 005 was misjudged as
  // harmless for weeks while it sat untracked.
  try {
    const out = execSync('git ls-files db/migrations', { cwd: REPO, encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.sql'));
  } catch (_) {
    // Not a git repo (CI checkout, tarball) — fall back to everything on disk,
    // which is the conservative direction.
    if (!fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).map((f) => `db/migrations/${f}`);
  }
}

const files = trackedMigrations();
if (!files.length) {
  console.log('  no tracked migrations — nothing prestart can trip over');
  process.exit(0);
}

let bad = 0;
for (const rel of files) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) continue;          // tracked but deleted in the worktree
  const raw = fs.readFileSync(abs, 'utf8');
  const sql = stripComments(raw);
  const hits = UNSAFE.filter((u) => u.re.test(sql));

  // The directive is read from the RAW text — it is a comment, so stripComments
  // would erase the very thing being looked for.
  const optedOut = NO_TRANSACTION.test(raw);

  if (hits.length && optedOut) {
    // Opting out of the transaction removes the rollback, so the file must be
    // re-runnable or a partial failure is unrecoverable without hand surgery.
    // Enforced here rather than trusted to whoever writes the next migration.
    const statements = (sql.match(/^\s*(CREATE|ALTER|DROP)\b/gim) || []).length;
    const guarded = (sql.match(/\bIF\s+NOT\s+EXISTS\b/gi) || []).length
                  + (sql.match(/\bIF\s+EXISTS\b/gi) || []).length;
    if (guarded < statements) {
      bad++;
      console.log(`  ✗ ${path.basename(rel)}`);
      console.log(`      @no-transaction without idempotency: ${statements} DDL statement(s), only ${guarded} guarded by IF [NOT] EXISTS.`);
      console.log('      Without a transaction there is no rollback, so a half-applied file must be safe to re-run.');
      continue;
    }
    console.log(`  ✓ ${path.basename(rel)} (no transaction, idempotent — ${guarded}/${statements} guarded)`);
    continue;
  }

  if (hits.length) {
    bad++;
    console.log(`  ✗ ${path.basename(rel)}`);
    for (const h of hits) console.log(`      ${h.why}`);
  } else {
    console.log(`  ✓ ${path.basename(rel)}`);
  }
}

if (bad) {
  console.log(`\n  ${bad} migration(s) would CRASH prestart and the server would never boot.`);
  console.log('  db/migrate.js wraps every file in BEGIN/COMMIT, and applies any file');
  console.log('  absent from schema_migrations — so this fires whether or not it has run.');
  console.log('\n  Fix: add "-- @no-transaction" on its own line so the runner skips');
  console.log('  BEGIN/COMMIT, and make every statement IF [NOT] EXISTS so a partial');
  console.log('  failure is safe to re-run. Keeping the file out of git is NOT the fix —');
  console.log('  that is what left the booking column in no tracked migration.\n');
  process.exit(1);
}

console.log(`\n  ${files.length} migration(s) are transaction-safe — prestart will survive this deploy\n`);
process.exit(0);
