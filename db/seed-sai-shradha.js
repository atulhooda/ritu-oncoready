#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Seed: Sai Shradha Health Care Centre
//
// Inserts the first clinic + roster from the user's intake notes:
//   In-house (with regular schedules):
//     Dr. Vikas Gaikwad     — Director / General  (all 7 days 15:00-18:00)
//     Dr. Sunil Nikam       — Orthopedic          (Tue/Thu/Sat walk-in)
//     Dr. Priyanka Bhosale  — Gynecology          (Mon-Fri 15:00-16:30)
//     Dr. Kapil Patwardhan  — Internal Medicine   (Mon-Fri 18:30-20:30)
//   On-call (is_on_call=true, no schedule rows):
//     Neurology, Nephrology, Urology, Pediatric, Anesthesia, Surgery
//
// The on-call doctor names are placeholders ("On-call Neurologist", etc.)
// since the receptionist hasn't sent real names yet. Update via SQL once
// they arrive. Ritu doesn't speak the on-call doctor's *name* aloud anyway
// — the system prompt has her say "Hum [specialty] doctor se callback
// karayenge", so the placeholder is patient-invisible.
//
// Idempotent: skips if the clinic already exists. Re-running is safe.
//
// Run:   node db/seed-sai-shradha.js
//   or:  npm run db:seed
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');

const CLINIC_NAME = 'Sai Shradha Health Care Centre';
const TIMEZONE    = 'Asia/Kolkata';

// day_of_week: 0=Sun, 1=Mon, … 6=Sat
const DOCTORS = [
  {
    name: 'Dr. Vikas Gaikwad',
    specialty: 'General',
    fee_inr: null,
    is_on_call: false,
    notes: 'Director — available all 7 days.',
    schedules: [0, 1, 2, 3, 4, 5, 6].map(d => ({
      day_of_week: d,
      start_time: '15:00',
      end_time:   '18:00',
      is_walk_in: false
    }))
  },
  {
    name: 'Dr. Sunil Nikam',
    specialty: 'Orthopedic',
    fee_inr: 500,
    is_on_call: false,
    notes: 'Walk-in only on Tue/Thu/Sat. No prior appointment needed.',
    schedules: [
      // Time placeholders — receptionist to confirm exact walk-in hours.
      { day_of_week: 2, start_time: '10:00', end_time: '13:00', is_walk_in: true, notes: 'Walk-in' },
      { day_of_week: 4, start_time: '10:00', end_time: '13:00', is_walk_in: true, notes: 'Walk-in' },
      { day_of_week: 6, start_time: '10:00', end_time: '13:00', is_walk_in: true, notes: 'Walk-in' }
    ]
  },
  {
    name: 'Dr. Priyanka Bhosale',
    specialty: 'Gynecology',
    fee_inr: 700,
    is_on_call: false,
    notes: null,
    schedules: [1, 2, 3, 4, 5].map(d => ({
      day_of_week: d,
      start_time: '15:00',
      end_time:   '16:30',
      is_walk_in: false
    }))
  },
  {
    name: 'Dr. Kapil Patwardhan',
    specialty: 'Internal Medicine',
    fee_inr: 800,
    is_on_call: false,
    notes: null,
    schedules: [1, 2, 3, 4, 5].map(d => ({
      day_of_week: d,
      start_time: '18:30',
      end_time:   '20:30',
      is_walk_in: false
    }))
  },

  // ─── On-call specialists ────────────────────────────────────────────────
  // No schedule rows. is_on_call=true. Ritu uses these via request_callback,
  // not book_appointment. Real names provided by the clinic (some specialties
  // have more than one on-call doctor).
  { name: 'Dr. Sanjay Pawar',    specialty: 'Neurology',  is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Rakesh Shinde',   specialty: 'Nephrology', is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Kalpesh Saswade', specialty: 'Urology',    is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Santosh Kait',    specialty: 'Pediatric',  is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Shivraj Babbane', specialty: 'Pediatric',  is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Mahavan',         specialty: 'Anesthesia', is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Rana Patil',      specialty: 'Anesthesia', is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Ranbagale',       specialty: 'Surgery',    is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Amol Muley',      specialty: 'Surgery',    is_on_call: true, fee_inr: null, notes: 'On-call specialist' },
  { name: 'Dr. Preetam Kadam',   specialty: 'Surgery',    is_on_call: true, fee_inr: null, notes: 'On-call specialist' }
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Idempotent: skip if the clinic already exists.
    const existing = await pool.query(
      `SELECT id FROM clinics WHERE name = $1 LIMIT 1`,
      [CLINIC_NAME]
    );
    if (existing.rows.length > 0) {
      console.log(`✓ Clinic "${CLINIC_NAME}" already seeded (id=${existing.rows[0].id}). Skipping.`);
      return existing.rows[0].id;
    }

    // Wrap the seed in a transaction so a partial failure doesn't leave a
    // half-populated clinic.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [clinic] } = await client.query(
        `INSERT INTO clinics (name, timezone) VALUES ($1, $2) RETURNING id`,
        [CLINIC_NAME, TIMEZONE]
      );
      console.log(`✓ Clinic created: ${CLINIC_NAME} (${clinic.id})`);

      for (const doc of DOCTORS) {
        const { rows: [d] } = await client.query(
          `INSERT INTO doctors (clinic_id, name, specialty, is_on_call, fee_inr, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [clinic.id, doc.name, doc.specialty, doc.is_on_call, doc.fee_inr, doc.notes]
        );

        const schedules = doc.schedules || [];
        for (const s of schedules) {
          await client.query(
            `INSERT INTO doctor_schedules
               (doctor_id, day_of_week, start_time, end_time, is_walk_in, notes)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [d.id, s.day_of_week, s.start_time, s.end_time, s.is_walk_in || false, s.notes || null]
          );
        }

        const label = doc.is_on_call ? '[on-call]' : `[${schedules.length} schedule row${schedules.length === 1 ? '' : 's'}]`;
        console.log(`  ✓ ${doc.name.padEnd(28)} ${doc.specialty.padEnd(20)} ${label}`);
      }

      await client.query('COMMIT');
      console.log(`\n✓ Seed complete. Clinic ID: ${clinic.id}`);
      console.log(`  Set SAI_SHRADHA_CLINIC_ID=${clinic.id} in .env if any callsite needs the literal.`);
      return clinic.id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seed().catch(err => {
    console.error('\nFATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { seed };
