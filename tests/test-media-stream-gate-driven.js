#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE /media-stream SECRET GATE, DRIVEN.
//
// 2026-09-13: 102 identical "bad/missing secret" lines in 49 seconds on the
// Skin Essence service, one failed call, and no way to tell "the applet sends
// no secret" from "the applet sends a stale one". This drives the decision
// and the diagnostic line: the four verdicts, whitespace tolerance on the
// configured value, the once-then-count throttle, the origin, the applet-URL
// hint — and that the secret's value never reaches the log.
//
// MUT-GATE-OPEN makes a wrong secret pass. The refusal proofs must go red.
//
// Run:            node tests/test-media-stream-gate-driven.js
// Prove it fails: MUTANT=MUT-GATE-OPEN node tests/test-media-stream-gate-driven.js
//                 MUTANT=MUT-START-GATE-OPEN node tests/test-media-stream-gate-driven.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');
const assert = require('assert');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;

console.log('\nMEDIA-STREAM GATE — driven\n');

const gate = require('../mediaStreamGate.js');
let checkSecret = gate.checkSecret;
let gateAtStart = gate.gateAtStart;
if (MUTANT === 'MUT-GATE-OPEN') {
  const real = checkSecret;
  checkSecret = (a) => { const v = real(a); return v.reason === 'wrong_secret' ? { ok: true, reason: 'ok' } : v; };
  console.log('  [MUTANT] MUT-GATE-OPEN — a wrong secret is let through\n');
}
if (MUTANT === 'MUT-START-GATE-OPEN') {
  // The deferral without the decision: an upgrade with no secret is let in and
  // nothing checks start.custom_parameters — the gate would be decorative.
  gateAtStart = () => ({ ok: true, reason: 'ok' });
  console.log('  [MUTANT] MUT-START-GATE-OPEN — start never checks the secret\n');
}

const SECRET = 'a'.repeat(48);

ok('no MEDIA_STREAM_SECRET configured → ungated (account_sid check still applies downstream)', () => {
  assert.deepStrictEqual(checkSecret({ required: undefined, provided: undefined }), { ok: true, reason: 'ungated' });
  assert.deepStrictEqual(checkSecret({ required: '   ', provided: 'x' }), { ok: true, reason: 'ungated' });
});
ok('the right secret passes', () => {
  assert.deepStrictEqual(checkSecret({ required: SECRET, provided: SECRET }), { ok: true, reason: 'ok' });
});
ok('a URL with no ?secret= is refused as no_secret', () => {
  const v = checkSecret({ required: SECRET, provided: undefined });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no_secret');
});
ok('a different secret is refused as wrong_secret, with lengths only', () => {
  const v = checkSecret({ required: SECRET, provided: 'b'.repeat(32) });
  assert.strictEqual(v.ok, false, 'a wrong secret was let through');
  assert.strictEqual(v.reason, 'wrong_secret');
  assert.strictEqual(v.providedLength, 32);
  assert.strictEqual(v.requiredLength, 48);
});
ok('a configured value pasted with a trailing newline or leading tab still matches', () => {
  assert.strictEqual(checkSecret({ required: SECRET + '\n', provided: SECRET }).ok, true);
  assert.strictEqual(checkSecret({ required: '\t' + SECRET, provided: SECRET }).ok, true);
  assert.strictEqual(checkSecret({ required: SECRET, provided: SECRET + ' ' }).ok, true);
});
ok('a repeated query key (?secret=a&secret=a) is judged on its first value', () => {
  assert.strictEqual(checkSecret({ required: SECRET, provided: [SECRET, 'junk'] }).ok, true);
});

// ── the two-stage gate: Exotel sends the secret in start.custom_parameters ──
ok('upgrade with no ?secret= is DEFERRED (Exotel forwards no query string), not refused', () => {
  assert.deepStrictEqual(gate.gateAtUpgrade({ required: SECRET, query: {} }), { ok: true, verified: false, reason: 'deferred' });
});
ok('upgrade with the right ?secret= is verified there and then', () => {
  assert.deepStrictEqual(gate.gateAtUpgrade({ required: SECRET, query: { secret: SECRET } }), { ok: true, verified: true, reason: 'ok' });
});
ok('upgrade with a WRONG ?secret= is refused at once', () => {
  const v = gate.gateAtUpgrade({ required: SECRET, query: { secret: 'nope' } });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'wrong_secret');
});
ok('start: the secret in custom_parameters (from the applet URL) passes the deferred gate', () => {
  assert.deepStrictEqual(gateAtStart({ required: SECRET, verifiedAtUpgrade: false, customParams: { secret: SECRET, From: '09876543210' } }), { ok: true, reason: 'ok' });
  assert.deepStrictEqual(gateAtStart({ required: SECRET, verifiedAtUpgrade: false, customParams: { Secret: SECRET } }), { ok: true, reason: 'ok' });
});
ok('start: no secret anywhere → refused (the deferral is not a hole)', () => {
  const v = gateAtStart({ required: SECRET, verifiedAtUpgrade: false, customParams: { From: '09876543210' } });
  assert.strictEqual(v.ok, false, 'a connection with no secret was let through at start');
  assert.strictEqual(v.reason, 'no_secret');
});
ok('start: a wrong secret in custom_parameters → refused', () => {
  const v = gateAtStart({ required: SECRET, verifiedAtUpgrade: false, customParams: { secret: 'stale' } });
  assert.strictEqual(v.ok, false, 'a wrong start secret was let through');
});
ok('start: already verified at the upgrade, or no secret configured → passes without looking', () => {
  assert.strictEqual(gateAtStart({ required: SECRET, verifiedAtUpgrade: true, customParams: {} }).ok, true);
  assert.strictEqual(gateAtStart({ required: '', verifiedAtUpgrade: false, customParams: {} }).ok, true);
});
ok('the start-stage rejection line names where it looked', () => {
  const out = [];
  const lg = gate.makeRejectionLogger({ log: (l) => out.push(l), now: () => 5 });
  lg({ reason: 'no_secret', where: 'start', ip: '1.2.3.4', domain: 'd' });
  assert.match(out[0], /no secret in the URL query nor in start\.custom_parameters/);
});

// ── the diagnostic line, throttled ──
let clock = 1_000_000;
const lines = [];
const logRejection = gate.makeRejectionLogger({ windowMs: 10_000, log: (l) => lines.push(l), now: () => clock });
const v = checkSecret({ required: SECRET, provided: undefined });
for (let i = 0; i < 102; i++) { logRejection({ ...v, ip: '10.0.0.7', xff: '52.66.1.2, 10.0.0.7', domain: 'engageo-server-v2-production-b02a.up.railway.app' }); clock += 480; }

ok('102 rejections in 49s produce one diagnostic per 10s window (5) plus a count for each rolled window (4) — 9 lines, not 102', () => {
  assert.strictEqual(lines.length, 9, `${lines.length} lines: ${lines.join(' | ')}`);
  for (const i of [1, 3, 5, 7]) assert.match(lines[i], /…and 20 more rejection\(s\) in the last 10s/, `line ${i}: ${lines[i]}`);
});
ok('each diagnostic says WHICH failure, from WHERE, and what the applet URL must be', () => {
  for (const i of [0, 2, 4, 6, 8]) {
    assert.match(lines[i], /no \?secret= in the URL/);
    assert.match(lines[i], /from 52\.66\.1\.2/);
    assert.match(lines[i], /wss:\/\/engageo-server-v2-production-b02a\.up\.railway\.app\/media-stream\?secret=/);
  }
});
clock += 11_000;
logRejection({ ...checkSecret({ required: SECRET, provided: 'b'.repeat(32) }), ip: '10.0.0.9', domain: 'x.up.railway.app' });
ok('the next call, a different failure, first closes the last window (17 suppressed) then diagnoses it (wrong secret, lengths only)', () => {
  assert.strictEqual(lines.length, 11, lines.join(' | '));
  assert.match(lines[9], /…and 17 more rejection\(s\)/);
  assert.match(lines[10], /wrong secret \(got 32 chars, expected 48\), from 10\.0\.0\.9/);
});
ok('the secret value never reaches the log', () => {
  for (const l of lines) assert.ok(!l.includes(SECRET) && !l.includes('b'.repeat(32)), l);
});

if (MUTANT && fail === 0) {
  console.log(`\n  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`);
  process.exit(1);
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
