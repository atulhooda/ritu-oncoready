#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEMA⇄QUERY CONTRACT, PROVED BY RUNNING db.js — NOT BY RETYPING IT
//
// This file claims to validate "that the new schema supports every query the
// app makes". Until 2026-08-13 it never loaded db.js. It opened a pg-mem pool
// and typed its OWN copy of the SQL next to it, so what it actually proved was
// that the copy in this file agreed with the schema in this file. An
// adversarial audit changed db.js and watched all 11 ticks stay green.
//
// The copy had already drifted, which is the whole argument against copies:
//
//   · it carried `ORDER BY created_at DESC LIMIT 1` on getReturningPatientName.
//     Production DELETED that LIMIT (see db.js:73 and tests/test-phone-identity.js)
//     because Prithvi's handset holds, newest first:
//         ಅಪರಿಚಿತ | pruthvi | gawda | prithvi | . | unknown
//     Kannada for "unknown" is the newest row, so the single row the query
//     returned cleaned to null and a patient with four recorded visits was
//     greeted as a stranger. This file was still asserting the shape of the bug.
//   · its calls INSERT listed 8 columns. db.js writes 14 — appointment_id,
//     transcript, language, reason, not_booked_reason, diagnostics were absent,
//     so migrations 002 and 008 were outside "every query" entirely.
//   · its conversation upsert omitted `language` (migration 004) and the
//     COALESCE that stops a null clobbering a stored one.
//   · `assert('markCallWhatsAppSent updates', true)` — a literal. The function
//     was never called; nothing read the column back.
//
// SO: require db.js and swap `db.pool.query` for a forwarder into the harness
// pool. Every function then runs ITS OWN SQL against the migrated schema, and
// the column names, the aliases, the ON CONFLICT targets, the INTERVAL windows
// and the JS that shapes the result are all under test. Replacing an exported
// FUNCTION would prove nothing — db.js's callers hold the module object, but
// db.js's own functions close over the module-scope `pool` const, and
// `db.pool.query = …` mutates the very object that const points at. It is the
// only interception point that leaves the real query text in play.
//
// WHY THIS MATTERS MORE HERE THAN ALMOST ANYWHERE: every reader in db.js
// swallows its own error (`console.error(...); return []`). A query that no
// longer matches the schema does not throw, does not 500, does not page — it
// returns an empty list, and the clinic simply stops getting reminders. The
// silence is the defect. So this file taps console.error and FAILS any section
// in which db.js swallowed something. That tap is what makes a broken column
// name visible at all.
//
// WHAT IS ASSERTED vs WHAT IS BUILT: the seed rows below are built by this file
// (appointments are written by tools/bookAppointment.js, not db.js, so they
// have to be). Nothing asserts on them directly. Every assertion is on what
// db.js SELECTED, how it mapped it, or on table state read back after a db.js
// writer ran. Test-built data is the fixture; db.js's choices are the subject.
//
// NOTHING HERE IS FIRE-AND-FORGET. Unlike crm.logCall (which endCall does not
// await, so a test that asserts immediately reports a write still in flight as
// a missing write), every db.js function used below returns a promise that is
// awaited. The one exception is db.js's own initDb() connectivity probe, which
// fires at require time and lands whenever it lands — its console.error is
// filtered by name below rather than left to fail a random section.
//
// RUN IT
//   node tests/test-db-schema-port.js
//       → pg-mem, migration 001 only. Sections 1-4 run (2 partially, it cannot
//         do `uuid = ANY`); 5-9 print a NOT COVERED block naming exactly what
//         went untested. 41 assertions.
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ritu_test \
//     node tests/test-db-schema-port.js
//       → real Postgres, EVERY migration. All nine sections, 94 assertions,
//         nothing skipped. This is the run that answers the file's title.
//         docker run -d --name ritu-test-pg -e POSTGRES_PASSWORD=test \
//           -e POSTGRES_DB=ritu_test -p 55432:5432 postgres:16-alpine
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('drives config.js across CLINIC_MODE/CLINIC_ID_UUID/DATABASE_URL values — the switches themselves are under test, not the production machine');
const { setupTestDb, seedSaiShradha } = require('../tools/testHelpers/setupDb');

// ─── PRODUCTION CONFIG, PINNED BEFORE ANY MODULE READS process.env ──────────
// config.js snapshots env at require time, and a bare `node tests/foo.js`
// otherwise inherits CLINIC_MODE='full' — a branch production has not taken
// since the lean pilot. None of these three change a single query in db.js
// TODAY (db.js reads exactly two config values: clinicId and databaseUrl), and
// they are pinned anyway so the next person who adds a lean-only query here
// finds the pin already correct instead of discovering the default.
process.env.CLINIC_MODE = 'lean';
process.env.READBACK = 'on';
process.env.ENABLE_MULTILINGUAL = 'true';

let pass = 0, fail = 0;
const notCoveredNotes = [];

function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function notCovered(what, why) {
  notCoveredNotes.push(what);
  console.log(`  ⏭  NOT COVERED — ${what}`);
  console.log(`      ${why}`);
}

async function main() {
  // The harness pool first: its clinic id has to exist before config.js reads
  // CLINIC_ID_UUID, because clinic() supplies $1 to nearly every query in db.js.
  // Unset, every SELECT below would return zero rows and every assertion would
  // fail for a reason that has nothing to do with the schema.
  const { pool, clinicId } = await setupTestDb();
  const REAL = !!(pool.supports && pool.supports.realPostgres);
  const docs = await seedSaiShradha(pool, clinicId);

  console.log(`\nDB SCHEMA ⇄ db.js QUERY CONTRACT — backend: ${REAL ? 'real Postgres (all migrations)' : 'pg-mem (migration 001 only)'}`);

  process.env.CLINIC_ID_UUID = clinicId;  // NOT "CLINIC_ID" — config.js:242
  // db.js opens its OWN pg Pool from config.databaseUrl at require time and
  // pings it. The repo root carries a .env holding the LIVE clinic database, so
  // without this line `node tests/test-db-schema-port.js` opens a socket to
  // production just to say hello. Point it at the throwaway (or at nothing).
  // dotenv does not override an already-set variable, so this wins.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';

  const db = require('../db.js');

  // ─── THE INTERCEPT (house rule: at the real boundary) ─────────────────────
  let queriesThroughDbJs = 0;
  db.pool.query = (...args) => { queriesThroughDbJs++; return pool.query(...args); };

  // ─── THE SILENCE TAP ─────────────────────────────────────────────────────
  // db.js catches, logs and returns []. Without this, a query that no longer
  // matches the schema shows up as "no reminders due" and several assertions
  // below could be satisfied by an empty result for the wrong reason.
  const swallowed = [];
  const realConsoleError = console.error;
  console.error = (...args) => {
    const line = args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ');
    // initDb()'s fire-and-forget probe against the deliberately-dead
    // DATABASE_URL above, plus pg's idle-client noise. Not db.js's queries.
    if (/connectivity check failed|Unexpected error on idle client/.test(line)) return;
    swallowed.push(line);
    realConsoleError('      [db.js swallowed]', line.split('\n')[0]);
  };
  const section = (title) => { console.log(`\n${title}`); swallowed.length = 0; };
  const assertSilent = (label) => {
    assert(`${label} — db.js swallowed no DB error`, swallowed.length === 0, swallowed[0] && swallowed[0].split('\n')[0]);
    swallowed.length = 0;
  };

  const PHONE = '9876543210';        // canonical, as phoneVariants() emits it
  const JUNK_PHONE = '9820011111';   // Prithvi's row-set, reproduced
  const MED_PHONE = '9812345678';

  // ══ 1. patients: upsertPatient / checkReturningPatient / getReturningPatientName
  section('[1] patients — one handset is one row, whatever the carrier sent');
  {
    const id1 = await db.upsertPatient('+919876543210', 'सिद्धार्थ');
    assert('upsertPatient returns an id', !!id1);
    const { rows: stored } = await pool.query('SELECT id, phone, name FROM patients WHERE clinic_id=$1 AND name=$2', [clinicId, 'सिद्धार्थ']);
    assert('the row landed under the canonical 10-digit phone', stored.length === 1 && stored[0].phone === PHONE, JSON.stringify(stored));

    const id2 = await db.upsertPatient('09876543210', 'सिद्धार्थ');
    assert('a second carrier format claims the SAME row, not a format twin', id2 === id1, `${id1} vs ${id2}`);
    const { rows: all } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone = ANY($2)', [clinicId, [PHONE, `91${PHONE}`, `+91${PHONE}`, `0${PHONE}`]]);
    assert('still exactly one row for the handset', all.length === 1, `${all.length} rows`);

    for (const dialed of [PHONE, `91${PHONE}`, `+91${PHONE}`, `0${PHONE}`]) {
      assert(`checkReturningPatient recognises ${dialed}`, (await db.checkReturningPatient(dialed)) === true);
    }
    assert('an unknown handset is honestly unknown', (await db.checkReturningPatient('9000000001')) === false);

    // The Kannada-placeholder row-set. upsertPatient renames the 'Unknown'
    // placeholder in place, then files the junk row beside the real name — so
    // the table ends up with a real name older than a junk name, exactly like
    // production. A LIMIT 1 in the SQL answers "ಅಪರಿಚಿತ" here; db.js ranks in
    // SQL and chooses in JS, so it must answer "Prithvi".
    const junkId = await db.upsertPatient(JUNK_PHONE, null);            // → 'Unknown'
    const realId = await db.upsertPatient(`91${JUNK_PHONE}`, 'Prithvi');
    assert('a real name renames the placeholder instead of sitting beside it', realId === junkId, `${junkId} vs ${realId}`);
    await db.upsertPatient(`+91${JUNK_PHONE}`, 'ಅಪರಿಚಿತ');
    await pool.query(`UPDATE patients SET created_at = $2 WHERE clinic_id=$1 AND name='Prithvi'`, [clinicId, new Date('2026-01-01T00:00:00Z')]);
    await pool.query(`UPDATE patients SET created_at = $2 WHERE clinic_id=$1 AND name='ಅಪರಿಚಿತ'`, [clinicId, new Date('2026-08-01T00:00:00Z')]);
    assert('getReturningPatientName skips the NEWER junk row for the older real name',
      (await db.getReturningPatientName(`0${JUNK_PHONE}`)) === 'Prithvi',
      JSON.stringify(await db.getReturningPatientName(`0${JUNK_PHONE}`)));
    assert('getReturningPatientName returns the Devanagari name intact', (await db.getReturningPatientName(PHONE)) === 'सिद्धार्थ');
    assert('a handset with no rows returns null', (await db.getReturningPatientName('9000000002')) === null);
    assertSilent('[1]');
  }

  // ══ 2. getDoctorsRoster — the lean-mode prompt's whole world
  section('[2] getDoctorsRoster — doctors ⋈ doctor_schedules, and the uuid[] cast');
  {
    // MEASURED 2026-08-13: pg-mem answers `uuid = ANY($1::uuid[])` with ZERO
    // rows (20 rows on real Postgres, same data). TEXT columns are fine — this
    // file's phone lookups use = ANY and work — but the UUID key that
    // getDoctorsRoster's second query uses is not. On the double every doctor
    // therefore comes back with an empty schedule, which is indistinguishable
    // from db.js having lost the join. Probe it; never assume it.
    const { rows: anyProbe } = await pool.query(
      'SELECT doctor_id FROM doctor_schedules WHERE doctor_id = ANY($1::uuid[]) LIMIT 1', [[docs['Dr. Kapil Patwardhan'].id]]);
    const UUID_ANY = anyProbe.length === 1;

    const roster = await db.getDoctorsRoster();   // no arg → clinic() → CLINIC_ID_UUID
    assert('all 10 seeded doctors come back', roster.doctors.length === 10, `${roster.doctors.length}`);
    const kapil = roster.doctors.find((d) => d.name === 'Dr. Kapil Patwardhan');
    assert('fee_inr survives the round-trip', !!kapil && Number(kapil.fee_inr) === 800, kapil && String(kapil.fee_inr));
    assert('on-call specialists are told apart from scheduled ones',
      /On-call Nephrologist \(Nephrologist\) — on-call specialist/.test(roster.text));
    assert('ORDER BY is_on_call ASC puts bookable doctors first', roster.doctors[0].is_on_call === false);
    assert('another clinic id gets nothing (clinic scoping is real)',
      (await db.getDoctorsRoster('00000000-0000-0000-0000-000000000000')).doctors.length === 0);
    if (!UUID_ANY) {
      notCovered('getDoctorsRoster weekly hours (the doctor_schedules join)',
        'pg-mem returns 0 rows for `doctor_id = ANY($1::uuid[])`, so every doctor arrives scheduleless and the hours in the lean prompt cannot be checked here.');
    } else {
      assert('the schedule join resolved (5 weekday windows)', !!kapil && kapil.windows.length === 5, kapil && JSON.stringify(kapil.windows));
      // 20:00, NOT the seeded 20:30 close. `end` here is the last time worth
      // OFFERING: tools/utils/availability.js books on `minutes < end`, so
      // 20:30 is not a bookable time and the model must never be handed it.
      // Live 2026-08-13 (c394b280) it was, the model offered the close, the
      // caller accepted, and the booking check refused the time Ritu had just
      // promised. See tools/utils/offerWindow.js + tests/test-offer-window.js.
      // This assertion pinned the raw close, so it went red on that fix — which
      // is how it should behave; the contract changed on purpose.
      assert('TIME columns render as HH:MM, ending at the last OFFERABLE start',
        !!kapil && kapil.windows[0] && kapil.windows[0].start === '18:30' && kapil.windows[0].end === '20:00',
        kapil && JSON.stringify(kapil.windows[0]));
      assert('the prompt line carries name + fee + collapsed offerable hours',
        /- Dr\. Kapil Patwardhan \(Internal Medicine\), fees ₹800 — available: Mon,Tue,Wed,Thu,Fri 18:30-20:00/.test(roster.text),
        roster.text.split('\n').find((l) => /Kapil/.test(l)));
    }
    assertSilent('[2]');
  }

  // ══ 3. reminders — the 23-25h window, the join, and the flag writers
  section('[3] getAppointmentsForReminder + markReminderSent/Confirmed/Cancelled');
  {
    const { rows: [p] } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2', [clinicId, PHONE]);
    const mkAppt = async (doctorName, at, reason) => {
      const { rows: [a] } = await pool.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status)
         VALUES ($1,$2,$3,$4,$5,'booked') RETURNING id`,
        [clinicId, p.id, docs[doctorName].id, at, reason]);
      return a.id;
    };
    const H = 3600 * 1000;
    const dueId  = await mkAppt('Dr. Kapil Patwardhan', new Date(Date.now() + 24 * H), 'pet dard');
    const soonId = await mkAppt('Dr. Vikas Gaikwad',    new Date(Date.now() + 3 * H),  'taap');

    const due = await db.getAppointmentsForReminder();
    assert('the appointment 24h out is due for a reminder', due.length === 1 && due[0].id === dueId, `${due.length} rows`);
    assert('the one 3h out is NOT — the 23-25h window is load-bearing', !due.some((r) => r.id === soonId));
    const r0 = due[0] || {};
    assert('appointment_time is aliased to scheduled_at', r0.scheduled_at instanceof Date, String(r0.scheduled_at));
    assert('the patients join supplies phone_number', r0.phone_number === PHONE, String(r0.phone_number));
    assert('…and patient_name', r0.patient_name === 'सिद्धार्थ', String(r0.patient_name));
    assert('the doctors join supplies doctor_name + specialty',
      r0.doctor_name === 'Dr. Kapil Patwardhan' && r0.specialty === 'Internal Medicine', `${r0.doctor_name}/${r0.specialty}`);
    assert('reason comes through for the message body', r0.reason === 'pet dard', String(r0.reason));

    await db.markReminderSent(dueId);
    const { rows: [flag] } = await pool.query('SELECT reminder_sent FROM appointments WHERE id=$1', [dueId]);
    assert('markReminderSent wrote reminder_sent = TRUE', flag.reminder_sent === true, String(flag.reminder_sent));
    assert('and the row leaves the reminder queue', (await db.getAppointmentsForReminder()).every((r) => r.id !== dueId));

    await db.markAppointmentConfirmed(dueId);
    const { rows: [c] } = await pool.query('SELECT confirmed FROM appointments WHERE id=$1', [dueId]);
    assert('markAppointmentConfirmed wrote confirmed = TRUE', c.confirmed === true, String(c.confirmed));

    const cancelId = await mkAppt('Dr. Priyanka Bhosale', new Date(Date.now() + 24 * H), 'checkup');
    assert('a fresh 24h appointment enters the queue', (await db.getAppointmentsForReminder()).some((r) => r.id === cancelId));
    await db.markAppointmentCancelled(cancelId);
    const { rows: [s] } = await pool.query('SELECT status FROM appointments WHERE id=$1', [cancelId]);
    assert("markAppointmentCancelled wrote status = 'cancelled'", s.status === 'cancelled', String(s.status));
    assert('a cancelled appointment is never reminded', (await db.getAppointmentsForReminder()).every((r) => r.id !== cancelId));
    assertSilent('[3]');
  }

  // ══ 4. missed-call recovery — the two functions the old file faked
  section('[4] getMissedCallsForFollowup + markCallWhatsAppSent');
  {
    const MISSED = 'CALL_MISSED_1';
    const BOOKED = 'CALL_BOOKED_1';
    if (REAL) {
      // Seeded through the production writer, so the read path is fed by the
      // same column mapping the server uses.
      await db.logCallToDb({ callSid: MISSED, callerPhone: PHONE, patientName: 'सिद्धार्थ', durationSeconds: 22, outcome: 'hangup' });
      await db.logCallToDb({ callSid: BOOKED, callerPhone: PHONE, patientName: 'सिद्धार्थ', durationSeconds: 91, appointmentBooked: true });
    } else {
      // pg-mem holds migration 001 only, and logCallToDb writes 002+008
      // columns. Seed the 001-era subset directly so the two functions that DO
      // fit on this double are still driven end-to-end. logCallToDb's own
      // column mapping is covered in section [5], real Postgres only.
      for (const [sid, outcome, dur] of [[MISSED, 'hangup', 22], [BOOKED, 'booked', 91]]) {
        await pool.query(
          `INSERT INTO calls (clinic_id, exotel_call_sid, patient_phone, patient_id, patient_name, duration_seconds, outcome, whatsapp_sent)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,FALSE)`, [clinicId, sid, PHONE, 'सिद्धार्थ', dur, outcome]);
      }
    }
    const queue = await db.getMissedCallsForFollowup();
    assert('the un-booked call is in the recovery queue', queue.some((r) => r.call_sid === MISSED), JSON.stringify(queue.map((r) => r.call_sid)));
    assert('the booked call is NOT', !queue.some((r) => r.call_sid === BOOKED));
    const q0 = queue.find((r) => r.call_sid === MISSED) || {};
    assert('exotel_call_sid is aliased to call_sid, patient_phone to caller_phone',
      q0.caller_phone === PHONE && q0.outcome === 'hangup', JSON.stringify(q0));

    // The line that used to read `assert('markCallWhatsAppSent updates', true)`.
    await db.markCallWhatsAppSent(MISSED);
    const { rows: [w] } = await pool.query('SELECT whatsapp_sent FROM calls WHERE exotel_call_sid=$1', [MISSED]);
    assert('markCallWhatsAppSent wrote whatsapp_sent = TRUE in the table', w.whatsapp_sent === true, String(w.whatsapp_sent));
    assert('…so the call leaves the queue and is not messaged twice',
      (await db.getMissedCallsForFollowup()).every((r) => r.call_sid !== MISSED));
    assertSilent('[4]');
  }

  // ══ 5. logCallToDb — 14 columns across migrations 001, 002 and 008
  section('[5] logCallToDb — the full call record');
  if (!REAL) {
    notCovered('logCallToDb (all 14 columns), calls.language/reason (002), calls.not_booked_reason/diagnostics (008)',
      'pg-mem loads migration 001 only; the INSERT dies on `column "language" does not exist`.');
  } else {
    const SID = 'CALL_LOG_1';
    const transcript = [
      { role: 'patient', text: 'मेरे पेट में दर्द है', time: '2026-08-13T09:00:01.000Z' },
      { role: 'ritu',    text: 'डॉ. कपिल पटवर्धन से मिल सकते हैं', time: '2026-08-13T09:00:04.000Z' },
    ];
    await db.logCallToDb({
      callSid: SID, callerPhone: `+91${PHONE}`, patientName: 'सिद्धार्थ', durationSeconds: 83,
      appointmentBooked: true,                 // no explicit outcome → derived
      transcript, languageDetected: 'hi-IN',
      reason: 'Unknown',                       // the sentinel that must store NULL
      diagnostics: { patientTurns: 4, garbleReasks: 1, endTrigger: 'wrapup' },
    });
    const { rows } = await pool.query(
      `SELECT patient_id, patient_name, patient_phone, duration_seconds, outcome, whatsapp_sent,
              transcript, language, reason, not_booked_reason, diagnostics
         FROM calls WHERE exotel_call_sid=$1`, [SID]);
    assert('exactly one call row', rows.length === 1, `${rows.length}`);
    const c = rows[0] || {};
    assert("appointmentBooked:true derives outcome='booked'", c.outcome === 'booked', String(c.outcome));
    assert('whatsapp_sent starts FALSE so recovery can claim it', c.whatsapp_sent === false, String(c.whatsapp_sent));
    assert('duration + name persisted', c.duration_seconds === 83 && c.patient_name === 'सिद्धार्थ');
    const { rows: [pt] } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 AND name=$3', [clinicId, PHONE, 'सिद्धार्थ']);
    assert('logCallToDb upserted the patient and wrote the FK', c.patient_id === pt.id, `${c.patient_id} vs ${pt.id}`);
    let t = c.transcript; if (typeof t === 'string') { try { t = JSON.parse(t); } catch (_) {} }
    assert('transcript went in as JSONB, not a Postgres array', Array.isArray(t) && t.length === 2, JSON.stringify(t).slice(0, 90));
    assert('Devanagari survived the round-trip', Array.isArray(t) && /पेट में दर्द/.test(t[0].text));
    assert('language persisted (migration 002)', c.language === 'hi-IN', String(c.language));
    assert("reason 'Unknown' is stored as NULL, not the word", c.reason === null, JSON.stringify(c.reason));
    let d = c.diagnostics; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) {} }
    assert('diagnostics JSONB round-trips (migration 008)', d && d.patientTurns === 4 && d.endTrigger === 'wrapup', JSON.stringify(d));

    // Exotel retries a webhook; a second log of the same SID must not duplicate.
    await db.logCallToDb({ callSid: SID, callerPhone: `+91${PHONE}`, durationSeconds: 999, outcome: 'failed' });
    const { rows: again } = await pool.query('SELECT duration_seconds FROM calls WHERE exotel_call_sid=$1', [SID]);
    assert('ON CONFLICT (exotel_call_sid) DO NOTHING — still one row, unchanged',
      again.length === 1 && again[0].duration_seconds === 83, JSON.stringify(again));

    await db.logCallToDb({
      callSid: 'CALL_LOG_2', callerPhone: PHONE, durationSeconds: 12,
      appointmentBooked: false, notBookedReason: 'caller_hung_up',
    });
    const { rows: [nb] } = await pool.query('SELECT outcome, not_booked_reason FROM calls WHERE exotel_call_sid=$1', ['CALL_LOG_2']);
    assert("appointmentBooked:false derives outcome='inquiry_only'", nb.outcome === 'inquiry_only', String(nb.outcome));
    assert('not_booked_reason persisted (migration 008)', nb.not_booked_reason === 'caller_hung_up', String(nb.not_booked_reason));
    assertSilent('[5]');
  }

  // ══ 6. follow-ups — CURRENT_DATE arithmetic pg-mem cannot cast
  section('[6] getAppointmentsForFollowup + markFollowupSent');
  if (!REAL) {
    notCovered('getAppointmentsForFollowup + markFollowupSent',
      'pg-mem raises `cannot cast type date to timestamptz` on (CURRENT_DATE - INTERVAL \'1 day\' + INTERVAL \'10 hours\').');
  } else {
    const { rows: [p] } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 AND name=$3', [clinicId, PHONE, 'सिद्धार्थ']);
    // Placed by SQL date arithmetic so the fixture is inside the window no
    // matter what time of day the suite runs: yesterday-10:00 → today-18:00.
    const mk = async (doctorName, expr) => {
      const { rows: [a] } = await pool.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status)
         VALUES ($1,$2,$3, ${expr}, 'follow me up','booked') RETURNING id`,
        [clinicId, p.id, docs[doctorName].id]);
      return a.id;
    };
    const inWindow  = await mk('Dr. Sunil Nikam',        `CURRENT_DATE + INTERVAL '11 hours'`);
    const outWindow = await mk('Dr. Priyanka Bhosale',   `CURRENT_DATE + INTERVAL '30 hours'`);

    const fu = await db.getAppointmentsForFollowup();
    assert('yesterday-10:00 → today-18:00 appointment is due a follow-up', fu.some((r) => r.id === inWindow), JSON.stringify(fu.map((r) => r.id)));
    assert('one past the +18h edge is not', !fu.some((r) => r.id === outWindow));
    const f0 = fu.find((r) => r.id === inWindow) || {};
    assert('the follow-up join carries phone + doctor too',
      f0.phone_number === PHONE && f0.doctor_name === 'Dr. Sunil Nikam' && f0.specialty === 'Orthopedic', JSON.stringify(f0));
    await db.markFollowupSent(inWindow);
    const { rows: [ff] } = await pool.query('SELECT follow_up_sent FROM appointments WHERE id=$1', [inWindow]);
    assert('markFollowupSent wrote follow_up_sent = TRUE', ff.follow_up_sent === true, String(ff.follow_up_sent));
    assert('and it leaves the follow-up queue', (await db.getAppointmentsForFollowup()).every((r) => r.id !== inWindow));
    assertSilent('[6]');
  }

  // ══ 7. WhatsApp conversation + messages
  section('[7] getOrCreateConversation / saveWhatsAppMessage / getConversationHistory / updateConversationState');
  if (!REAL) {
    notCovered('the whole WhatsApp conversation path',
      'whatsapp_conversations.language arrives in migration 004; on pg-mem the upsert dies on `column "language" does not exist`.');
  } else {
    const { rows: [p] } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 AND name=$3', [clinicId, PHONE, 'सिद्धार्थ']);
    const conv = await db.getOrCreateConversation(PHONE, p.id, 'kn-IN');
    assert('conversation created with the UUID patient_id', !!conv && conv.patient_id === p.id, JSON.stringify(conv && conv.patient_id));
    assert('language seeded from the call (migration 004)', conv.language === 'kn-IN', String(conv.language));

    const conv2 = await db.getOrCreateConversation(PHONE, p.id, null);
    assert('ON CONFLICT (phone_number) returns the same conversation', conv2.id === conv.id);
    assert('a null language does NOT clobber the stored one (COALESCE)', conv2.language === 'kn-IN', String(conv2.language));
    assert('last_message_at moved forward', new Date(conv2.last_message_at) >= new Date(conv.last_message_at));
    const conv3 = await db.getOrCreateConversation(PHONE, p.id, 'mr-IN');
    assert('an inbound-text detection DOES refine it', conv3.language === 'mr-IN', String(conv3.language));

    const mid = await db.saveWhatsAppMessage(conv.id, p.id, 'outbound', 'Aapka appointment confirm hai', 'confirmation', 'sid-A');
    assert('saveWhatsAppMessage returns the new id', !!mid);
    await db.saveWhatsAppMessage(conv.id, p.id, 'inbound',  'kitne baje?', 'general', 'sid-B');
    await db.saveWhatsAppMessage(conv.id, p.id, 'outbound', 'Shaam 6:30 baje', 'general', 'sid-C');
    // sent_at defaults to now() and three inserts can land inside the same
    // microsecond; pin them so ORDER BY sent_at DESC is deterministic and the
    // ordering assertion is about db.js rather than about clock resolution.
    for (const [sid, mins] of [['sid-A', 1], ['sid-B', 2], ['sid-C', 3]]) {
      await pool.query('UPDATE whatsapp_messages SET sent_at = NOW() - ($2 || \' minutes\')::interval WHERE message_sid=$1', [sid, String(10 - mins)]);
    }
    const hist = await db.getConversationHistory(conv.id);
    assert('history is handed to the LLM oldest-first', hist.map((h) => h.content).join('|') === 'Aapka appointment confirm hai|kitne baje?|Shaam 6:30 baje', JSON.stringify(hist));
    assert('outbound → assistant, inbound → user', hist[0].role === 'assistant' && hist[1].role === 'user' && hist[2].role === 'assistant', JSON.stringify(hist.map((h) => h.role)));
    const hist2 = await db.getConversationHistory(conv.id, 2);
    assert('the limit keeps the NEWEST two, then restores order', hist2.map((h) => h.content).join('|') === 'kitne baje?|Shaam 6:30 baje', JSON.stringify(hist2));

    await db.updateConversationState(conv.id, 'awaiting_report');
    const { rows: [st] } = await pool.query('SELECT state FROM whatsapp_conversations WHERE id=$1', [conv.id]);
    assert('updateConversationState wrote the state column', st.state === 'awaiting_report', String(st.state));
    assertSilent('[7]');
  }

  // ══ 8. medications — the prior the accuracy number rides on
  section('[8] saveConfirmedMedication / getPatientMedications');
  if (!REAL) {
    notCovered('patient_medications entirely (save + the prior read)',
      'the table arrives in migration 007 and entity_type in 009; on pg-mem: `relation "patient_medications" does not exist`.');
  } else {
    const mpid = await db.upsertPatient(MED_PHONE, 'Asha');
    const med = (over) => Object.assign({
      patientId: mpid, phone: `91${MED_PHONE}`, callSid: 'CALL_MED_1', canonical: 'X',
      resolution: 'affirmed', matchScore: 0.21, viaBrand: false, turnOffsetMs: 41200, language: 'hi-IN',
    }, over);
    const telmaId = await db.saveConfirmedMedication(med({ canonical: 'Telmisartan', brand: 'Telma', heardSurface: 'telma chalis', viaBrand: true }));
    assert('saveConfirmedMedication returns the new id', !!telmaId);
    await db.saveConfirmedMedication(med({ canonical: 'Penicillin', heardSurface: 'penicillin se allergy', entityType: 'allergy' }));
    await db.saveConfirmedMedication(med({ canonical: 'Metformin',    resolution: 'volunteered' }));
    await db.saveConfirmedMedication(med({ canonical: 'Atorvastatin', resolution: 'unconfirmed' }));

    const { rows: [pen] } = await pool.query('SELECT entity_type, match_score, via_brand, turn_offset_ms FROM patient_medications WHERE canonical=$1', ['Penicillin']);
    assert("an allergy is stored as entity_type='allergy' (migration 009)", pen.entity_type === 'allergy', String(pen.entity_type));
    const { rows: [tel] } = await pool.query('SELECT entity_type, match_score, via_brand, turn_offset_ms, heard_surface FROM patient_medications WHERE canonical=$1', ['Telmisartan']);
    assert("a drug defaults to entity_type='medication'", tel.entity_type === 'medication', String(tel.entity_type));
    assert('match_score / via_brand / turn_offset_ms persisted',
      Number(tel.match_score) === 0.21 && tel.via_brand === true && tel.turn_offset_ms === 41200, JSON.stringify(tel));

    // Read under a THIRD phone format — the prior is worthless if it only
    // resolves under the string the carrier happened to send.
    const prior = await db.getPatientMedications(`+91${MED_PHONE}`);
    const names = prior.map((r) => r.canonical);
    assert('the affirmed molecule is in the prior', names.includes('Telmisartan'), JSON.stringify(names));
    assert('the ALLERGY is not — entity_type filter holds', !names.includes('Penicillin'), JSON.stringify(names));
    assert("'volunteered' is not a confirmation", !names.includes('Metformin'), JSON.stringify(names));
    assert("'unconfirmed' is not a confirmation", !names.includes('Atorvastatin'), JSON.stringify(names));
    assert('brand + resolution come back for the read-back line',
      prior[0] && prior[0].brand === 'Telma' && prior[0].resolution === 'affirmed', JSON.stringify(prior[0]));

    // Same molecule, later visit, different brand → DISTINCT ON keeps one, newest.
    await pool.query(`UPDATE patient_medications SET created_at = $1 WHERE canonical='Telmisartan'`, [new Date('2026-01-01T00:00:00Z')]);
    await db.saveConfirmedMedication(med({ canonical: 'Telmisartan', brand: 'Telmikind', viaBrand: true }));
    const prior2 = await db.getPatientMedications(MED_PHONE);
    assert('DISTINCT ON (canonical) collapses the repeat visit to one row',
      prior2.filter((r) => r.canonical === 'Telmisartan').length === 1, JSON.stringify(prior2.map((r) => r.canonical)));
    assert('…and keeps the NEWEST row', prior2.find((r) => r.canonical === 'Telmisartan').brand === 'Telmikind',
      JSON.stringify(prior2.find((r) => r.canonical === 'Telmisartan')));

    // 556b9b4 stays fixed: two real names on one handset ⇒ no prior at all.
    await db.upsertPatient(MED_PHONE, 'Atul');
    assert('a shared handset drops the prior rather than guessing whose it is',
      (await db.getPatientMedications(MED_PHONE)).length === 0);
    assertSilent('[8]');
  }

  // ══ 9. patient_documents — the WhatsApp report intake
  section('[9] savePatientDocument');
  if (!REAL) {
    notCovered('savePatientDocument + patient_documents',
      'the table arrives in migration 003; pg-mem has only 001.');
  } else {
    const { rows: [p] } = await pool.query('SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 AND name=$3', [clinicId, MED_PHONE, 'Asha']);
    const bytes = Buffer.from('%PDF-1.4 fake blood report');
    let id = null, threw = null;
    try {
      id = await db.savePatientDocument({
        clinicId, patientId: p.id, phone: MED_PHONE, waMediaId: 'wamid.XYZ', mimeType: 'application/pdf',
        caption: 'blood report', content: bytes, summary: 'Hb 9.1 g/dL — low',
        summaryJson: { hb: 9.1, flags: ['low_hb'] },
      });
    } catch (e) { threw = e.message; }
    // NOTE: savePatientDocument is the ONE db.js function with no try/catch —
    // it throws to its caller (reportIntake.js) by design, so a failure here is
    // an exception, not a swallowed log line.
    assert('savePatientDocument returns the new id', !!id, threw || 'no id');
    const { rows: [d] } = await pool.query('SELECT mime_type, caption, content, summary, summary_json FROM patient_documents WHERE id=$1', [id]);
    assert('BYTEA content round-trips byte-for-byte', Buffer.isBuffer(d.content) && d.content.equals(bytes), String(d.content && d.content.length));
    assert('summary + caption persisted', d.summary === 'Hb 9.1 g/dL — low' && d.caption === 'blood report');
    let sj = d.summary_json; if (typeof sj === 'string') { try { sj = JSON.parse(sj); } catch (_) {} }
    assert('summary_json is JSONB, stringified on the way in', sj && sj.hb === 9.1 && sj.flags[0] === 'low_hb', JSON.stringify(sj));
    assertSilent('[9]');
  }

  // ── the guard against this file quietly stopping driving db.js again ──────
  console.log('\n[meta]');
  assert(`every assertion above went through db.js's own pool (${queriesThroughDbJs} queries)`, queriesThroughDbJs > 20, String(queriesThroughDbJs));

  console.error = realConsoleError;
  console.log(`\n${pass}/${pass + fail} passing`);

  if (notCoveredNotes.length) {
    console.log('\n══ NOT COVERED BY THIS RUN ══════════════════════════════════════════');
    console.log('  The pg-mem double loads migration 001 and nothing else, so these');
    console.log('  db.js queries were never executed against a schema that has their');
    console.log('  columns. A green run below does NOT cover them:');
    for (const n of notCoveredNotes) console.log(`    · ${n}`);
    console.log('  Restore full coverage — every section runs, nothing skips:');
    console.log('    docker run -d --name ritu-test-pg -e POSTGRES_PASSWORD=test \\');
    console.log('      -e POSTGRES_DB=ritu_test -p 55432:5432 postgres:16-alpine');
    console.log('    TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ritu_test \\');
    console.log('      node tests/test-db-schema-port.js');
    console.log('═════════════════════════════════════════════════════════════════════');
  }

  try { await pool.end(); } catch (_) { /* teardown must not decide the verdict */ }
  if (fail > 0) { console.log('✗ the schema does NOT support every query db.js runs'); process.exit(1); }
  console.log(`✓ db.js ran its own SQL against the ${REAL ? 'fully migrated' : '001'} schema and every query held.`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
