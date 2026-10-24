#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Sample trial data — a few patients + one future appointment, so smoke
// tests have something to look up / a returning caller to greet by name.
// Run AFTER db:migrate + db:seed.  Idempotent (skips if patients exist).
//
//   node db/seed-sample-patients.js   (or: npm run db:seed:sample)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');

const CLINIC_NAME = 'Sai Shradha Health Care Centre';

// Includes a Devanagari name to confirm Indic names round-trip clean in the DB.
const SAMPLE_PATIENTS = [
  { phone: '9820011111', name: 'Rahul Deshpande' },
  { phone: '9820022222', name: 'प्रिया शर्मा' },
  { phone: '9820033333', name: 'Imran Shaikh' }
];

async function main() {
  if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: [clinic] } = await pool.query(`SELECT id FROM clinics WHERE name = $1 LIMIT 1`, [CLINIC_NAME]);
    if (!clinic) { console.error(`✗ Clinic "${CLINIC_NAME}" not found — run db:seed first.`); process.exit(1); }

    const existing = await pool.query(`SELECT COUNT(*)::int n FROM patients WHERE clinic_id = $1`, [clinic.id]);
    if (existing.rows[0].n > 0) {
      console.log(`✓ Patients already present (${existing.rows[0].n}). Skipping sample seed.`);
      return;
    }

    for (const p of SAMPLE_PATIENTS) {
      await pool.query(
        `INSERT INTO patients (clinic_id, phone, name) VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, phone, name) DO NOTHING`,
        [clinic.id, p.phone, p.name]
      );
      console.log(`  ✓ patient ${p.name} (${p.phone})`);
    }

    // One future appointment for Rahul with Dr. Bhosale, so the
    // "appointment lookup" smoke call retrieves a real row. NOW()+2d keeps it
    // future regardless of the server clock.
    const { rows: [pt] } = await pool.query(
      `SELECT id FROM patients WHERE clinic_id=$1 AND phone='9820011111' LIMIT 1`, [clinic.id]);
    const { rows: [doc] } = await pool.query(
      `SELECT id FROM doctors WHERE clinic_id=$1 AND name='Dr. Priyanka Bhosale' LIMIT 1`, [clinic.id]);
    if (pt && doc) {
      // Clean slot: 2 days out at 15:00 IST (matches Bhosale's schedule, and
      // reads professionally on the lookup smoke call — not a random seed time).
      await pool.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source)
         VALUES ($1, $2, $3,
                 (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '2 days' + INTERVAL '15 hours') AT TIME ZONE 'Asia/Kolkata',
                 'follow-up', 'booked', 'sample')`,
        [clinic.id, pt.id, doc.id]
      );
      console.log(`  ✓ sample appointment: Rahul Deshpande → Dr. Bhosale (+2 days)`);
    }

    console.log('\n✓ Sample data seeded.');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
