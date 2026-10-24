#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// "HOW MUCH IS IT?" AND "WHICH DOCTOR?" — THE TWO QUESTIONS ALL DAY.
//
// doctors.fee_inr holds ONE number. Skin Essence's form gives two: ₹700 for a
// first visit, free within five days, ₹400 after. There was nowhere to put the
// second, and writing it into doctors.notes would have been invisible —
// getDoctorsRoster SELECTs id, name, specialty, fee_inr, is_on_call and nothing
// else, so a prompt cannot render it. That is the defect class where a feature
// exists and never fires, and it is why this needed a column rather than a
// sentence in a notes field.
//
// The default doctor is the clinic's decision, not the model's: with two
// doctors, silence is a coin flip on every call, and the form names Dr. Daksha
// Patel for callers who express no preference.
//
// THE BLOCK IS BUILT IN CODE, like the roster and the treatments list, because
// a fee the model paraphrases is a fee it can get wrong — and this one is
// quoted to someone who will hold the clinic to it.
//
// NULL MEANS "NOT ASKED", AND STAYS DIFFERENT FROM ZERO. A clinic with
// followup_fee_inr = 0 is saying follow-ups are free. A clinic with NULL has
// not been asked, and Ritu says nothing at all.
//
// Run:            node tests/test-fee-policy-block.js
// Prove it fails: MUTANT=MUT-FEE-ALWAYS-RENDER node tests/test-fee-policy-block.js
//                 MUTANT=MUT-NOTES-INSTEAD     node tests/test-fee-policy-block.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

console.log('\nFEE POLICY + DEFAULT DOCTOR\n');

(async () => {

const SRC = fs.readFileSync('brain-lean.js', 'utf8');
const m = SRC.match(/function feePolicyBlock[\s\S]*?\n}/);
assert(m, 'feePolicyBlock is missing');
let feePolicyBlock = new Function(`${m[0]}; return feePolicyBlock;`)();
if (MUTANT === 'MUT-FEE-ALWAYS-RENDER') {
  const real = feePolicyBlock;
  feePolicyBlock = (p) => real(p || { followupFreeDays: 0, followupFeeInr: 0, defaultDoctorName: 'Dr. Someone' });
}

const SKIN_ESSENCE = { followupFreeDays: 5, followupFeeInr: 400, defaultDoctorName: 'Dr. Daksha Patel' };

// ── [1] The deletion test: an unanswered clinic is unchanged ─────────────
ok('a clinic that answered neither question gets NO block', () => {
  assert.strictEqual(feePolicyBlock(null), '',
    'a clinic with no fee policy now carries fee text it never supplied');
});
ok('and its prompt is byte-identical to before this existed', () => {
  const lean = require('../brain-lean.js');
  const p = lean.buildSystemPrompt({}, {});
  assert.doesNotMatch(p, /FEES \/ DEFAULT DOCTOR/,
    'the block renders with no policy loaded — every existing clinic gained a fee section');
});

// ── [2] Skin Essence's actual numbers ────────────────────────────────────
const block = feePolicyBlock(SKIN_ESSENCE);
ok('the follow-up window and fee are both stated', () => {
  assert.match(block, /5 din tak FREE/, block);
  assert.match(block, /₹400/, block);
});
ok('the default doctor is named', () => {
  assert.match(block, /Dr\. Daksha Patel/, block);
});
ok('…but a caller who names another doctor still gets that one', () => {
  assert.match(block, /doosre doctor ka naam le toh usi ke saath/,
    'the default reads as a rule rather than a fallback — a caller asking for Dr. Jigisha would be overridden');
});
ok('the block carries the same no-invention rule as the roster', () => {
  assert.match(block, /apna koi number ya doctor KABHI mat bana/,
    'nothing stops the model extending the fee list');
});

// ── [3] The halves are independent ───────────────────────────────────────
ok('a fee with no default doctor renders only the fee', () => {
  const b = feePolicyBlock({ followupFreeDays: 5, followupFeeInr: 400, defaultDoctorName: null });
  assert.match(b, /₹400/);
  assert.doesNotMatch(b, /kisi doctor ka naam NA le/, 'invented a default doctor line from nothing');
});
ok('a default doctor with no fee renders only the doctor', () => {
  const b = feePolicyBlock({ followupFreeDays: null, followupFeeInr: null, defaultDoctorName: 'Dr. Jigisha Parekh' });
  assert.match(b, /Dr\. Jigisha Parekh/);
  assert.doesNotMatch(b, /₹/, 'a fee appeared for a clinic that gave none');
});

// ── [4] ABSENT vs ZERO ───────────────────────────────────────────────────
ok('₹0 is a real answer — "follow-ups are free" is not the same as unanswered', () => {
  const zero = feePolicyBlock({ followupFreeDays: 5, followupFeeInr: 0, defaultDoctorName: null });
  assert.match(zero, /₹0/, 'a clinic that said follow-ups cost nothing was treated as having said nothing');
  assert.strictEqual(feePolicyBlock({ followupFreeDays: null, followupFeeInr: null, defaultDoctorName: null }), '',
    'an all-null policy rendered a block');
});

// ── [5] The column exists BECAUSE notes is never read ────────────────────
ok('doctors.notes is still not selected — so the policy could not have lived there', () => {
  const db = fs.readFileSync('db.js', 'utf8');
  const i = db.indexOf('async function getDoctorsRoster');
  const sel = db.slice(i, i + 400);
  const notesRead = MUTANT === 'MUT-NOTES-INSTEAD' ? true : /SELECT[^`]*\bnotes\b/.test(sel);
  assert.strictEqual(notesRead, false,
    'getDoctorsRoster now reads notes — if the policy moved there, say so; a column nobody reads is the never-fires defect');
});
// DRIVEN, not grepped. The first version of this asserted that `return null`
// appeared within 240 characters of `catch (err)` in the source — and failed
// because a comment inside the catch pushed it to 272. A distance in a source
// file is not the property; degrading to silence is. So call the real function
// with a pool that throws, which is also what a database without migration 015
// actually does.
const dbmod = require('../db.js');
const realQuery = dbmod.pool.query;
dbmod.pool.query = async () => { const e = new Error('column "followup_fee_inr" does not exist'); e.code = '42703'; throw e; };
const onMissingColumn = await dbmod.getClinicFeePolicy('clinic-1');
dbmod.pool.query = async () => ({ rows: [{ followup_free_days: null, followup_fee_inr: null, default_doctor_id: null, default_doctor_name: null }] });
const onAllNullRow = await dbmod.getClinicFeePolicy('clinic-1');
dbmod.pool.query = async () => ({ rows: [{ followup_free_days: 5, followup_fee_inr: 400, default_doctor_id: 'd1', default_doctor_name: 'Dr. Daksha Patel' }] });
const onRealRow = await dbmod.getClinicFeePolicy('clinic-1');
dbmod.pool.query = realQuery;

ok('a database without migration 015 degrades to silence, not a crash', () => {
  assert.strictEqual(onMissingColumn, null,
    `expected null on a missing column, got ${JSON.stringify(onMissingColumn)} — every clinic that has not redeployed would lose its roster`);
});
ok('an all-NULL row is collapsed to null, not rendered as empty bullets', () => {
  assert.strictEqual(onAllNullRow, null, JSON.stringify(onAllNullRow));
  assert.strictEqual(feePolicyBlock(onAllNullRow), '');
});
ok('a real row comes back shaped for the block builder', () => {
  assert.deepStrictEqual(onRealRow,
    { followupFreeDays: 5, followupFeeInr: 400, defaultDoctorName: 'Dr. Daksha Patel' });
  assert.match(feePolicyBlock(onRealRow), /5 din tak FREE[\s\S]*₹400/);
});

// ── [6] Migration 015 ────────────────────────────────────────────────────
ok('migration 015 is additive, nullable, and re-runnable', () => {
  const sql = fs.readFileSync('db/migrations/015_clinic_fee_policy.sql', 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/, 'not idempotent');
  assert.doesNotMatch(sql, /NOT NULL/, 'a NOT NULL column would force a default onto every existing clinic');
  assert.match(sql, /REFERENCES doctors\(id\)/, 'default_doctor_id is not a real reference');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
})();
