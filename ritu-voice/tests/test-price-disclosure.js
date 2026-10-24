#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A PRICE THE CLINIC DID NOT AGREE TO SAY MUST NEVER REACH THE MODEL.
//
// Skin Essence's form has a "Tell price on call?" column. For wart removal
// (₹1,500–5,000) and tattoo removal (₹1,500–3,000) the answer is NO — both
// depend on number, size and age, so a phone quote becomes an argument at the
// desk. The clinic still needs the figures on its own screen.
//
// So the guarantee is not "the model was told not to say it". It is that the
// digits are never CONCATENATED INTO THE PROMPT: db.getTreatments renders
// "doctor dekh kar batayenge" and the numbers stay on the row. A model cannot
// leak a figure it was never shown. Asking it to keep a visible secret is the
// class of instruction medicalAdviceGuard.js exists because of.
//
// The check is per-TREATMENT-LINE, not a search for the digits anywhere in the
// text: ₹1500 is legitimately Chemical peel's disclosed price, and a naive
// document-wide grep would call that a leak and be waved through.
//
// Run:            node tests/test-price-disclosure.js
// Prove it fails: MUTANT=MUT-DISCLOSE-ALL node tests/test-price-disclosure.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nPRICE DISCLOSURE — suppressed at render, not at the model\n');

(async () => {
  const db = require('../db.js');

  // Skin Essence's five real treatments, exactly as the signed form has them.
  const ROWS = [
    { name: 'Chemical peel',  category: 'Peels',            price_min: 1500, price_max: null, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 20, downtime: 'mild redness 1-2 days', notes: null, disclose_price: true  },
    { name: 'Hydrafacial',    category: 'Facials',          price_min: 3000, price_max: null, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 60, downtime: null, notes: null, disclose_price: true  },
    { name: 'Wart removal',   category: 'Minor procedures', price_min: 1500, price_max: 5000, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 40, downtime: 'scab 5-7 days', notes: null, disclose_price: false },
    { name: 'Tattoo removal', category: 'Laser',            price_min: 1500, price_max: 3000, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 30, downtime: null, notes: null, disclose_price: false },
    { name: 'Cryolipolysis',  category: 'Body contouring',  price_min: 3500, price_max: null, price_unit: 'session', sessions_min: null, sessions_max: null, duration_min: 60, downtime: null, notes: null, disclose_price: true  },
  ];

  db.pool.query = async (sql) => {
    if (/FROM treatments/i.test(String(sql))) {
      return { rows: ROWS.map((r) => MUTANT === 'MUT-DISCLOSE-ALL' ? { ...r, disclose_price: true } : r) };
    }
    return { rows: [] };
  };
  if (MUTANT === 'MUT-DISCLOSE-ALL') console.log('  [MUTANT] MUT-DISCLOSE-ALL — every price is quotable again\n');

  const { text } = await db.getTreatments('clinic-1');
  const lineFor = (name) => text.split('\n').find((l) => l.includes(name)) || '';

  // ── The two the clinic said not to quote ────────────────────────────────
  for (const t of ROWS.filter((r) => !r.disclose_price)) {
    const line = lineFor(t.name);
    ok(`${t.name}: its own prompt line carries NO price digits`, () => {
      assert.ok(line, `${t.name} is missing from the treatments block entirely`);
      const digits = line.replace(/\b\d+\s*min\b/g, '').replace(/\d+-\d+ days?/g, '').match(/\d{3,}/g);
      assert.strictEqual(digits, null,
        `"${line.trim()}" still carries ${digits && digits.join(', ')} — the clinic said do not quote this`);
    });
    ok(`${t.name}: says the doctor will quote after examining`, () => {
      assert.match(line, /doctor dekh kar batayenge/,
        `"${line.trim()}" does not tell the caller who will quote`);
    });
  }

  // ── The three that ARE quotable still are ──────────────────────────────
  ok('Hydrafacial still quotes ₹3000 (suppression is per-row, not global)', () => {
    assert.match(lineFor('Hydrafacial'), /₹3000/, lineFor('Hydrafacial'));
  });
  ok('Chemical peel still quotes ₹1500', () => {
    assert.match(lineFor('Chemical peel'), /₹1500/, lineFor('Chemical peel'));
  });
  ok('Cryolipolysis still quotes ₹3500', () => {
    assert.match(lineFor('Cryolipolysis'), /₹3500/, lineFor('Cryolipolysis'));
  });

  // ── The check that a document-wide grep would get wrong ────────────────
  ok('₹1500 appears in the block — for the PEEL, which is allowed to say it', () => {
    assert.match(text, /₹1500/, 'the disclosed peel price vanished');
    assert.doesNotMatch(lineFor('Wart removal'), /1500/,
      'wart removal shares the ₹1500 figure and must still not show it');
  });

  // ── Absent ≠ false. A row with no opinion is not a suppressed row. ──────
  db.pool.query = async (sql) => /FROM treatments/i.test(String(sql))
    ? { rows: [{ name: 'Consultation', category: null, price_min: null, price_max: null, price_unit: null, sessions_min: null, sessions_max: null, duration_min: null, downtime: null, notes: null, disclose_price: true }] }
    : { rows: [] };
  const { text: t2 } = await db.getTreatments('clinic-1');
  ok('a row with both prices NULL still says the clinic will confirm', () => {
    assert.match(t2, /clinic confirm karega/,
      'the unknown-price wording was lost — "not disclosed" and "not known" are different facts');
  });

  // ── The prompt rule must cover BOTH no-number renderings ───────────────
  ok('the prompt rule is generic, not tied to one wording', () => {
    const fs = require('fs');
    const brain = fs.readFileSync('brain-lean.js', 'utf8');
    assert.doesNotMatch(brain, /Price "clinic confirm karega" likha ho/,
      'the old rule names only ONE no-number rendering and contradicts the other');
    assert.match(brain, /Price mein NUMBER na likha ho toh jo likha hai HUBAHU/,
      'no generic price rule found in the prompt');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
})();
