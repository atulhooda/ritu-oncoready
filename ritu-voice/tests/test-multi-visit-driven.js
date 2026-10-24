#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A COURSE OF TREATMENT IS NOT ONE APPOINTMENT — DRIVEN AGAINST REAL POSTGRES.
//
// THE BUG. uniq_active_patient_doctor was UNIQUE (clinic, patient, doctor)
// WHERE booked, and bookAppointment resolves collisions with ON CONFLICT DO
// UPDATE SET appointment_time. So booking a SECOND appointment with the SAME
// doctor MOVED the first. The caller is told both dates are held; the database
// holds one. A laser course is six sittings with one dermatologist.
//
// WHY THIS RUNS AGAINST A REAL DATABASE. The bug lives in the interaction
// between an index expression and an ON CONFLICT inference — Postgres either
// matches them or raises 42P10. A mocked pool would assert on the SQL string we
// hoped was right, which is how the fix would silently not work. Every case
// below writes rows, reads them back, and rolls back.
//
// It also covers the case the plan did NOT catch: the idempotent re-read at
// bookAppointment.js took `LIMIT 1` with no day filter, safe only while the old
// index guaranteed one row per patient+doctor. See [4].
//
// Run:            node tests/test-multi-visit-driven.js
// Prove it fails: MUTANT=MUT-CONFLICT-DAYLESS node tests/test-multi-visit-driven.js
//                 MUTANT=MUT-READ-DAYLESS     node tests/test-multi-visit-driven.js
// Skips (does not fail) when no database is reachable.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    // An async callback would hand back a pending Promise and this helper would
    // report a pass without any assertion having run. Two of the checks below
    // were written that way and were silently vacuous until this guard existed.
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve the value before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
const TZ = "AT TIME ZONE 'Asia/Kolkata'";

console.log('\nMULTI-VISIT BOOKING — driven against Postgres\n');

(async () => {
  // A scratch Postgres, never the deploy's DATABASE_URL: the bootstrap pins that
  // to a placeholder so no test can reach the production database by accident
  // (until 2026-09-04 this file ran its temp tables inside the DEMO database's
  // transaction). Without it the gap is DECLARED (exit 75), not a silent pass.
  const url = require('./_bootstrap').needsRealPostgres('multi-visit uniqueness — the day-scoped partial unique index, the ON CONFLICT target and the idempotent re-read, in a real Postgres');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  let c;
  try { c = await pool.connect(); }
  catch (e) { console.error(`\n⏭  NOT RUN — TEST_DATABASE_URL unreachable (${e.message}).\n   NOT COVERED: multi-visit uniqueness in a real Postgres.\n`); await pool.end(); process.exit(75); }

  try {
    // Everything happens inside ONE transaction on temp tables and is rolled
    // back. The production appointments table is never written to, and the
    // production schema is never altered — this test is safe to run anywhere,
    // including against the live database, which is the only Postgres we have.
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE appt (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id uuid NOT NULL, patient_id uuid NOT NULL, doctor_id uuid NOT NULL,
        appointment_time timestamptz NOT NULL, reason text,
        status text NOT NULL DEFAULT 'booked', is_walk_in boolean NOT NULL DEFAULT false,
        reminder_sent boolean NOT NULL DEFAULT false, confirmed boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()) ON COMMIT DROP`);

    // ── The index, verbatim from db/migrations/013_multi_visit.sql ──────────
    const dayless = MUTANT === 'MUT-CONFLICT-DAYLESS';
    if (dayless) {
      console.log('  [MUTANT] MUT-CONFLICT-DAYLESS — the pre-013 index and conflict target\n');
      await c.query(`CREATE UNIQUE INDEX ux ON appt (clinic_id, patient_id, doctor_id) WHERE status='booked'`);
    } else {
      await c.query(`CREATE UNIQUE INDEX ux ON appt
        (clinic_id, patient_id, doctor_id, ((appointment_time ${TZ})::date)) WHERE status='booked'`);
    }

    const C = '11111111-1111-1111-1111-111111111111';
    const P = '22222222-2222-2222-2222-222222222222';
    const Q = '44444444-4444-4444-4444-444444444444';
    const D = '33333333-3333-3333-3333-333333333333';

    const target = dayless
      ? `(clinic_id, patient_id, doctor_id)`
      : `(clinic_id, patient_id, doctor_id, ((appointment_time ${TZ})::date))`;

    // The production upsert, shape-for-shape (tools/bookAppointment.js).
    const book = (patient, iso, reason) => c.query(`
      WITH prev AS (
        SELECT appointment_time FROM appt
         WHERE clinic_id=$1 AND patient_id=$2 AND doctor_id=$3 AND status='booked'
           ${dayless ? '' : `AND (appointment_time ${TZ})::date = (($4::timestamptz) ${TZ})::date`}
         LIMIT 1
      )
      INSERT INTO appt (clinic_id, patient_id, doctor_id, appointment_time, reason)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT ${target} WHERE status='booked'
      DO UPDATE SET appointment_time = EXCLUDED.appointment_time,
                    reason = EXCLUDED.reason, reminder_sent = FALSE,
                    confirmed = FALSE, updated_at = NOW()
        WHERE appt.appointment_time IS DISTINCT FROM EXCLUDED.appointment_time
      RETURNING id, appointment_time, (xmax = 0) AS inserted,
                (SELECT appointment_time FROM prev) AS moved_from`,
      [C, patient, D, iso, reason]);

    const istDates = async () => (await c.query(
      `SELECT ((appointment_time ${TZ})::date)::text d FROM appt WHERE patient_id=$1 ORDER BY appointment_time`, [P]
    )).rows.map(r => r.d);

    // ── [1] THE COURSE. Six laser sittings, one dermatologist. ─────────────
    const S1 = '2026-09-03T11:00:00+05:30';   // Thu
    const S2 = '2026-09-10T11:00:00+05:30';   // Thu +1wk
    const S3 = '2026-09-17T11:00:00+05:30';   // Thu +2wk
    const r1 = await book(P, S1, 'laser sitting 1');
    const r2 = await book(P, S2, 'laser sitting 2');
    const r3 = await book(P, S3, 'laser sitting 3');

    const dates = await istDates();
    ok('three sittings on three days produce THREE rows', () => {
      assert.strictEqual(dates.length, 3, `got ${dates.length} row(s): ${dates.join(', ')} — the earlier sitting was overwritten`);
      assert.deepStrictEqual(dates, ['2026-09-03', '2026-09-10', '2026-09-17']);
    });
    ok('each sitting is its own row (distinct ids)', () => {
      const ids = new Set([r1.rows[0].id, r2.rows[0].id, r3.rows[0].id]);
      assert.strictEqual(ids.size, 3, 'two sittings share a row id — one overwrote another');
    });
    ok('booking sitting 2 does not report having MOVED sitting 1', () => {
      assert.strictEqual(r2.rows[0].moved_from, null,
        `moved_from=${r2.rows[0].moved_from} — the caller would be told a different day was rescheduled`);
    });
    ok('sitting 1 still holds its original time after 2 and 3 are booked', () => {
      assert.ok(dates.includes('2026-09-03'), 'sitting 1 is gone');
    });

    // ── [2] THE MID-CALL CORRECTION still works: same day, new time = MOVE ──
    const r2b = await book(P, '2026-09-10T16:00:00+05:30', 'laser sitting 2, moved');
    ok('same day, different time → the row MOVES (the correction path is intact)', () => {
      assert.strictEqual(r2b.rows[0].id, r2.rows[0].id, 'a same-day change created a second row');
      assert.strictEqual(r2b.rows[0].inserted, false, 'a same-day change inserted instead of updating');
    });
    ok('the move reports what it moved FROM, on the same day', () => {
      const from = r2b.rows[0].moved_from;
      assert.ok(from, 'moved_from is null on a real move');
      assert.match(new Date(from).toISOString(), /2026-09-10T05:30/, `moved_from=${from} is not sitting 2's own day`);
    });
    const after = await istDates();
    ok('after the correction there are still exactly three sittings', () => {
      assert.strictEqual(after.length, 3, `${after.length} rows: ${after.join(', ')}`);
    });

    // ── [3] A DIFFERENT PATIENT is untouched by any of it ───────────────────
    await book(Q, S1, 'someone else, same slot');
    const otherN = (await c.query(`SELECT count(*)::int n FROM appt WHERE patient_id=$1`, [Q])).rows[0].n;
    ok('another patient booking the same day is a separate row', () => {
      assert.strictEqual(otherN, 1);
    });

    // ── [4] THE CASE THE PLAN MISSED — the idempotent re-read. ─────────────
    // When the upsert's WHERE filters the update out (same day AND same time),
    // production returns zero rows and RE-READS the existing booking to confirm
    // it aloud. That read had no day filter: with a course on file it can return
    // any sitting, and Ritu would confirm the wrong date.
    // The mutant drops the day filter AND its parameter, so the query still
    // binds cleanly and fails on the ASSERTION — a mutant that dies on a SQL
    // error proves the statement was malformed, not that the check works.
    const readDayless = MUTANT === 'MUT-READ-DAYLESS';
    const readBack = (iso) => c.query(
      `SELECT id, appointment_time FROM appt
        WHERE clinic_id=$1 AND patient_id=$2 AND doctor_id=$3 AND status='booked'
          ${readDayless ? '' : `AND (appointment_time ${TZ})::date = (($4::timestamptz) ${TZ})::date`}
        ORDER BY appointment_time
        LIMIT 1`, readDayless ? [C, P, D] : [C, P, D, iso]);
    if (MUTANT === 'MUT-READ-DAYLESS') console.log('  [MUTANT] MUT-READ-DAYLESS — the re-read loses its day filter\n');

    const again = await book(P, S3, 'laser sitting 3');   // same day, same time → 0 rows
    ok('re-booking the identical slot updates nothing (the idempotent path fires)', () => {
      assert.strictEqual(again.rows.length, 0, 'the upsert wrote when it should have been a no-op');
    });
    const rb = await readBack(S3);
    ok('the idempotent re-read returns THE SITTING THAT WAS ASKED FOR', () => {
      assert.strictEqual(rb.rows.length, 1, 'the re-read found nothing');
      const got = new Date(rb.rows[0].appointment_time).toISOString();
      const want = new Date(S3).toISOString();
      assert.strictEqual(got, want,
        `re-read returned ${got} but the caller asked for ${want} — Ritu would confirm the wrong sitting aloud`);
    });
    ok('the re-read returns sitting 3\'s row id, not an arbitrary sitting', () => {
      assert.strictEqual(rb.rows[0].id, r3.rows[0].id);
    });

    // ── [5] The literal time zone is duplicated exactly once, and agrees ────
    ok('the migration and the booking code use the SAME time-zone literal', () => {
      const fs = require('fs');
      const mig = fs.readFileSync('db/migrations/013_multi_visit.sql', 'utf8');
      const code = fs.readFileSync('tools/bookAppointment.js', 'utf8');
      const zones = (t) => [...t.matchAll(/AT TIME ZONE '([^']+)'/g)].map(m => m[1]);
      const mz = new Set(zones(mig)), cz = new Set(zones(code));
      assert.strictEqual(mz.size, 1, `the migration names ${mz.size} zones: ${[...mz]}`);
      assert.ok(cz.size >= 1, 'the booking code names no time zone — the day scoping is gone');
      assert.deepStrictEqual([...cz], [...mz],
        `index uses ${[...mz]} but bookAppointment uses ${[...cz]} — Postgres cannot infer the index`);
    });

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    fail++; console.log(`  ✗ threw — ${e.message}`);
  } finally { c.release(); await pool.end(); }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
})();
