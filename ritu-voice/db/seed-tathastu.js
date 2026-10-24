#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// TATHASTU CLINIC AND REJUVENATE CENTRE, PUNE (railway-station branch) — the
// clinic's own rows, from the setup form received 2026-09-15.
//
// One clinic row (locale en, short name Tathastu, Pune); Dr. Hrishikesh Mahadik
// (functional and regenerative medicine, Monday to Sunday 10:00–20:00, ₹500,
// the default doctor — the form names no other) and Dr. Suhas Kalshetty
// ("on visiting" → on-call: Ritu takes a callback request, never books a slot,
// ₹800); the parking/floor FAQ from Part A; no treatments (B2 empty), no
// holidays (A5 empty), no follow-up policy (Q31 blank). Part C (emergency) is
// deferred by the founder's decision; the slot length comes from
// APPOINTMENT_SLOT_MINUTES=30 (Q44 blank), not a row here.
//
// IDEMPOTENT by fixed ids and natural keys: run it as often as you like; the
// second run changes nothing. It never touches another clinic's rows.
//
//   DATABASE_URL=<the Tathastu database> node db/seed-tathastu.js
// ═══════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

const CLINIC_ID     = '7a7ba570-c11c-4b00-9000-7a7ba5700001';   // fixed — goes into CLINIC_ID_UUID on both services
const HRISHIKESH_ID = '7a7ba570-c11c-4b00-9000-7a7ba5700011';
const SUHAS_ID      = '7a7ba570-c11c-4b00-9000-7a7ba5700012';

const CLINIC = { name: 'Tathastu Clinic and Rejuvenate Centre', short_name: 'Tathastu', city: 'Pune', locale: 'en', timezone: 'Asia/Kolkata' };
const DOCTORS = [
  { id: HRISHIKESH_ID, name: 'Dr. Hrishikesh Mahadik', specialty: 'Functional and regenerative medicine', fee_inr: 500, is_on_call: false,
    notes: 'Default doctor when the caller names none (form Q27 blank). Monday to Sunday 10:00–20:00 (form B1).', windows: [['10:00', '20:00']], days: [0, 1, 2, 3, 4, 5, 6] },
  { id: SUHAS_ID, name: 'Dr. Suhas Kalshetty', specialty: 'Intensivist, cardiology and medicine', fee_inr: 800, is_on_call: true,
    notes: 'Visiting doctor (form B1 "on visiting"): callback request, no fixed slots.', windows: [], days: [] },
];
const FAQS = [
  { question: 'Parking / पार्किंग', answer: 'Yes, there is car and bike parking. The clinic is on the second floor and there is a lift.', sort_order: 0 },
  { question: 'Where is the clinic? / पत्ता', answer: 'Brahma Boulevard, Sadhu Vaswani Chowk, near Pune railway station, opposite Vijay Sales, second floor.', sort_order: 1 },
];

async function seed(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  const out = { clinic: 0, doctors: 0, schedules: 0, faqs: 0 };
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT id FROM clinics WHERE id = $1', [CLINIC_ID]);
    if (!c.rows.length) { await client.query('INSERT INTO clinics (id, name, timezone) VALUES ($1, $2, $3)', [CLINIC_ID, CLINIC.name, CLINIC.timezone]); out.clinic = 1; }
    // identity columns from migration 019 — set on every run so a form correction lands
    await client.query('UPDATE clinics SET name = $2, short_name = $3, city = $4, locale = $5 WHERE id = $1',
      [CLINIC_ID, CLINIC.name, CLINIC.short_name, CLINIC.city, CLINIC.locale]);
    for (const d of DOCTORS) {
      const r = await client.query('SELECT id FROM doctors WHERE id = $1', [d.id]);
      if (!r.rows.length) {
        await client.query('INSERT INTO doctors (id, clinic_id, name, specialty, is_on_call, fee_inr, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [d.id, CLINIC_ID, d.name, d.specialty, d.is_on_call, d.fee_inr, d.notes]);
        out.doctors++;
      } else {
        await client.query('UPDATE doctors SET name = $2, specialty = $3, is_on_call = $4, fee_inr = $5, active = TRUE WHERE id = $1', [d.id, d.name, d.specialty, d.is_on_call, d.fee_inr]);
      }
      // schedules — the form's rows: replace, never accumulate
      await client.query('DELETE FROM doctor_schedules WHERE doctor_id = $1', [d.id]);
      for (const dow of d.days) for (const [start, end] of d.windows) {
        await client.query('INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_walk_in) VALUES ($1, $2, $3, $4, FALSE)', [d.id, dow, start, end]);
        out.schedules++;
      }
    }
    // the default doctor AFTER the doctor rows exist (clinics_default_doctor_id_fkey — the first live run failed here)
    await client.query('UPDATE clinics SET default_doctor_id = $2 WHERE id = $1', [CLINIC_ID, HRISHIKESH_ID]);
    for (const f of FAQS) {
      const r = await client.query('SELECT id FROM clinic_faqs WHERE clinic_id = $1 AND question = $2', [CLINIC_ID, f.question]);
      if (r.rows.length) await client.query('UPDATE clinic_faqs SET answer = $3, sort_order = $4, active = TRUE, updated_at = NOW() WHERE clinic_id = $1 AND question = $2', [CLINIC_ID, f.question, f.answer, f.sort_order]);
      else { await client.query('INSERT INTO clinic_faqs (clinic_id, question, answer, sort_order, active) VALUES ($1, $2, $3, $4, TRUE)', [CLINIC_ID, f.question, f.answer, f.sort_order]); out.faqs++; }
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL is not set. Refusing to run.'); process.exit(1); }
  if (/acela\.proxy\.rlwy\.net|roundhouse\.proxy\.rlwy\.net/.test(process.env.DATABASE_URL)) { console.error('✗ That is the DEMO database. This seed is for the Tathastu database only.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false } });
  try {
    const out = await seed(pool);
    console.log(`✓ Tathastu seeded: clinic ${out.clinic ? 'created' : 'already present'}, +${out.doctors} doctors, ${out.schedules} schedule rows set, +${out.faqs} FAQs`);
    console.log(`\n  CLINIC_ID_UUID=${CLINIC_ID}   ← set this on BOTH the voice server and the desk`);
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
module.exports = { seed, CLINIC_ID, HRISHIKESH_ID, SUHAS_ID, DOCTORS, FAQS };
