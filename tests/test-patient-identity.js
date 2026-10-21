#!/usr/bin/env node
// ─── ONE CALLER, ONE HANDSET, THREE PATIENTS ────────────────────────────────
// LIVE CALL 5b261b844e65a68bbe1aeb5512a11a8e, 2026-08-14, Bengali. One human,
// one phone (9749563568), three rows in the `patients` table in 2m19s:
//
//     07:58:15  3402e8d6  "Aman Nambaria"
//     07:59:00  6d7fdcba  "আমন নাম্বারিয়া"      <- the same name, Bengali script
//     08:00:34  be74f240  "[Patient Name]"     <- a literal prompt placeholder
//
// `patients` is UNIQUE (clinic_id, phone, name), so every new rendering of a
// name mints a new human. MEASURED across all rows on 2026-08-14:
//
//     handsets with >1 patient row .............. 10 of 28
//     rows minted <10min apart on one handset ... 16   (one human, one call)
//     placeholder strings that became patients .. 15
//     worst single human ........................ 8 rows
//
// WHAT IT COSTS. The appointment committed against the FIRST row. When the
// caller then asked to confirm it, bookAppointment's idempotency check ran
// against a DRIFTED patient_id, found nothing, and the insert collided with
// uniq_doctor_slot (doctor_id, appointment_time) — the slot was taken BY HIM.
// The tool returned success:false, and brain-lean.js:889 spoke
// cannedLine('slotNoAlt'): "ওই সময়ে পাওয়া যাবে না" — that time is not
// available. A true statement about the database and a false one about the
// world.
//
// This is the SAME root cause as the household medication prior (79f2677), the
// wrong-name greeting (21e6cc1) and cancel ambiguity (556b9b4). Four bugs, one
// cause, never named until docs/ROADMAP.md.
//
// RUNS AGAINST REAL POSTGRES. UNIQUE constraints and ON CONFLICT are the whole
// subject here, and pg-mem does not enforce them the same way — a green run on
// a double would be worth nothing.
//
//     docker run -d --name ritu-test-pg -e POSTGRES_PASSWORD=test \
//       -e POSTGRES_DB=ritu_test -p 55432:5432 postgres:16-alpine
//     DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ritu_test node db/migrate.js
//     TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ritu_test \
//       node tests/test-patient-identity.js
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const crypto = require('crypto');

const URL = process.env.TEST_DATABASE_URL;
if (!URL) {
  console.log('\n⏭  SKIP — needs a real Postgres (TEST_DATABASE_URL).');
  console.log('   NOT COVERED: patient identity, the root cause in docs/ROADMAP.md §1.');
  console.log('   UNIQUE (clinic_id, phone, name) and ON CONFLICT are the subject; a');
  console.log('   test double that does not enforce them would pass while proving nothing.');
  process.exit(0);
}
// This helper CREATEs and DROPs schemas. It must never see a clinic database.
if (/railway|rlwy\.net|amazonaws|supabase|neon\.tech/i.test(URL)) {
  console.error('✗ TEST_DATABASE_URL looks like a managed/production host. Refusing.');
  process.exit(1);
}

// db.js reads config.databaseUrl at require time, so this must precede it.
process.env.DATABASE_URL = URL;
process.env.CLINIC_MODE = 'lean';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nPATIENT IDENTITY — one human on one handset is one row\n');

(async () => {
  const { Pool } = require('pg');
  const schema = `ident_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: URL });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const { splitStatements } = require('../db/splitStatements');
  const fs = require('fs'), path = require('path');
// SEARCH_PATH ON THE CONNECTION, NOT IN A HANDLER. This was
//     pool.on('connect', (c) => c.query(`SET search_path TO ${schema}`))
// which fires a query on a client the pool may already be using — pg warns
// "client.query() when the client is already executing a query" — and under the
// parallel test runner it lost the race: statements landed outside the schema
// and the run died with `relation "t" does not exist`. It passed every time the
// file was run alone, which is the worst way for a harness to be wrong.
// `options` is sent at connection setup, before any query can be issued.
  const setup = new Pool({ connectionString: URL, options: `-c search_path=${schema},public` });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
// CANONICAL MIGRATIONS ONLY, and tolerate one vanishing mid-read.
// tests/test-migration-no-transaction.js writes a scratch file into the REAL
// db/migrations/ directory — it has to, because it tests the checker that scans
// that directory — and deletes it again. Under the parallel runner that raced
// with every other test enumerating the same folder, which surfaced as
// `ENOENT: 999_test_tmp.sql` or `relation "t" does not exist` on whichever test
// happened to read at the wrong moment. Intermittent, and never when the file
// was run alone.
//   · NNN must be 0-prefixed: the scratch file is deliberately 999_.
//   · readFileSync is guarded: readdir and read are not one atomic act.
  for (const f of fs.readdirSync(dir).filter((x) => /^0\d\d_.*\.sql$/.test(x)).sort()) {
    let sql;
    try { sql = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (_) { continue; }
    for (const st of splitStatements(sql.replace(/^\s*DROP TABLE[^;]*;\s*$/gm, ''))) {
      await setup.query(st);
    }
  }
  const { rows: [clinic] } = await setup.query(
    `INSERT INTO clinics (name, timezone) VALUES ('Smile Dental', 'Asia/Kolkata') RETURNING id`);
  process.env.CLINIC_ID_UUID = clinic.id;

  const db = require('../db.js');
  // Point db.js's own pool at our schema, so its real SQL runs against the real
  // constraints. Replacing an exported function would test nothing — db.js's
  // functions close over the module-scope pool.
  // db.js built its pool at require time, so its connections are already
  // configured. Re-point them the same way: set the option and drop the idle
  // clients so the next checkout reconnects with it.
  db.pool.options.options = `-c search_path=${schema},public`;
  await db.pool.query('SELECT 1');

  const PHONE = '9749563568';
  const countRows = async () => {
    const { rows } = await db.pool.query(
      `SELECT id, name FROM patients WHERE clinic_id = $1 ORDER BY created_at`, [clinic.id]);
    return rows;
  };
  const reset = () => db.pool.query(`DELETE FROM patients WHERE clinic_id = $1`, [clinic.id]);

  // ── 1. THE LIVE SEQUENCE, exactly as it happened ─────────────────────────
  await ok('THE LIVE CALL: three renderings of one name make ONE row', async () => {
    await reset();
    const ids = [];
    for (const n of ['Aman Nambaria', 'আমন নাম্বারিয়া', '[Patient Name]']) {
      ids.push(await db.upsertPatient(PHONE, n));
    }
    const rows = await countRows();
    assert.strictEqual(rows.length, 1,
      `one caller, one handset, one call — got ${rows.length} patients: ${rows.map((r) => JSON.stringify(r.name)).join(', ')}`);
    assert.strictEqual(new Set(ids).size, 1,
      'the three upserts returned different patient ids — every downstream lookup keyed on patient_id now depends on which one it got');
  });

  // ── 2. the placeholder must never become a person at all ─────────────────
  await ok('a prompt placeholder is never written as a name', async () => {
    await reset();
    await db.upsertPatient(PHONE, '[Patient Name]');
    const rows = await countRows();
    assert.strictEqual(rows.length, 1, 'expected exactly one row');
    assert(!/[[\]<>{}]/.test(rows[0].name),
      `a template placeholder reached the patient record: ${JSON.stringify(rows[0].name)}`);
  });

  await ok('other placeholder shapes are caught too', async () => {
    const { cleanPersonName } = require('../nameGuard');
    for (const junk of ['[Patient Name]', '[patient name]', '<name>', '{{name}}', '{name}', '[naam]']) {
      assert.strictEqual(cleanPersonName(junk), null,
        `${JSON.stringify(junk)} passed the name guard and would be stored as a human`);
    }
  });

  // ── 3. a REAL name must still land, and still be able to correct itself ──
  await ok('a real name is stored, and replaces a placeholder row', async () => {
    await reset();
    await db.upsertPatient(PHONE, '[Patient Name]');   // nothing usable yet
    await db.upsertPatient(PHONE, 'Aman Nambaria');    // now we know
    const rows = await countRows();
    assert.strictEqual(rows.length, 1, `expected one row, got ${rows.length}`);
    assert.strictEqual(rows[0].name, 'Aman Nambaria',
      `the real name did not take: ${JSON.stringify(rows[0].name)}`);
  });

  await ok('the same name in two scripts is one person', async () => {
    await reset();
    const a = await db.upsertPatient(PHONE, 'Siddharth');
    const b = await db.upsertPatient(PHONE, 'सिद्धार्थ');
    assert.strictEqual(a, b,
      'the Latin and Devanagari renderings of one caller produced two patient ids');
    assert.strictEqual((await countRows()).length, 1);
  });

  // ── 4. and it must NOT over-merge — two real people keep two rows ────────
  await ok('two genuinely different names on one handset stay two people', async () => {
    // The household case is real and must survive: a shared phone is normal in
    // an Indian clinic. Collapsing everyone onto one row would trade a
    // splintering bug for a records-mixing bug, which is worse.
    await reset();
    const a = await db.upsertPatient(PHONE, 'Aman Nambaria');
    const b = await db.upsertPatient(PHONE, 'Priya Sharma');
    assert.notStrictEqual(a, b, 'two different people were merged into one record');
    assert.strictEqual((await countRows()).length, 2);
  });

  await ok('a different handset is always a different person', async () => {
    await reset();
    const a = await db.upsertPatient(PHONE, 'Aman Nambaria');
    const b = await db.upsertPatient('9876543210', 'Aman Nambaria');
    assert.notStrictEqual(a, b, 'the same name on two handsets was merged');
  });

  // ── 5. the harm, closed ─────────────────────────────────────────────────
  await ok('THE HARM: re-confirming does not collide with your own booking', async () => {
    // The exact production sequence: book under one rendering of the name, then
    // ask to confirm after the name has been heard differently. With one row,
    // bookAppointment's idempotency check finds the caller's own appointment
    // instead of colliding with uniq_doctor_slot.
    await reset();
    const first = await db.upsertPatient(PHONE, 'Aman Nambaria');
    const later = await db.upsertPatient(PHONE, 'আমন নাম্বারিয়া');
    assert.strictEqual(first, later,
      'the id drifted between booking and confirmation — this is exactly what made ' +
      'the tool report a slot the caller already held as "not available"');
  });

  await db.pool.end().catch(() => {});
  await setup.end().catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
