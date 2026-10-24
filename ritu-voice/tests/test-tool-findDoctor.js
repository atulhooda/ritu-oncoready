#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for tools/findDoctor.js
//
// All 7 cases the user requested, exercising the seeded Sai Shradha clinic
// roster on an in-memory Postgres (pg-mem). `currentDatetime` is pinned in
// the test context so day-of-week-sensitive assertions are deterministic.
//
// Run: node test-tool-findDoctor.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha } = require('../tools/testHelpers/setupDb');
const { execute: findDoctor } = require('../tools/findDoctor');

// Pinned dates for deterministic day-of-week assertions (IST).
//   2026-05-26 (Tuesday)  — Dr. Nikam walk-in day, Bhosale on, Patwardhan on
//   2026-05-25 (Monday)   — Bhosale on, Nikam OFF
const TUESDAY_AT_NOON  = '2026-05-26T12:00:00+05:30';
const MONDAY_AT_NOON   = '2026-05-25T12:00:00+05:30';

let pass = 0, fail = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push({ name, detail });
  }
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  await seedSaiShradha(pool, clinicId);

  // ─── Case 1: symptom maps to in-house doctor on their day ──────────────
  console.log('\n[1] Symptom maps to in-house doctor on their day');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    const r = await findDoctor({ symptom: 'mujhe knee mein dard hai' }, ctx);
    const nikam = r.doctors.find(d => d.name === 'Dr. Sunil Nikam');
    assert('returns Dr. Nikam',                !!nikam, `got ${r.doctors.map(d=>d.name).join(', ')}`);
    assert('today_available=true on Tuesday',  nikam && nikam.today_available === true);
    assert('walk_in=true',                     nikam && nikam.walk_in === true);
    assert('matched_via=symptom',              r.matched_via === 'symptom');
  }

  // ─── Case 2: symptom maps to in-house doctor NOT on their day ──────────
  console.log('\n[2] Symptom maps to in-house doctor NOT on their day');
  {
    const ctx = { pool, clinicId, currentDatetime: MONDAY_AT_NOON };
    const r = await findDoctor({ symptom: 'ghutne ka dard' }, ctx);
    const nikam = r.doctors.find(d => d.name === 'Dr. Sunil Nikam');
    assert('returns Dr. Nikam',               !!nikam);
    assert('today_available=false on Monday', nikam && nikam.today_available === false);
    assert('next_available_day populated',    nikam && nikam.next_available_day && nikam.next_available_day.day_name === 'Tuesday', `got ${JSON.stringify(nikam && nikam.next_available_day)}`);
    // The LLM must propose a REAL slot, not guess — so next_available_day carries
    // the day's actual hours + a concrete start time.
    assert('next_available_day has hours',         nikam && nikam.next_available_day && /\d/.test(nikam.next_available_day.hours || ''), `got ${JSON.stringify(nikam && nikam.next_available_day)}`);
    assert('next_available_day has suggested_time', nikam && nikam.next_available_day && /^\d{1,2}:\d{2}/.test(nikam.next_available_day.suggested_time || ''), `got ${JSON.stringify(nikam && nikam.next_available_day)}`);
  }

  // ─── Case 3: symptom maps to on-call specialty ──────────────────────────
  console.log('\n[3] Symptom maps to on-call specialty (urology)');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    const r = await findDoctor({ symptom: 'prostate problem hai' }, ctx);
    assert('returns at least one doctor',  r.doctors.length > 0, `got 0 doctors`);
    const oncall = r.doctors.find(d => d.is_on_call === true);
    assert('marks doctor as is_on_call=true', !!oncall, `got ${r.doctors.map(d=>d.name+':oc='+d.is_on_call).join(', ')}`);
    assert('today_available=false for on-call', oncall && oncall.today_available === false);
  }

  // ─── Case 4: patient names a specific doctor ────────────────────────────
  console.log('\n[4] Patient names a specific doctor');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    const r = await findDoctor({ doctor_name: 'Dr. Bhosale', symptom: 'fever' }, ctx);
    assert('returns Dr. Bhosale (name beats symptom)',
      r.doctors.length === 1 && r.doctors[0].name === 'Dr. Priyanka Bhosale',
      `got ${r.doctors.map(d=>d.name).join(', ')}`);
    assert('matched_via=doctor_name', r.matched_via === 'doctor_name');
  }

  // ─── Case 5: vague symptom — generic catch-all ──────────────────────────
  console.log('\n[5] Vague symptom that could match multiple');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    // "fever" is in the Internal Medicine catch-all bucket.
    const r = await findDoctor({ symptom: 'mujhe fever hai' }, ctx);
    const patwardhan = r.doctors.find(d => d.name === 'Dr. Kapil Patwardhan');
    assert('returns Dr. Patwardhan (Internal Medicine)', !!patwardhan, `got ${r.doctors.map(d=>d.name).join(', ')}`);
    assert('today_available=true on Tuesday', patwardhan && patwardhan.today_available === true);
  }

  // ─── Case 6: no match found ─────────────────────────────────────────────
  console.log('\n[6] No match found');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    const r = await findDoctor({ symptom: 'plumbing issue hai' }, ctx);
    assert('returns empty doctors array', r.doctors.length === 0, `got ${r.doctors.length}`);
    assert('matched_via=null',            r.matched_via === null);
    assert('hint mentions callback',      r.hint && /callback/i.test(r.hint));
  }

  // ─── Case 7: English specialty term ─────────────────────────────────────
  console.log('\n[7] Patient says English specialty');
  {
    const ctx = { pool, clinicId, currentDatetime: TUESDAY_AT_NOON };
    const r = await findDoctor({ specialty: 'orthopedic doctor' }, ctx);
    const nikam = r.doctors.find(d => d.name === 'Dr. Sunil Nikam');
    assert('returns Dr. Nikam via specialty',  !!nikam);
    assert('matched_via=specialty',            r.matched_via === 'specialty');
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  } else {
    console.log('\n✓ All findDoctor tests passing.');
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
