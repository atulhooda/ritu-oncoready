#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// SKIN ESSENCE COSMETIC AND LASER CENTER, AHMEDABAD — the clinic's own rows.
//
// docs/SKIN_ESSENCE_SPEC.md "Seed + env + cutover": one clinic row, two
// doctors, 24 schedule rows (Mon–Sat, 10:30–14:00 and 16:00–20:00, Dr. Jigisha's
// evening window ending 19:00), five treatments with wart and tattoo removal
// NOT quotable (disclose_price=false — Ritu says the doctor will tell you), the
// clinic holidays as 'closed' exceptions for both doctors, the follow-up policy
// (free within 5 days, then ₹400) and the default doctor. Capacity is 1 per
// slot (D9) and the 10-minute grid comes from APPOINTMENT_SLOT_MINUTES=10 —
// neither is a row here.
//
// IDEMPOTENT by fixed ids and natural keys: run it as often as you like; the
// second run changes nothing. It never touches another clinic's rows.
//
//   DATABASE_URL=<the Skin Essence database> node db/seed-skin-essence.js
//
// The FAQ row (form section E3, "parking") is inserted only once its text is
// filled in below — a placeholder must never be spoken to a patient.
// ═══════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

const CLINIC_ID = '5e55e11c-0a1d-4b7e-9c3f-5c1de55e0001';   // fixed — goes into CLINIC_ID_UUID on both services
const DAKSHA_ID  = '5e55e11c-0a1d-4b7e-9c3f-5c1de55e0011';
const JIGISHA_ID = '5e55e11c-0a1d-4b7e-9c3f-5c1de55e0012';

const CLINIC = { name: 'Skin Essence Cosmetic and Laser Center', timezone: 'Asia/Kolkata', followup_free_days: 5, followup_fee_inr: 400 };
const DOCTORS = [
  { id: DAKSHA_ID,  name: 'Dr. Daksha Patel',   specialty: 'Dermatologist', fee_inr: 700, notes: 'Cosmetic and laser dermatology. Default doctor when the caller names none.', evening_end: '20:00' },
  { id: JIGISHA_ID, name: 'Dr. Jigisha Parekh', specialty: 'Dermatologist', fee_inr: 700, notes: 'Evening window ends 19:00 (form D2).', evening_end: '19:00' },
];
const WINDOWS = (eveningEnd) => [['10:30', '14:00'], ['16:00', eveningEnd]];   // lunch 14:00–16:00
const DAYS = [1, 2, 3, 4, 5, 6];                                               // Mon–Sat; Sunday closed
const TREATMENTS = [
  { name: 'Chemical peel',  category: 'Peels',            price_min: 1500, price_max: null, disclose_price: true },
  { name: 'Hydrafacial',    category: 'Facials',          price_min: 3000, price_max: null, disclose_price: true },
  { name: 'Wart removal',   category: 'Minor procedures', price_min: 1500, price_max: 5000, disclose_price: false },   // "doctor dekh kar batayenge"
  { name: 'Tattoo removal', category: 'Laser',            price_min: 1500, price_max: 3000, disclose_price: false },
  { name: 'Cryolipolysis',  category: 'Body contouring',  price_min: 3500, price_max: null, disclose_price: true },
];
const HOLIDAYS = ['2026-08-28', '2026-09-04', '2026-10-20'];   // form: Raksha Bandhan, Ganesh, Diwali-week closure; past dates are skipped at run time
const FAQ_PARKING = { question: 'Parking / પાર્કિંગ', answer: null };   // fill from the form's E3 line (gu + en); null = not seeded

async function seed(pool, { today = new Date().toISOString().slice(0, 10), log = console.log } = {}) {
  const client = await pool.connect();
  const out = { clinic: 0, doctors: 0, schedules: 0, treatments: 0, exceptions: 0, faqs: 0, skippedHolidays: [] };
  try {
    await client.query('BEGIN');
    // clinic — fixed id; the policy columns are set on every run so a spec change lands
    const c = await client.query('SELECT id FROM clinics WHERE id = $1', [CLINIC_ID]);
    if (!c.rows.length) { await client.query('INSERT INTO clinics (id, name, timezone) VALUES ($1, $2, $3)', [CLINIC_ID, CLINIC.name, CLINIC.timezone]); out.clinic = 1; }
    // doctors — fixed ids
    for (const d of DOCTORS) {
      const r = await client.query('SELECT id FROM doctors WHERE id = $1', [d.id]);
      if (!r.rows.length) { await client.query('INSERT INTO doctors (id, clinic_id, name, specialty, is_on_call, fee_inr, notes) VALUES ($1, $2, $3, $4, FALSE, $5, $6)', [d.id, CLINIC_ID, d.name, d.specialty, d.fee_inr, d.notes]); out.doctors++; }
      // schedules — these two doctors' rows are THE spec's rows: replace, never accumulate
      await client.query('DELETE FROM doctor_schedules WHERE doctor_id = $1', [d.id]);
      for (const dow of DAYS) for (const [start, end] of WINDOWS(d.evening_end)) {
        await client.query('INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_walk_in) VALUES ($1, $2, $3, $4, FALSE)', [d.id, dow, start, end]);
        out.schedules++;
      }
      // holidays — 'closed' for the whole day; a date already behind us is nobody's business
      for (const date of HOLIDAYS) {
        if (date < today) { if (!out.skippedHolidays.includes(date)) out.skippedHolidays.push(date); continue; }
        const e = await client.query("SELECT id FROM doctor_exceptions WHERE doctor_id = $1 AND exception_date = $2 AND exception_type = 'closed'", [d.id, date]);
        if (!e.rows.length) { await client.query("INSERT INTO doctor_exceptions (doctor_id, exception_date, exception_type, notes) VALUES ($1, $2, 'closed', 'Clinic holiday (setup form)')", [d.id, date]); out.exceptions++; }
      }
    }
    await client.query('UPDATE clinics SET followup_free_days = $2, followup_fee_inr = $3, default_doctor_id = $4 WHERE id = $1', [CLINIC_ID, CLINIC.followup_free_days, CLINIC.followup_fee_inr, DAKSHA_ID]);
    // treatments — natural key (clinic, name); prices and the disclose flag are set explicitly on every run
    for (const t of TREATMENTS) {
      const r = await client.query('SELECT id FROM treatments WHERE clinic_id = $1 AND name = $2', [CLINIC_ID, t.name]);
      if (r.rows.length) await client.query('UPDATE treatments SET category = $3, price_min = $4, price_max = $5, price_unit = $6, disclose_price = $7, active = TRUE WHERE clinic_id = $1 AND name = $2', [CLINIC_ID, t.name, t.category, t.price_min, t.price_max, 'session', t.disclose_price]);
      else { await client.query('INSERT INTO treatments (clinic_id, name, category, price_min, price_max, price_unit, disclose_price, active) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)', [CLINIC_ID, t.name, t.category, t.price_min, t.price_max, 'session', t.disclose_price]); out.treatments++; }
    }
    // FAQ — only with real text
    if (FAQ_PARKING.answer) {
      const f = await client.query('SELECT id FROM clinic_faqs WHERE clinic_id = $1 AND question = $2', [CLINIC_ID, FAQ_PARKING.question]);
      if (f.rows.length) await client.query('UPDATE clinic_faqs SET answer = $3, active = TRUE, updated_at = NOW() WHERE clinic_id = $1 AND question = $2', [CLINIC_ID, FAQ_PARKING.question, FAQ_PARKING.answer]);
      else { await client.query('INSERT INTO clinic_faqs (clinic_id, question, answer, sort_order, active) VALUES ($1, $2, $3, 0, TRUE)', [CLINIC_ID, FAQ_PARKING.question, FAQ_PARKING.answer]); out.faqs++; }
    } else log('  ⚠ FAQ "parking" not seeded — FAQ_PARKING.answer is empty; fill it from the form (E3) and re-run');
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL is not set. Refusing to run.'); process.exit(1); }
  if (/acela\.proxy\.rlwy\.net/.test(process.env.DATABASE_URL)) { console.error('✗ That is the DEMO database. This seed is for the Skin Essence database only.'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false } });
  try {
    const out = await seed(pool);
    console.log(`✓ Skin Essence seeded: clinic ${out.clinic ? 'created' : 'already present'}, +${out.doctors} doctors, ${out.schedules} schedule rows set, +${out.treatments} treatments, +${out.exceptions} holiday rows, +${out.faqs} FAQ rows` + (out.skippedHolidays.length ? ` (past holidays skipped: ${out.skippedHolidays.join(', ')})` : ''));
    console.log(`\n  CLINIC_ID_UUID=${CLINIC_ID}   ← set this on BOTH the voice server and the desk`);
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
module.exports = { seed, CLINIC_ID, DAKSHA_ID, JIGISHA_ID, TREATMENTS, HOLIDAYS };
