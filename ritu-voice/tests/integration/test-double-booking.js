// ═══════════════════════════════════════════════════════════════════════════
// DOUBLE BOOKING — the test that should have existed before the founder found
// this by hand.
//
// WHY IT LIVES HERE AND NOT IN tests/. Everything in tests/ runs on pg-mem, an
// in-memory Postgres EMULATOR, and pg-mem cannot parse the query the booking
// tool actually runs:
//
//     ON CONFLICT (clinic_id, patient_id, doctor_id) WHERE status='booked'
//     RETURNING (xmax = 0) AS inserted
//
// Partial-index inference and the xmax system column are exactly the Postgres
// features the booking-integrity design depends on, and exactly the features an
// emulator gets wrong. So the design has never been executed by a test — not
// once — while four pre-push gates reported green.
//
// A test that cannot run the production statement is not evidence. This file
// requires a REAL Postgres and says so loudly when it does not have one.
//
//   TEST_DATABASE_URL=postgres://... node tests/integration/test-double-booking.js
//
// Getting one, in order of least friction:
//   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test --name ritu-test postgres:16
//   export TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres
//
// NEVER point this at production. It creates and drops a schema.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('../_bootstrap');   // production switches first — see tests/_bootstrap.js
const { Client } = require('pg');

const URL = process.env.TEST_DATABASE_URL;

// ─── THE LOUD SKIP ───────────────────────────────────────────────────────────
// A silent skip is how the old booking suite rotted for ten weeks while looking
// fine. Exit code 3 is neither pass (0) nor fail (1), so a gate can tell the
// difference between "verified" and "not checked" instead of treating them as
// the same green tick.
if (!URL) {
  console.error('\n' + '='.repeat(72));
  console.error('  NOT RUN — no TEST_DATABASE_URL.');
  console.error('  Booking integrity is therefore UNVERIFIED by this run.');
  console.error('');
  console.error('    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test \\');
  console.error('      --name ritu-test postgres:16');
  console.error('    export TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres');
  console.error('='.repeat(72) + '\n');
  process.exit(3);
}

if (/railway|proxy\.rlwy|amazonaws|\.com\//.test(URL) && !process.env.I_KNOW_THIS_IS_A_TEST_DB) {
  console.error('REFUSING: TEST_DATABASE_URL looks like a hosted/production database.');
  console.error('This file CREATES AND DROPS a schema. Set I_KNOW_THIS_IS_A_TEST_DB=1 to override.');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`); fail++; }
};

const SCHEMA = 'ritu_booking_test';

async function main() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await c.query(`CREATE SCHEMA ${SCHEMA}`);
  await c.query(`SET search_path TO ${SCHEMA}`);

  // Minimal shape — only what the constraint story needs. Deliberately NOT the
  // full production schema: this file is about one invariant, and a smaller
  // fixture is a smaller lie.
  await c.query(`
    CREATE TABLE doctors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slot_minutes int              -- NULL until the slot grid ships
    );
    CREATE TABLE appointments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id uuid NOT NULL,
      patient_id uuid NOT NULL,
      doctor_id uuid NOT NULL REFERENCES doctors(id),
      appointment_time timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'booked',
      is_walk_in boolean NOT NULL DEFAULT false
    );
    -- The two indexes from 005_booking_integrity, verbatim in intent.
    CREATE UNIQUE INDEX uniq_doctor_slot ON appointments (doctor_id, appointment_time)
      WHERE status = 'booked' AND NOT is_walk_in;
    CREATE UNIQUE INDEX uniq_active_patient_doctor ON appointments (clinic_id, patient_id, doctor_id)
      WHERE status = 'booked';
  `);

  const CLINIC = '11111111-1111-1111-1111-111111111111';
  const { rows: [doc] } = await c.query(`INSERT INTO doctors (name) VALUES ('Dr Test') RETURNING id`);
  const P1 = '22222222-2222-2222-2222-222222222221';
  const P2 = '22222222-2222-2222-2222-222222222222';

  const book = async (patient, iso, walkIn = false) => {
    try {
      const { rows } = await c.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, status, is_walk_in)
         VALUES ($1,$2,$3,$4,'booked',$5)
         ON CONFLICT (clinic_id, patient_id, doctor_id) WHERE status = 'booked'
         DO UPDATE SET appointment_time = EXCLUDED.appointment_time
         RETURNING id, appointment_time, (xmax = 0) AS inserted`,
        [CLINIC, patient, doc.id, iso, walkIn]);
      return { ok: true, row: rows[0] };
    } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
  };

  const T5_00 = '2026-12-01T17:00:00+05:30';
  const T5_05 = '2026-12-01T17:05:00+05:30';
  const T5_10 = '2026-12-01T17:10:00+05:30';

  console.log('\nDOUBLE BOOKING — real Postgres, production statement\n');

  // ── the statement itself, which pg-mem cannot run ─────────────────────────
  const first = await book(P1, T5_00);
  ok('the production ON CONFLICT ... WHERE + xmax statement EXECUTES',
    first.ok, first.ok ? '' : `${first.code}: ${first.msg}`);
  ok('first booking inserts', first.ok && first.row.inserted === true);

  // ── the invariant that already holds ──────────────────────────────────────
  const sameSlot = await book(P2, T5_00);
  ok('a SECOND patient on the IDENTICAL slot is refused',
    !sameSlot.ok && sameSlot.code === '23505',
    sameSlot.ok ? 'it was ACCEPTED — uniq_doctor_slot is not doing its job' : '');

  // ── THE BUG THE FOUNDER FOUND ─────────────────────────────────────────────
  // 5:05 is a different timestamp, so the unique index is satisfied. With a
  // 10-minute consultation the doctor now has two patients overlapping. This
  // assertion is EXPECTED TO FAIL until the slot grid ships — it is the
  // specification of the work, not a passing test.
  const overlap = await book(P2, T5_05);
  ok('a second patient 5 MINUTES later is refused (10-min slot)',
    !overlap.ok,
    overlap.ok
      ? 'ACCEPTED — this is the reported bug: appointment_time is a point, not an interval, so 17:00 and 17:05 both fit'
      : '');

  // ── properties any fix must preserve ──────────────────────────────────────
  await c.query(`DELETE FROM appointments WHERE patient_id = $1`, [P2]);
  const moved = await book(P1, T5_10);
  ok('MOVE semantics survive — re-booking the same patient+doctor updates, not inserts',
    moved.ok && moved.row.inserted === false,
    moved.ok ? `inserted=${moved.row.inserted}` : `${moved.code}`);

  const { rows: cnt } = await c.query(
    `SELECT count(*)::int AS n FROM appointments WHERE patient_id = $1 AND status='booked'`, [P1]);
  ok('and leave exactly ONE active row for that patient+doctor', cnt[0].n === 1, `got ${cnt[0].n}`);

  await c.query(`UPDATE doctors SET name='Dr WalkIn' WHERE id=$1`, [doc.id]);
  const w1 = await book(P2, T5_10, true);
  ok('walk-in doctors stay EXEMPT — overlap is intended clinic behaviour there',
    w1.ok, w1.ok ? '' : `${w1.code}: ${w1.msg}`);

  await c.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await c.end();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  A failure on "a second patient 5 MINUTES later is refused" is EXPECTED');
    console.log('  until the slot grid ships. That assertion IS the specification.\n');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
