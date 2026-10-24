#!/usr/bin/env node
// ─── A SEMICOLON IS NOT ALWAYS A BOUNDARY ───────────────────────────────────
// db/migrate.js sends each migration as ONE client.query(sql), and Postgres
// wraps a multi-statement simple query in an IMPLICIT transaction — so CREATE
// INDEX CONCURRENTLY raises 25001 no matter what the runner does. The
// @no-transaction directive only skipped the runner's own BEGIN/COMMIT and
// could never escape the implicit one.
//
// PROVEN 2026-08-13 against a virgin Postgres 16, the first time this repo had
// ever run its migrations on an empty database:
//
//     ✗ 005_booking_integrity failed: CREATE INDEX CONCURRENTLY cannot run
//       inside a transaction block
//
// 005 had been worked around by hand-applying it and committing it pre-applied
// so the runner would skip it. That covers clinics already migrated and NOT a
// new one — and one deploy + one database per clinic IS the architecture, so
// every new clinic crash-looped on first boot unless somebody remembered a
// manual step. The same false belief put CONCURRENTLY into migration 009 and
// crash-looped production on 2026-08-10.
//
// The fix is to send @no-transaction files one statement at a time, which means
// splitting them correctly. tools/applyMigration.js already split — on every
// `;` — and MEASURED on migration 009, which uses a DO block, that produced:
//
//     [1] DO $$ BEGIN IF NOT EXISTS ( … )
//     [2] END IF                              <- fragment
//     [3] END $$                              <- fragment
//
// Three broken pieces from one statement. This test exists so the next
// migration that uses a dollar-quoted body, a semicolon in a string, or a
// comment is not silently shredded on its way to the database.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { splitStatements } = require('../db/splitStatements');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nSTATEMENT SPLITTER — only a real boundary ends a statement\n');

ok('plain statements split', () => {
  assert.deepStrictEqual(
    splitStatements('SELECT 1; SELECT 2;').map((s) => s.trim()),
    ['SELECT 1', 'SELECT 2']
  );
});

ok('THE 009 CASE: a DO $$ … $$ body survives intact', () => {
  const sql = `
ALTER TABLE t ADD COLUMN c TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x_ck') THEN
    ALTER TABLE t ADD CONSTRAINT x_ck CHECK (c IN ('a','b'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS i ON t (c);`;
  const st = splitStatements(sql);
  assert.strictEqual(st.length, 3, `expected 3 statements, got ${st.length}:\n${st.join('\n---\n')}`);
  assert(/DO \$\$/.test(st[1]) && /END \$\$/.test(st[1]),
    'the DO block was cut apart — the old splitter made three fragments of this');
  assert(/END IF;/.test(st[1]), 'the inner END IF; semicolon was treated as a boundary');
});

ok('a $tag$ … $tag$ body survives too', () => {
  const st = splitStatements(`DO $mig$ BEGIN PERFORM 1; END $mig$;\nSELECT 2;`);
  assert.strictEqual(st.length, 2, `got ${st.length}: ${JSON.stringify(st)}`);
  assert(/PERFORM 1;/.test(st[0]));
});

ok('a semicolon inside a string literal is not a boundary', () => {
  const st = splitStatements(`INSERT INTO t (v) VALUES ('a;b');\nSELECT 1;`);
  assert.strictEqual(st.length, 2, `got ${st.length}: ${JSON.stringify(st)}`);
  assert(/'a;b'/.test(st[0]));
});

ok("an escaped quote ('') does not end the string early", () => {
  const st = splitStatements(`INSERT INTO t (v) VALUES ('it''s; fine');\nSELECT 1;`);
  assert.strictEqual(st.length, 2, `got ${st.length}: ${JSON.stringify(st)}`);
});

ok('a semicolon inside a -- comment is not a boundary', () => {
  const st = splitStatements(`-- a; b; c\nSELECT 1;`);
  assert.strictEqual(st.length, 1, `got ${st.length}: ${JSON.stringify(st)}`);
});

ok('a semicolon inside a /* block */ comment is not a boundary', () => {
  const st = splitStatements(`/* a; b */ SELECT 1;\nSELECT 2;`);
  assert.strictEqual(st.length, 2, `got ${st.length}: ${JSON.stringify(st)}`);
});

ok('a comment-only file yields no statements — an empty query is an error', () => {
  assert.deepStrictEqual(splitStatements('-- just a note\n\n/* and another */\n'), []);
});

ok('$1 placeholders are NOT dollar-quote tags', () => {
  // `$1` must not open a quoted body and swallow the rest of the file.
  const st = splitStatements(`INSERT INTO t (a,b) VALUES ($1,$2);\nSELECT 3;`);
  assert.strictEqual(st.length, 2, `a placeholder was read as a dollar-quote: ${JSON.stringify(st)}`);
});

ok('a quoted "identifier; with a semicolon" is not a boundary', () => {
  const st = splitStatements(`SELECT "od;d" FROM t;\nSELECT 1;`);
  assert.strictEqual(st.length, 2, `got ${st.length}: ${JSON.stringify(st)}`);
});

// ── the real files, which is what actually has to keep working ────────────
ok('every shipped migration splits into runnable statements', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const st = splitStatements(fs.readFileSync(path.join(dir, f), 'utf-8'));
    assert(st.length > 0, `${f} split to nothing`);
    for (const s of st) {
      // A fragment left by a bad split shows up as a statement that begins with
      // a clause keyword no statement can start with.
      assert(!/^\s*(END\s+IF|END\s*\$|ELSE|THEN)\b/i.test(s),
        `${f} produced a fragment, not a statement: ${JSON.stringify(s.slice(0, 60))}`);
    }
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
