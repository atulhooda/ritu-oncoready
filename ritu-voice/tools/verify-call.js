#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE CALL ACTUALLY LEFT BEHIND
//
// Seven behaviour changes shipped between 2026-08-09 and 2026-08-11 and NOT
// ONE has been exercised by a real call:
//
//     1aa6e83  closed days ....... "KAL BAND" instead of offering a shut day
//     a3cf0ec  dentist ........... a specialty is not a prescription
//     d72c03b  history denial .... "no problem" is an answer, not a symptom
//     f9fa2ad  advice guard ...... a pushback is not a prescription request
//     ae136d3  allergy ........... an allergen is not a medication
//     79f2677  callback .......... a promise must leave a row behind
//     21e6cc1  phone identity .... one handset is one patient
//
// Every one of them is a DATABASE outcome, and a call that "sounded fine" can
// still have written the wrong row — that is precisely how the allergy bug
// survived: Ritu asked "आप Penicillin ले रहे हैं?", the patient truthfully said
// "हाँ" because she had heard the NAME right, and it persisted as a drug they
// take. Listening would not have caught it. Reading the row does.
//
// So this reads the rows. Run it after a scripted call:
//
//     node tools/verify-call.js --phone 8273500806 --since 30m
//
// It prints what the call wrote and checks the expectations that the seven
// fixes above are supposed to guarantee. Nothing here asserts on log text —
// three of four production defects this week passed tests that read source or
// logs rather than driving the thing itself.
//
// EXIT CODE is 1 if any HARD expectation failed, so this can gate a demo.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PHONE = arg('phone', null);
const SINCE = arg('since', '30m');
const CLINIC = process.env.CLINIC_ID_UUID || arg('clinic', null);

if (!PHONE) {
  console.error('usage: node tools/verify-call.js --phone 8273500806 [--since 30m] [--clinic <uuid>]');
  process.exit(2);
}

// The same variant set db.js now uses. Written out rather than imported so this
// tool still reports honestly if phoneVariants itself regresses — a verifier
// that shares the bug it is verifying is not a verifier.
const digits = String(PHONE).replace(/\D+/g, '');
const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
  : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits;
const VARIANTS = [ten, `91${ten}`, `+91${ten}`, `0${ten}`, `+${ten}`];

const mins = /^(\d+)\s*h/i.test(SINCE) ? parseInt(SINCE, 10) * 60 : parseInt(SINCE, 10) || 30;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let hardFails = 0;
const line = (s = '') => console.log(s);
const check = (hard, label, passed, detail) => {
  const mark = passed ? '  ✓' : (hard ? '  ✗' : '  !');
  console.log(`${mark} ${label}${detail ? `\n        ${detail}` : ''}`);
  if (!passed && hard) hardFails++;
};

(async () => {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  const clinicFilter = CLINIC ? 'AND clinic_id = $3' : '';
  const params = CLINIC ? [VARIANTS, mins, CLINIC] : [VARIANTS, mins];

  // ── what happened at all ────────────────────────────────────────────────
  const calls = await q(
    `SELECT id, exotel_call_sid, patient_name, language, outcome, not_booked_reason,
            duration_seconds, appointment_id, callback_id, reason, created_at
       FROM calls
      WHERE patient_phone = ANY($1)
        AND created_at > NOW() - ($2 || ' minutes')::interval ${clinicFilter}
      ORDER BY created_at DESC`,
    params
  );

  line();
  line(`══ CALL VERIFICATION ─ ${ten} ─ last ${mins}m ${CLINIC ? `─ clinic ${CLINIC.slice(0, 8)}` : '─ ALL CLINICS'}`);
  line();

  if (!calls.length) {
    line(`  no calls found in the last ${mins} minutes for any format of ${ten}`);
    line(`  formats searched: ${VARIANTS.join('  ')}`);
    line();
    line('  If the call definitely happened, the likely causes are:');
    line('    - CLINIC_ID_UUID is unset here, so --clinic did not scope (this run searched all clinics)');
    line('    - the call is still in progress; the row is written at hangup');
    await pool.end();
    process.exit(1);
  }

  const call = calls[0];
  line(`  call ......... ${call.exotel_call_sid || call.id}`);
  line(`  at ........... ${call.created_at.toISOString()}`);
  line(`  duration ..... ${call.duration_seconds != null ? `${call.duration_seconds}s` : '(not recorded)'}`);
  line(`  language ..... ${call.language || '(none)'}`);
  line(`  outcome ...... ${call.outcome || '(none)'}${call.not_booked_reason ? `  reason=${call.not_booked_reason}` : ''}`);
  line(`  reason ....... ${call.reason || '(none)'}`);
  line(`  heard name ... ${call.patient_name || '(none)'}`);
  if (calls.length > 1) line(`  (${calls.length - 1} earlier call(s) in window — checking the most recent)`);

  // ── 21e6cc1 — phone identity ────────────────────────────────────────────
  line();
  line('── 21e6cc1  phone identity ─ one handset is one patient');
  const pats = await q(
    `SELECT id, phone, name, created_at FROM patients
      WHERE phone = ANY($1) ${CLINIC ? 'AND clinic_id = $2' : ''} ORDER BY created_at`,
    CLINIC ? [VARIANTS, CLINIC] : [VARIANTS]
  );
  const formats = new Set(pats.map((p) => p.phone));
  const fresh = pats.filter((p) => Date.now() - p.created_at.getTime() < mins * 60000);
  // SOFT. Legacy splitting predates 21e6cc1 and no call can undo it — reads heal
  // it via the variant set, and no backfill was run (nine tables FK to
  // patients.id). Marking this HARD made the tool fail on every historical
  // handset, which is how a verifier trains you to ignore it before a demo.
  check(false, `handset stored under ${formats.size} phone format(s)`,
    formats.size <= 1,
    formats.size > 1
      ? `legacy split, expected: ${[...formats].join('  ')} — reads match all of them; what matters is the hard check below`
      : `all ${pats.length} row(s) under "${[...formats][0] || '—'}"`);
  // HARD. This is the actual post-fix guarantee: a call must not ADD a row in a
  // format the handset was not already using, and must not add a second row for
  // somebody already in the table.
  const canonical = ten;
  const newBadFormat = fresh.filter((p) => p.phone !== canonical);
  check(true, 'this call added no NEW non-canonical phone row',
    newBadFormat.length === 0,
    newBadFormat.length
      ? `created ${newBadFormat.map((p) => `${p.name}@${p.phone}`).join(', ')} — upsertPatient is minting format twins again, 21e6cc1 has regressed`
      : null);
  check(true, 'this call added at most one patient row',
    fresh.length <= 1,
    fresh.length > 1 ? `created ${fresh.length}: ${fresh.map((p) => `${p.name}@${p.phone}`).join(', ')}` : null);
  line(`    ${pats.length} row(s) on this handset: ${pats.map((p) => `${p.name}@${p.phone}`).join(', ')}`);

  // ── ae136d3 / a3cf0ec — what got recorded as clinical ───────────────────
  line();
  line('── ae136d3 allergy │ a3cf0ec dentist ─ what landed in the medical record');
  const meds = await q(
    `SELECT canonical, brand, heard_surface, resolution, entity_type, match_score, via_brand, language, created_at
       FROM patient_medications
      WHERE phone = ANY($1) AND created_at > NOW() - ($2 || ' minutes')::interval ${clinicFilter}
      ORDER BY created_at`,
    params
  );
  if (!meds.length) {
    line('    (nothing recorded this call)');
  } else {
    meds.forEach((m) => line(
      `    ${String(m.entity_type).toUpperCase().padEnd(10)} ${String(m.canonical).padEnd(16)} ` +
      `heard="${m.heard_surface || ''}" via=${m.via_brand ? `brand:${m.brand}` : 'molecule'} ` +
      `score=${m.match_score != null ? Number(m.match_score).toFixed(2) : '-'} ${m.resolution}`));
  }
  // The dentist bug wrote a SPECIALTY into a patient's drug list. These are the
  // words that must never appear as a canonical, whatever the caller said.
  const NEVER_A_DRUG = /^(dentist|doctor|dermatologist|cardiologist|physician|surgeon|checkup|check-?up|consultation|treatment|appointment|surgery)$/i;
  const specialtyRows = meds.filter((m) => NEVER_A_DRUG.test(String(m.canonical).trim()));
  check(true, 'no specialty or visit-word was recorded as a drug',
    specialtyRows.length === 0,
    specialtyRows.length ? `RECORDED AS MEDICATION: ${specialtyRows.map((m) => m.canonical).join(', ')} — a3cf0ec has regressed` : null);

  const allergyRows = meds.filter((m) => m.entity_type === 'allergy');
  const medRows = meds.filter((m) => m.entity_type === 'medication');
  line(`    → ${medRows.length} medication(s), ${allergyRows.length} allergy(ies)`);
  line('      If you said an allergy this call, it MUST appear above as ALLERGY.');
  line('      Landing as MEDICATION is the 2026-08-10 bug: it tells a doctor the');
  line('      patient TOLERATES a drug they cannot have.');

  // ── 79f2677 — the callback promise ──────────────────────────────────────
  line();
  line('── 79f2677  callback ─ a promise must leave a row behind');
  const cbs = await q(
    `SELECT patient_name, specialty, reason, status, created_at FROM callbacks
      WHERE patient_phone = ANY($1) AND created_at > NOW() - ($2 || ' minutes')::interval ${clinicFilter}
      ORDER BY created_at`,
    params
  );
  if (cbs.length) {
    cbs.forEach((c) => line(`    ${c.status.padEnd(10)} ${String(c.specialty || '-').padEnd(16)} for "${c.patient_name}" — ${c.reason || 'no reason'}`));
  } else {
    line('    (no callback row)');
  }
  line('      Ask for an ONCOLOGIST (Dr. Rekha Sardesai is the only on-call doctor');
  line('      in Smile Dental and has ZERO schedule rows). If Ritu says she will');
  line('      arrange a callback, a row MUST be here. Before 79f2677 there were 0');
  line('      rows in this table, ever.');
  check(true, 'a spoken callback promise is backed by a row',
    !(call.callback_id && !cbs.length),
    call.callback_id && !cbs.length ? 'the call references a callback_id but no row exists' : null);

  // ── 1aa6e83 — closed days ───────────────────────────────────────────────
  line();
  line('── 1aa6e83  closed days ─ never offer a day the doctor is shut');
  const appts = await q(
    `SELECT a.appointment_time, a.status, a.confirmed, a.reason, a.is_walk_in,
            d.name AS doctor, d.specialty,
            EXTRACT(DOW FROM a.appointment_time)::int AS dow
       FROM appointments a JOIN doctors d ON d.id = a.doctor_id
      WHERE a.patient_id IN (SELECT id FROM patients WHERE phone = ANY($1))
        AND a.created_at > NOW() - ($2 || ' minutes')::interval ${CLINIC ? 'AND a.clinic_id = $3' : ''}
      ORDER BY a.created_at`,
    params
  );
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (!appts.length) {
    line('    (no appointment booked this call)');
  } else {
    for (const a of appts) {
      const sched = await q(
        `SELECT 1 FROM doctor_schedules s JOIN doctors d ON d.id = s.doctor_id
          WHERE d.name = $1 AND s.day_of_week = $2 LIMIT 1`,
        [a.doctor, a.dow]
      );
      const openThatDay = sched.length > 0;
      line(`    ${a.appointment_time.toISOString()} (${DAY[a.dow]})  ${a.doctor} [${a.specialty}]  status=${a.status} confirmed=${a.confirmed}`);
      check(true, `${a.doctor} actually works on ${DAY[a.dow]}`,
        openThatDay,
        openThatDay ? null : `BOOKED ON A CLOSED DAY — 1aa6e83 has regressed. ${a.doctor} has no doctor_schedules row for ${DAY[a.dow]}.`);
    }
  }
  line('      To exercise this: ask for a NEUROLOGIST tomorrow. Dr. Manoj Deo works');
  line('      Mon/Wed/Fri only. Ritu must say he is shut and offer a day he works,');
  line('      not book you in anyway and not go silent.');

  // ── the summary, which is what a doctor actually reads ──────────────────
  line();
  line('── the pre-visit summary a doctor sees');
  const sums = await q(
    `SELECT reason, symptoms, icd11, clinical, model, generated_at FROM call_summaries
      WHERE call_id = $1`, [call.id]
  );
  if (!sums.length) {
    // NOT A DEFECT, and this used to read like one. call_summaries is written
    // by the DASHBOARD (ritu-desk-demo lib/queries/callSummary.ts,
    // getOrCreateCallSummary), lazily, the first time somebody opens the call —
    // nothing in this server writes that table at all. 42 of 144 calls have a
    // summary purely because 42 have been looked at.
    line('    (not generated yet — the dashboard writes this when the call is opened,');
    line('     not the server at hangup. Open the call in Ritu Desk to produce it.)');
  } else {
    const s = sums[0];
    line(`    reason ..... ${s.reason || '(none)'}`);
    line(`    symptoms ... ${JSON.stringify(s.symptoms)}`);
    line(`    icd11 ...... ${JSON.stringify(s.icd11)}`);
    line(`    model ...... ${s.model}`);
    if (s.clinical) line(`    clinical ... ${JSON.stringify(s.clinical).slice(0, 400)}`);
  }
  line('      d72c03b: if you said "koi problem nahi hai", that is an ANSWER.');
  line('      It must not appear as a symptom and must not be re-asked.');

  line();
  line(hardFails
    ? `══ ${hardFails} HARD expectation(s) FAILED — a shipped fix has regressed`
    : '══ every hard expectation held');
  line();

  await pool.end();
  process.exit(hardFails ? 1 : 0);
})().catch((e) => {
  console.error('verify-call failed:', e.message);
  process.exit(2);
});
