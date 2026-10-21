#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A PRICE IS AS DANGEROUS TO INVENT AS A DOCTOR.
//
// An aesthetic / dermatology clinic takes a different call: nobody says what
// hurts, they ask what laser costs and how many sittings it takes. Ritu had no
// concept of a treatment, so those questions were refused or answered from the
// model's imagination.
//
// Treatments deliberately reuse the ROSTER pattern — a table, rendered to
// prompt text IN CODE, under one rule ("SIRF isi list se bol; list ke bahar
// KABHI mat bana"). That mechanism has a measured zero-invented-doctors record
// across 137 production calls, and a quoted price fails identically: a caller
// told ₹15,000 and charged ₹40,000 blames whoever said it.
//
// This file guards the four properties that make it safe:
//   [1] the text is BUILT, not summarised — ranges stay ranges
//   [2] no price set renders as "clinic confirm karega", never a number
//   [3] a GP clinic's prompt is byte-identical — the block is absent, not empty
//   [4] the prompt forbids advice, separately from forbidding invention
//
// Run: node tests/test-treatments.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const lean = require('../brain-lean');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message}`); } };

const DOC = { id: 'd', name: 'Dr. N', specialty: 'Dermatologist', fee_inr: 800, is_on_call: false,
  schedule: 'Mon-Sat 11:00-19:00', windows: [{ dow: 1, start: '11:00', end: '18:30' }], taken: [] };

// ─── [1] and [2] — the renderer, driven through db.js's own function ────────
console.log('\n[1] the price line is built from columns, not summarised');
{
  const db = require('../db.js');
  // Drive the real renderer via the exported function with a stubbed pool, so
  // the SQL→text mapping is under test rather than a copy of it.
  const rows = [
    { name: 'Laser — full face', category: 'Laser', price_min: 3000, price_max: 6000,
      price_unit: 'session', sessions_min: 6, sessions_max: 8, duration_min: 30,
      downtime: 'none', notes: 'avoid sun 48h before' },
    { name: 'Peel', category: 'Peels', price_min: 4500, price_max: null, price_unit: 'session',
      sessions_min: 3, sessions_max: 4, duration_min: null, downtime: null, notes: null },
    { name: 'Botox', category: 'Injectables', price_min: null, price_max: null, price_unit: 'session',
      sessions_min: 1, sessions_max: 1, duration_min: 20, downtime: 'none', notes: 'not during pregnancy' },
  ];
  db.pool.query = async () => ({ rows, rowCount: rows.length });
  return (async () => {
    const out = await db.getTreatments('clinic-1');
    const t = out.text;
    ok('a RANGE stays a range', () => assert(/₹3000-6000\/session/.test(t), t));
    ok('a flat price has no range', () => assert(/₹4500\/session/.test(t) && !/₹4500-/.test(t), t));
    ok('session range rendered',   () => assert(/6-8 sessions/.test(t), t));
    ok('a single session is not pluralised into a range', () => assert(/1 session/.test(t), t));
    ok('downtime carried',         () => assert(/downtime: none/.test(t), t));
    ok('notes carried',            () => assert(/avoid sun 48h before/.test(t), t));

    console.log('\n[2] no price set is an honest sentence, never a number');
    ok('renders "clinic confirm karega"', () => assert(/Botox[^\n]*clinic confirm karega/.test(t), t));
    ok('no rupee figure invented for it', () => {
      const line = t.split('\n').find((l) => /Botox/.test(l));
      assert(!/₹\d/.test(line), line);
    });

    console.log('\n[3] a GP clinic is untouched');
    lean._setRosterForTest({ text: '', doctors: [DOC] });
    const gp = lean.buildSystemPrompt({ rosterSlice: lean.sliceRoster([], {}), hindiInCall: true });
    ok('no TREATMENTS block when the clinic has none',
      () => assert(!/TREATMENTS —/.test(gp), 'a GP clinic got a treatments block'));
    ok('and no stray heading either',
      () => assert(!/clinic confirm karega/.test(gp)));

    console.log('\n[4] the prompt forbids ADVICE separately from forbidding invention');
    // Two different failures. "We do thread lifts" (invention) and "laser is
    // safe for you" (advice) need two rules; one does not imply the other.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'brain-lean.js'), 'utf8');
    ok('invention is forbidden',
      () => assert(/list ke bahar koi treatment\/price\/claim KABHI mat bana/.test(src)));
    ok('advice is forbidden, in its own rule',
      () => assert(/koi medical raay KABHI mat de/.test(src)));
    ok('...and it overrides the notes column',
      () => assert(/chahe list mein notes likhe hon/.test(src),
        'notes like "not during pregnancy" must not become advice'));

    console.log(`\n${pass}/${pass + fail} passing`);
    if (fail) { console.log('✗ FAILURES'); process.exit(1); }
    console.log('✓ She quotes what the clinic set, and advises nothing.');
    process.exit(0);
  })();
}
