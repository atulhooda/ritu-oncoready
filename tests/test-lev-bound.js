// ─── BOUNDED LEVENSHTEIN ────────────────────────────────────────────────────
// MEASURED 2026-08-06 by CPU profile: 96% of a MISSING findDrugMention was the
// generic scan — 66.5% self-time in the loop plus 29.6% inside lev() — costing
// ~21.6ms on ordinary Marathi and ~44ms on drug-naming speech. That is spent on
// the meds turn, inside the voice loop, to conclude nothing.
//
// A length index was tried FIRST and bought only 7%, because drug names and
// spoken tokens share a length distribution: the in-threshold band is exactly
// where the lexicon already lives. The waste was never WHICH pairs got
// compared — it was computing a full DP matrix when the answer is almost always
// "far away". Capping it took the miss path 21.6ms → 11.4ms.
//
// This is a PURE OPTIMIZATION, so the bar is not "does it pass" but "is it the
// same function". This file is that proof, and it exists because a wrong cap
// would not crash — it would silently start missing drugs.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { _lev, _generics } = require('../readback');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// The reference: the exact implementation this replaced, kept verbatim so the
// comparison is against the real prior behaviour rather than a restatement.
function levFull(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

console.log('\nBOUNDED LEVENSHTEIN — the same function, or it is a silent recall bug\n');

ok('uncapped, it is still exactly Levenshtein', () => {
  // Callers outside the scan loops pass no cap, so the unbounded path must be
  // untouched.
  const cases = [
    ['', '', 0], ['', 'abc', 3], ['abc', '', 3], ['abc', 'abc', 0],
    ['kitten', 'sitting', 3], ['metformin', 'metamorphosin', 6],  // the real live garble; readback.js cites 6
    ['paracetamol', 'parasitamol', 2], ['dolo', 'dolour', 2],
  ];
  for (const [a, b, want] of cases) {
    assert.strictEqual(_lev(a, b), want, `lev(${a}, ${b})`);
    assert.strictEqual(_lev(a, b), levFull(a, b), `lev(${a}, ${b}) vs reference`);
  }
});

ok('a pair INSIDE the cap returns its EXACT distance', () => {
  // The accepted branch must be bit-identical: the score the caller reports and
  // the winner it picks are both derived from this number.
  for (const [a, b] of [['paracetamol', 'parasitamol'], ['metformin', 'metfarmin'], ['calcium', 'calciyam']]) {
    const d = levFull(a, b);
    const span = Math.max(a.length, b.length);
    assert.strictEqual(_lev(a, b, d), d, `cap exactly at the distance must not abort`);
    assert.strictEqual(_lev(a, b, 0.34 * span), d, `in-threshold pair must return its true distance`);
  }
});

ok('a pair OUTSIDE the cap returns something the caller rejects', () => {
  // It may return early with an approximation — the contract is only that the
  // value is ABOVE the cap, because every caller compares and discards.
  for (const [a, b] of [['diabetes', 'dasatinib'], ['kidney', 'lindane'], ['smoking', 'choline']]) {
    const span = Math.max(a.length, b.length);
    for (const th of [0.12, 0.19, 0.28, 0.34]) {
      const cap = th * span;
      if (levFull(a, b) <= cap) continue;
      assert(_lev(a, b, cap) > cap, `${a}/${b} at ${th} must stay rejected`);
    }
  }
});

ok('EXHAUSTIVE: 100k real pairs agree on every decision the caller makes', () => {
  // The caller asks two things and nothing else: does d <= cap, and if so what
  // is d. Anything the bounded form does above the cap is unobservable.
  const G = _generics.map((s) => s.toLowerCase());
  const AL = 'abcdefghijklmnopqrstuvwxyz';
  // Deterministic PRNG — a flaky equivalence test is worse than none.
  let seed = 20260806;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rnd = (n) => Array.from({ length: n }, () => AL[Math.floor(rand() * 26)]).join('');
  const probes = [];
  for (let i = 0; i < 250; i++) probes.push(G[Math.floor(rand() * G.length)]);
  for (let i = 0; i < 250; i++) probes.push(rnd(3 + Math.floor(rand() * 12)));

  let checked = 0, bad = 0, first = null;
  for (const q of probes) {
    for (let k = 0; k < 40; k++) {
      const g = G[Math.floor(rand() * G.length)];
      const span = Math.max(q.length, g.length);
      const full = levFull(q, g);
      for (const th of [0.12, 0.19, 0.28, 0.34, 0.50]) {
        const cap = th * span;
        const bnd = _lev(q, g, cap);
        checked++;
        const fullOK = full <= cap, bndOK = bnd <= cap;
        if (fullOK !== bndOK || (fullOK && full !== bnd)) {
          bad++; if (!first) first = { q, g, th, full, bnd, cap };
        }
      }
    }
  }
  assert.strictEqual(bad, 0, `${bad} of ${checked} pairs disagreed, e.g. ${JSON.stringify(first)}`);
  console.log(`      (${checked.toLocaleString()} pairs compared)`);
});

ok('MUTATION: an off-by-one cap WOULD be caught', () => {
  // The failure mode this file guards is a cap one edit too tight — it does not
  // crash, it silently stops finding drugs. Prove the comparison above is
  // sharp enough to see that, by asking for a distance the pair genuinely has
  // and capping one below it.
  const a = 'paracetamol', b = 'parasitamol';
  const d = levFull(a, b);                       // 2: c->s and e->i
  assert.strictEqual(_lev(a, b, d), d);          // at the cap: found
  assert(_lev(a, b, d - 1) > d - 1, 'a too-tight cap must reject, not silently return the true distance');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
