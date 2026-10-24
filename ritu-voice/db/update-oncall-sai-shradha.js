// ─── Update Sai Shradha on-call specialists to real names ────────────────────
// The clinic provided real on-call doctor names (some specialties have >1).
// This brings the LIVE DB in line with the seed: for each specialty it inserts
// the real doctors and removes any stale on-call entry (the old "On-call X"
// placeholders, "Dr. TBD", etc.) that isn't in the real list.
//
// Idempotent — safe to re-run (and safe to re-run after the seed changes).
//
// Run once against the clinic DB:
//   DATABASE_URL=<clinic-db-url> node db/update-oncall-sai-shradha.js

const { Pool } = require('pg');
const config = require('../config');

const ONCALL = [
  ['Neurology',  ['Dr. Sanjay Pawar']],
  ['Nephrology', ['Dr. Rakesh Shinde']],
  ['Urology',    ['Dr. Kalpesh Saswade']],
  ['Pediatric',  ['Dr. Santosh Kait', 'Dr. Shivraj Babbane']],
  ['Anesthesia', ['Dr. Mahavan', 'Dr. Rana Patil']],
  ['Surgery',    ['Dr. Ranbagale', 'Dr. Amol Muley', 'Dr. Preetam Kadam']],
];

async function run(pool, clinicId) {
  for (const [specialty, names] of ONCALL) {
    const desired = new Set(names);
    const { rows: existing } = await pool.query(
      `SELECT id, name FROM doctors WHERE clinic_id = $1 AND specialty = $2 AND is_on_call = true`,
      [clinicId, specialty]
    );
    const have = new Set(existing.map((d) => d.name));

    // Remove any on-call doctor for this specialty that's not in the real list.
    for (const d of existing) {
      if (desired.has(d.name)) continue;
      // Detach any callback pointing at it first (avoid FK error), then delete.
      await pool.query(`UPDATE callbacks SET doctor_id = NULL WHERE doctor_id = $1`, [d.id]).catch(() => {});
      try {
        await pool.query(`DELETE FROM doctors WHERE id = $1`, [d.id]);
        console.log(`  - removed stale: ${specialty} / ${d.name}`);
      } catch (e) {
        console.warn(`  (kept ${specialty} / ${d.name}: ${e.message})`);
      }
    }

    // Insert any real doctor that's missing.
    for (const name of names) {
      if (have.has(name)) continue;
      await pool.query(
        `INSERT INTO doctors (clinic_id, name, specialty, is_on_call, fee_inr, notes)
         VALUES ($1, $2, $3, true, NULL, 'On-call specialist')`,
        [clinicId, name, specialty]
      );
      console.log(`  + added: ${specialty} / ${name}`);
    }
  }
}

if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL not set. Refusing to run.'); process.exit(1); }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let clinicId = config.clinicId;
    if (!clinicId) {
      const { rows } = await pool.query(`SELECT id FROM clinics ORDER BY created_at LIMIT 1`);
      clinicId = rows[0] && rows[0].id;
    }
    if (!clinicId) { console.error('✗ No clinic found.'); process.exit(1); }
    console.log(`Updating on-call doctors for clinic ${clinicId}…`);
    await run(pool, clinicId);
    await pool.end();
    console.log('✓ Done.');
    process.exit(0);
  })().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { run, ONCALL };
