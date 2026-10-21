#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Seed: Smile Dental Clinic — LEAN-MODE DEMO
//
// A small, realistic dental clinic for the lean-mode demo (CLINIC_MODE=lean).
// Two dentists, no symptom-mapping ambiguity — exactly the case lean mode shines:
//   Dr. Anjali Deshmukh   — Dentist (General)   Mon-Sat, 10-2 & 5-8, ₹300
//   Dr. Rohan Kulkarni    — Orthodontist        Tue/Thu/Sat 11-2, ₹500
//
// Uses a FIXED clinic id so the demo deployment can hardcode CLINIC_ID_UUID.
// Idempotent: re-running is safe (skips if the clinic already exists).
//
// Run:  node db/seed-dental-demo.js
// Then deploy with:
//   CLINIC_ID_UUID=de00de00-de00-4de0-8de0-de00de00de01
//   CLINIC_MODE=lean
//   LLM_PRIMARY_PROVIDER=gemini
//   CLINIC_GREETING_NAME=स्माईल डेंटल क्लिनिक
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');

const CLINIC_ID   = 'de00de00-de00-4de0-8de0-de00de00de01'; // fixed → set as CLINIC_ID_UUID
const CLINIC_NAME = 'Smile Dental Clinic';
const TIMEZONE    = 'Asia/Kolkata';

// day_of_week: 0=Sun, 1=Mon, … 6=Sat
const DOCTORS = [
  {
    name: 'Dr. Anjali Deshmukh',
    specialty: 'Dentist',
    fee_inr: 300,
    is_on_call: false,
    notes: 'General dentistry — checkup, cleaning, fillings, extraction, root canal.',
    // Mon-Sat, two sessions a day (morning + evening).
    schedules: [1, 2, 3, 4, 5, 6].flatMap(d => [
      { day_of_week: d, start_time: '10:00', end_time: '14:00', is_walk_in: false },
      { day_of_week: d, start_time: '17:00', end_time: '20:00', is_walk_in: false }
    ])
  },
  {
    name: 'Dr. Rohan Kulkarni',
    specialty: 'Orthodontist',
    fee_inr: 500,
    is_on_call: false,
    notes: 'Braces, aligners, teeth alignment.',
    schedules: [2, 4, 6].map(d => ({
      day_of_week: d, start_time: '11:00', end_time: '14:00', is_walk_in: false
    }))
  }
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const existing = await pool.query(`SELECT id FROM clinics WHERE id = $1 LIMIT 1`, [CLINIC_ID]);
    if (existing.rows.length > 0) {
      console.log(`✓ Dental demo clinic already seeded (id=${CLINIC_ID}). Skipping.`);
      return CLINIC_ID;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO clinics (id, name, timezone) VALUES ($1, $2, $3)`,
        [CLINIC_ID, CLINIC_NAME, TIMEZONE]
      );
      console.log(`✓ Clinic created: ${CLINIC_NAME} (${CLINIC_ID})`);

      for (const doc of DOCTORS) {
        const { rows: [d] } = await client.query(
          `INSERT INTO doctors (clinic_id, name, specialty, is_on_call, fee_inr, notes)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [CLINIC_ID, doc.name, doc.specialty, doc.is_on_call, doc.fee_inr, doc.notes]
        );
        for (const s of (doc.schedules || [])) {
          await client.query(
            `INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_walk_in, notes)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [d.id, s.day_of_week, s.start_time, s.end_time, s.is_walk_in || false, s.notes || null]
          );
        }
        console.log(`  ✓ ${doc.name.padEnd(24)} ${doc.specialty.padEnd(14)} [${(doc.schedules || []).length} schedule rows]`);
      }

      await client.query('COMMIT');
      console.log(`\n✓ Dental demo seeded. Deploy with:`);
      console.log(`    CLINIC_ID_UUID=${CLINIC_ID}`);
      console.log(`    CLINIC_MODE=lean`);
      console.log(`    LLM_PRIMARY_PROVIDER=gemini`);
      console.log(`    CLINIC_GREETING_NAME=स्माईल डेंटल क्लिनिक`);
      return CLINIC_ID;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('✗ Dental seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) seed();
module.exports = { seed, CLINIC_ID, CLINIC_NAME };
