#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE OFFER SIDE MUST KNOW WHICH SLOTS ARE ALREADY GONE.
//
// Live 2026-08-09 07:42Z, call 4843c8bc — Dr. Manoj Deo, Monday 17:00:
//   RITU     "वो कल शाम 5:00 बजे उपलब्ध हैं। ... बुक करूँ?"
//   PATIENT  "कर दो।"
//   RITU     "उस समय उपलब्ध नहीं। कोई और समय बताइए?"
//   PATIENT  "क्या कल शाम पाँच बजे आपने तो कहा है।"
//   RITU     "माफ़ कीजिए, मेरी ही गलती थी."
//   ... then the SAME canned refusal twice more before she named the window.
//
// That Monday 17:00 had been booked two days earlier. The roster told the model
// the doctor's HOURS and nothing about which slots were taken, so the offer
// side proposed a time the accept side was always going to refuse.
//
// The accept side's definition of "taken" is a partial unique index:
//   uniq_doctor_slot UNIQUE (doctor_id, appointment_time)
//                    WHERE status = 'booked' AND NOT is_walk_in
// Any OTHER definition on the offer side recreates the same disagreement in a
// new place, so [3] pins ours to that index as the database actually reports it.
//
// Run: node tests/test-taken-slots.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha, skipUnlessSupported } = require('../tools/testHelpers/setupDb');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A future instant on a given IST weekday, at an IST wall-clock time.
function futureIst(dow, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    // IST weekday of that instant
    const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(d);
    if (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow] !== wd) continue;
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
    return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
  }
  throw new Error('no such weekday in 14 days');
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  skipUnlessSupported(pool, 'cteInsert', 'taken-slot reporting — needs a real Postgres for the partial unique index and uuid = ANY()');
  const docs = await seedSaiShradha(pool, clinicId);

  // db.js opens its OWN pool from config.databaseUrl AT REQUIRE TIME, and the
  // repo root .env holds the LIVE clinic database. The first version of this
  // file required db.js without this line, so getTakenSlots ran its query
  // against PRODUCTION and reported the test doctor's slot free — the test was
  // green-adjacent for entirely the wrong reason. Point it at a dead socket,
  // then route its queries through the throwaway pool, exactly as
  // tests/test-db-schema-port.js does.
  process.env.CLINIC_ID_UUID = clinicId;
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
  const db = require('../db');
  db.pool.query = (...args) => pool.query(...args);

  const doc = docs['Dr. Priyanka Bhosale'];

  // TWO patients: uniq_active_patient_doctor allows a patient only ONE live
  // appointment per doctor, so the walk-in case below needs its own.
  const { rows: [pt] } = await pool.query(
    `INSERT INTO patients (clinic_id, name, phone) VALUES ($1,'Taken Test','9000000001') RETURNING id`, [clinicId]);
  const { rows: [pt2] } = await pool.query(
    `INSERT INTO patients (clinic_id, name, phone) VALUES ($1,'Walkin Test','9000000002') RETURNING id`, [clinicId]);

  const MON_1530 = futureIst(1, '15:30');
  const TUE_1530 = futureIst(2, '15:30');

  console.log('\n[1] a booked slot is reported as taken');
  {
    await pool.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, status, is_walk_in)
       VALUES ($1,$2,$3,$4,'booked',FALSE)`, [clinicId, pt.id, doc.id, MON_1530.toISOString()]);
    const taken = await db.getTakenSlots([doc.id]);
    const mine = taken[doc.id] || [];
    assert('the booked slot comes back', mine.length === 1, JSON.stringify(mine));
    assert('labelled with weekday, date AND time (an 8-day horizon repeats weekdays)',
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2} \w{3} \d{2}:\d{2}$/.test((mine[0] || {}).label || ''),
      `got ${JSON.stringify(mine[0])} — a bare weekday cannot say WHICH Monday`);
    assert('rendered in clinic time, not UTC', /15:30$/.test((mine[0] || {}).label || ''),
      `got ${JSON.stringify(mine[0])} — 15:30 IST must not surface as 10:00 UTC`);
    // The key is what brain-lean's slot walker compares. It must describe the
    // SAME instant as the label, in a form that sorts and matches by date.
    assert('carries a comparable clinic-local key',
      /^\d{4}-\d{2}-\d{2} 15:30$/.test((mine[0] || {}).key || ''),
      `got ${JSON.stringify(mine[0])} — firstFreeSlot matches on this`);
  }

  // ─── [2] THE STATUSES THAT FREE A SLOT ──────────────────────────────────────
  console.log('\n[2] only rows the accept side would collide with count as taken');
  {
    const cases = [
      ['cancelled', false, 'a cancelled appointment frees the slot'],
      ['no_show',   false, 'a no-show frees the slot'],
      ['completed', false, 'a completed appointment frees the slot'],
      ['booked',    true,  'a live booking holds the slot'],
    ];
    for (const [status, shouldHold, label] of cases) {
      await pool.query(`UPDATE appointments SET status=$1 WHERE doctor_id=$2 AND appointment_time=$3`,
        [status, doc.id, MON_1530.toISOString()]);
      const taken = await db.getTakenSlots([doc.id]);
      const held = (taken[doc.id] || []).length > 0;
      assert(label, held === shouldHold, `status=${status} reported ${held ? 'TAKEN' : 'free'}`);
    }
    await pool.query(`UPDATE appointments SET status='booked' WHERE doctor_id=$1 AND appointment_time=$2`,
      [doc.id, MON_1530.toISOString()]);
  }

  console.log('\n[3] a walk-in booking does NOT hide capacity');
  {
    await pool.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, status, is_walk_in)
       VALUES ($1,$2,$3,$4,'booked',TRUE)`, [clinicId, pt2.id, doc.id, TUE_1530.toISOString()]);
    const taken = await db.getTakenSlots([doc.id]);
    const labels = taken[doc.id] || [];
    assert('walk-in slot is not reported taken', !labels.some(l => /Tue/.test(l.label)),
      `got ${JSON.stringify(labels)} — uniq_doctor_slot exempts walk-ins, so the slot is still bookable`);
  }

  // ─── [4] OUR DEFINITION == THE INDEX'S DEFINITION ───────────────────────────
  // Read out of the live catalog rather than a comment, so a migration that
  // changes the constraint fails here instead of drifting silently.
  console.log('\n[4] the offer side uses the accept side\'s own predicate');
  {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_doctor_slot'`);
    if (!rows.length) {
      console.log('  — uniq_doctor_slot not present in this schema, skipping');
    } else {
      const def = rows[0].indexdef;
      assert('uniq_doctor_slot still keys on (doctor_id, appointment_time)',
        /\(doctor_id,\s*appointment_time\)/.test(def), def);
      assert("...still filtered to status = 'booked'", /status\s*=\s*'booked'/.test(def), def);
      assert('...still exempts walk-ins', /NOT\s+is_walk_in/i.test(def), def);
    }
  }

  console.log('\n[5] the prompt line actually carries it');
  {
    const lean = require('../brain-lean');
    lean._setRosterForTest({ text: '', doctors: [{
      id: doc.id, name: 'Dr. Priyanka Bhosale', specialty: 'Gynecologist', fee_inr: 600,
      schedule: 'Mon,Tue,Wed,Thu,Fri 15:00-16:00',
      windows: [{ dow: 1, start: '15:00', end: '15:30' }],
      taken: [{ key: '2026-08-18 15:30', label: 'Mon 18 Aug 15:30' }],
    }] });
    const line = lean.doctorLine(lean._roster().doctors[0]);
    assert('doctorLine names the taken slot', /Mon 18 Aug 15:30/.test(line), line);
    assert('...and marks it as not offerable', /mat offer/.test(line), line);

    // The whole point is that it survives into the text the model reads.
    const sliced = lean.sliceRoster([], {});
    assert('it survives sliceRoster into the prompt', /Mon 18 Aug 15:30/.test(sliced.text), sliced.text);

    // A doctor with nothing booked must not pay for this feature.
    lean._setRosterForTest({ text: '', doctors: [{
      id: doc.id, name: 'Dr. Free', specialty: 'X', fee_inr: 1,
      schedule: 'Mon 15:00-16:00', windows: [{ dow: 1, start: '15:00', end: '16:00' }], taken: [],
    }] });
    assert('a doctor with no bookings costs zero extra characters',
      !/mat offer|GAYA/.test(lean.doctorLine(lean._roster().doctors[0])));
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  await pool.end();
  if (fail) { console.log('✗ FAILURES'); process.exit(1); }
  console.log('✓ Ritu no longer offers slots that are already gone.');
  process.exit(0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
