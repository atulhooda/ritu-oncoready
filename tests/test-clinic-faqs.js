#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE ANSWERS THE CLINIC WROTE ITSELF — SPOKEN VERBATIM, AND ONLY THOSE.
//
// Section E3 of the setup form is the highest-value table in it: whatever the
// clinic types is what Ritu says, word for word. It is built to grow — what to
// bring on a first visit, when reports are ready, waiting time, EMI, directions.
//
// SKIN ESSENCE SEEDS ONE ROW. Its other two E3 answers already have structured
// homes, and copying them here would be the same-fact-in-two-places defect with
// the worse copy winning:
//   · "available 10:30 to 8" is a STATIC string that contradicts the 14:00–16:00
//     lunch, Dr. Jigisha's 19:00 finish, Sundays and three holidays.
//     doctor_schedules answers it live and per-doctor.
//   · "consultation ₹700, follow-up free 5 days then ₹400" is doctors.fee_inr
//     plus migration 015, rendered by the code-built fee block.
// Parking has no structured twin. That absence is the test for what belongs here.
//
// Run:            node tests/test-clinic-faqs.js
// Prove it fails: MUTANT=MUT-FAQ-FREESTYLE   node tests/test-clinic-faqs.js
//                 MUTANT=MUT-FAQ-RENDER-EMPTY node tests/test-clinic-faqs.js
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

console.log('\nCLINIC FAQs — verbatim, and only from the list\n');

(async () => {
  const db = require('../db.js');
  const lean = require('../brain-lean.js');
  const realQuery = db.pool.query;

  const PARKING = { question: 'શું પાર્કિંગ છે?', answer: 'કાર અને બાઈક પાર્કિંગ બિલ્ડિંગની નીચે જ છે.' };

  // ── Drive the real fetch ────────────────────────────────────────────────
  db.pool.query = async (sql) => /FROM clinic_faqs/i.test(String(sql)) ? { rows: [PARKING] } : { rows: [] };
  const withRow = await db.getClinicFaqs('c1');
  db.pool.query = async (sql) => /FROM clinic_faqs/i.test(String(sql)) ? { rows: [] } : { rows: [] };
  const empty = await db.getClinicFaqs('c1');
  db.pool.query = async () => { const e = new Error('relation "clinic_faqs" does not exist'); e.code = '42P01'; throw e; };
  const missingTable = await db.getClinicFaqs('c1');
  db.pool.query = realQuery;

  ok('an answer is carried through exactly as the clinic typed it', () => {
    assert.match(withRow.text, /કાર અને બાઈક પાર્કિંગ બિલ્ડિંગની નીચે જ છે\./,
      `the answer was altered: ${withRow.text}`);
    assert.match(withRow.text, /Q: શું પાર્કિંગ છે\?/, 'the question is missing, so the model cannot match it');
  });
  ok('an empty table returns an empty block, not an empty heading', () => {
    assert.strictEqual(empty.text, '');
    assert.deepStrictEqual(empty.faqs, []);
  });
  ok('a database predating migration 016 degrades to silence', () => {
    assert.deepStrictEqual(missingTable, { text: '', faqs: [] },
      'a missing table would cost the roster instead of just the FAQs');
  });

  // ── The prompt block ────────────────────────────────────────────────────
  const SRC = fs.readFileSync('brain-lean.js', 'utf8');
  const noFaqPrompt = lean.buildSystemPrompt({}, {});

  ok('with no FAQs the prompt is unchanged (the deletion test)', () => {
    const rendersEmpty = MUTANT === 'MUT-FAQ-RENDER-EMPTY';
    assert.strictEqual(/CLINIC KI JAANKARI/.test(noFaqPrompt) || rendersEmpty, false,
      'a clinic that wrote no FAQs gained an empty FAQ heading in every prompt');
  });
  ok('the block carries the same no-invention rule as the roster', () => {
    const freestyle = MUTANT === 'MUT-FAQ-FREESTYLE';
    const hasRule = !freestyle && /SIRF isi list se, HUBAHU/.test(SRC);
    assert.ok(hasRule, 'nothing stops the model paraphrasing or extending a clinic-written answer');
  });
  ok('and tells the model what to say when a question is NOT on the list', () => {
    assert.match(SRC, /confirm karke bata dungi/,
      'an unlisted question has no honest fallback, so the model will guess');
    assert.match(SRC, /GUESS mat kar/, 'no explicit instruction against guessing');
  });
  ok('the block defers to the stronger blocks rather than overriding them', () => {
    assert.match(SRC, /DOCTORS \/ TREATMENTS \/ FEES \/ ADDRESS/,
      'the fallback does not exclude the structured blocks — an FAQ could answer over live availability');
  });
  // Asserted on the RENDERED prompt, by driving the real loader. The first
  // version compared source indices — which read the feePolicyBlock FUNCTION
  // definition rather than its call site, and was labelled "after treatments"
  // while checking the opposite. Source position is not prompt position.
  db.pool.query = async (sql) => {
    const q = String(sql);
    if (/FROM clinic_faqs/i.test(q)) return { rows: [PARKING] };
    if (/FROM treatments/i.test(q)) return { rows: [{ name: 'Hydrafacial', category: null, price_min: 3000, price_max: null, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 60, downtime: null, notes: null, disclose_price: true }] };
    if (/FROM clinics c/i.test(q)) return { rows: [{ followup_free_days: 5, followup_fee_inr: 400, default_doctor_id: 'd1', default_doctor_name: 'Dr. Daksha Patel' }] };
    if (/FROM doctors/i.test(q)) return { rows: [{ id: 'd1', name: 'Dr. Daksha Patel', specialty: 'Dermatologist', fee_inr: 700, is_on_call: false }] };
    return { rows: [] };
  };
  await lean.preloadRoster('c1');
  db.pool.query = realQuery;
  const full = lean.buildSystemPrompt({}, {});

  ok('all three blocks render together when the clinic has supplied all three', () => {
    for (const [label, re] of [['FEES', /FEES \/ DEFAULT DOCTOR/], ['TREATMENTS', /TREATMENTS — yeh POORI list hai/], ['FAQ', /CLINIC KI JAANKARI/]]) {
      assert.match(full, re, `${label} block is missing from the rendered prompt`);
    }
  });
  ok('the FAQ block renders AFTER treatments, so the stronger rules are read first', () => {
    const faq = full.indexOf('CLINIC KI JAANKARI');
    const treat = full.indexOf('TREATMENTS — yeh POORI list hai');
    const fee = full.indexOf('FEES / DEFAULT DOCTOR');
    assert.ok(fee < treat, `fees at ${fee} should precede treatments at ${treat}`);
    assert.ok(treat < faq, `treatments at ${treat} should precede the FAQ block at ${faq}`);
  });
  ok('the clinic-written answer survives into the real prompt verbatim', () => {
    assert.match(full, /કાર અને બાઈક પાર્કિંગ બિલ્ડિંગની નીચે જ છે\./,
      'the answer was altered or dropped somewhere between the row and the prompt');
  });

  // ── The duplicate guard ─────────────────────────────────────────────────
  ok('two active rows cannot answer the same question differently', () => {
    const sql = fs.readFileSync('db/migrations/016_clinic_faqs.sql', 'utf8');
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_faq_question_per_clinic/,
      'no duplicate guard — a clinic could hold two answers and the caller hears a coin flip');
    assert.match(sql, /LOWER\(question\)\) WHERE active/, 'the guard is case-sensitive or ignores active');
  });
  ok('the migration is additive and re-runnable', () => {
    const sql = fs.readFileSync('db/migrations/016_clinic_faqs.sql', 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS/, 'not idempotent');
    assert.match(sql, /length\(trim\(answer\)\)   > 0|length\(trim\(answer\)\) > 0/,
      'a blank answer can be stored, and Ritu would say nothing where a fact should be');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
})();
