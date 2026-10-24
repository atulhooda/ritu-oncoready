// ─── SYMPTOM DRIFT ──────────────────────────────────────────────────────────
// Ritu naming a complaint the patient never made. From a real abandoned call,
// 2026-08-06 12:42:
//     patient  हाँ hello यार लेकिन मेरे को ना book दर्द हो रहा है sir मैं।
//     ritu     समझ गई जी, पेट दर्द। ये तकलीफ़ आपको कब से है?
// The same caller said सर दर्द (HEAD) on every other call that day. The 8kHz
// line mangled सर into "book" and the model resolved the wreckage into पेट —
// STOMACH — and said it back with full confidence. A symptom routes the
// patient to a specialty and is the first thing the doctor reads, so a wrong
// body part is the same class of error as a wrong molecule.
//
// The guard's whole basis is ASSERT vs ASK, and this file exists because the
// first version got that wrong: comparing whole turns fired on 5 of 8 real
// calls, and FOUR were the same history question. Every case below is a real
// transcript line, not an invented one.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { symptomDrift, assertedClauses } = require('../symptomGuard');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// The real call, verbatim.
const GARBLED_CALL = 'तो तो थोड़ा सा। This is already, you know, at a very advanced stage. '
  + 'हाँ hello यार लेकिन मेरे को ना book दर्द हो रहा है sir मैं।';
const WRONG_ORGAN = 'समझ गई जी, पेट दर्द। ये तकलीफ़ आपको कब से है?';

console.log('\nSYMPTOM DRIFT — a wrong body part is a wrong molecule\n');

ok('THE PRODUCTION BUG: पेट asserted from a call that never said it', () => {
  const d = symptomDrift(GARBLED_CALL, WRONG_ORGAN);
  assert(d.length > 0, 'the real confabulation is not detected');
  assert(d.includes('Internal Medicine'), `expected the stomach specialty, got ${JSON.stringify(d)}`);
});

// ── the four false positives that forced the clause split ───────────────────
ok('the history QUESTION is not a claim — all 4 false positives stay silent', () => {
  // "कोई एलर्जी है जी?" names allergy, which IS in the symptom table, while
  // ASKING whether it applies. Firing here would have made the guard useless:
  // it appeared in 4 of the 8 real calls, every one of them clean.
  const HISTORY_Q = 'समझ गई। कोई दवाई चल रही है या कोई एलर्जी है जी?';
  for (const patient of [
    'यार मेरे सर में दर्द हो रहा है',
    'ये कल रात से है',
    'तो तो थोड़ा सा।',
    '',
  ]) {
    assert.deepStrictEqual(symptomDrift(patient, HISTORY_Q), [],
      `the history question fired against patient text: "${patient}"`);
  }
});

ok('echoing what the patient DID say is clean', () => {
  assert.deepStrictEqual(symptomDrift('यार मेरे ना सर में दर्द हो रहा है', 'अच्छा। सर में दर्द। कब से है?'), []);
});

ok('saying LESS than the patient did is clean — it is a superset test', () => {
  // She routinely acknowledges one complaint out of several. Equality would
  // fire on every well-behaved call.
  assert.deepStrictEqual(symptomDrift('मेरे सर में दर्द और पेट में भी जलन', 'अच्छा, सर दर्द।'), []);
});

ok('support is CUMULATIVE — an echo three turns later is still supported', () => {
  // The patient states the complaint once; she may refer back to it at booking.
  const all = 'यार मेरे सर में दर्द हो रहा है ... कल रात से ... नहीं कोई दवाई नहीं';
  assert.deepStrictEqual(symptomDrift(all, 'तो सर में दर्द के लिए डॉ. मनोज देव को दिखा लीजिए।'), []);
});

// ── the mechanism ───────────────────────────────────────────────────────────
ok('assertedClauses keeps statements and drops questions', () => {
  assert.deepStrictEqual(assertedClauses(WRONG_ORGAN), ['समझ गई जी, पेट दर्द।']);
  assert.deepStrictEqual(assertedClauses('कोई एलर्जी है जी?'), []);
  // Devanagari danda, western stop, and ? all terminate.
  assert.deepStrictEqual(assertedClauses('एक. दो? तीन।'), ['एक.', 'तीन।']);
});

ok('MUTATION: without the question filter, the guard fires on the history line', () => {
  // If the interrogative filter is ever dropped, THIS is what comes back — the
  // 4-in-5 false-positive rate that made the first version unusable. Asserting
  // the mechanism, not just the outcome, so the reason survives a refactor.
  const naive = (patient, ritu) => {
    const { specialtiesForSymptom } = require('../tools/symptomMapping');
    const sup = new Set(specialtiesForSymptom(patient));
    return specialtiesForSymptom(ritu).filter((s) => !sup.has(s));
  };
  const HISTORY_Q = 'समझ गई। कोई दवाई चल रही है या कोई एलर्जी है जी?';
  assert(naive('यार मेरे सर में दर्द हो रहा है', HISTORY_Q).length > 0,
    'the naive rule no longer over-fires — this mutation test has stopped testing anything');
  assert.deepStrictEqual(symptomDrift('यार मेरे सर में दर्द हो रहा है', HISTORY_Q), []);
});

ok('never throws — it runs where a crash would cost a patient their turn', () => {
  for (const [a, b] of [[null, null], [undefined, 'x'], ['x', undefined], [{}, []], [123, 456]]) {
    assert.doesNotThrow(() => symptomDrift(a, b));
    assert(Array.isArray(symptomDrift(a, b)));
  }
});

ok('SHADOW: the guard is recorded, and does not gate the reply', () => {
  // One production example is enough to measure on, not enough to block a
  // patient's turn on — the path emergencyDetectorV2 took. If this ever starts
  // rewriting or suppressing a reply, that decision must be deliberate.
  const fs = require('fs');
  const path = require('path');
  const ch = fs.readFileSync(path.join(__dirname, '..', 'callHandler.js'), 'utf8');
  // Asserts the BEHAVIOUR, not the expression. The first version matched
  // `symptomDrift: this._symptomDriftAudit()` literally, and broke the moment
  // the audit was hoisted to a const so the CALLSUM log line could reuse it —
  // a change that was strictly better and that the test called a regression.
  assert(/symptomDrift: /.test(ch.slice(ch.indexOf('diagnostics: {'))), 'drift is not recorded in diagnostics');
  assert(/const drift = this\._symptomDriftAudit\(\)/.test(ch),
    'the audit result is no longer computed once and reused');
  // The audit must be called from the diagnostics block only — never on the
  // reply path, where it could delay or alter what the patient hears.
  // Match INVOCATIONS (this._…), not the definition — the first version of this
  // assertion counted `_symptomDriftAudit() {` as a call and reported 2.
  const calls = (ch.match(/this\._symptomDriftAudit\(\)/g) || []).length;
  assert.strictEqual(calls, 1, `_symptomDriftAudit is invoked ${calls} times — shadow means exactly once, at call end`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
