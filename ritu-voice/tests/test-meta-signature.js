// ─── META WEBHOOK SIGNATURE ─────────────────────────────────────────────────
// Found by audit, 2026-08-07: the inbound WhatsApp webhook accepted ANY POST.
// The entire check was `body.object !== 'whatsapp_business_account'` — a field
// the SENDER chooses. Anyone with the Railway URL could create patient rows,
// inject conversation history under a real patient's number, fire the emergency
// alert at a number of their choosing, and spend the LLM budget.
//
// This file guards the three things that make the fix real rather than
// decorative: it must reject a forgery, it must be timing-safe, and it must run
// BEFORE anything is written.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyMetaSignature, shouldAccept } = require('../metaSignature');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const SECRET = 'test-app-secret-not-a-real-one';
const BODY = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1' }] }));
const sign = (buf, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

console.log('\nMETA WEBHOOK SIGNATURE — the endpoint used to accept anything\n');

ok('a genuine Meta delivery is accepted', () => {
  assert.strictEqual(verifyMetaSignature(BODY, sign(BODY), SECRET), 'valid');
  assert.strictEqual(shouldAccept('valid'), true);
});

ok('THE ATTACK: an unsigned POST is rejected', () => {
  // This is exactly what was possible before: no header at all.
  assert.strictEqual(verifyMetaSignature(BODY, undefined, SECRET), 'missing');
  assert.strictEqual(shouldAccept('missing'), false);
  assert.strictEqual(verifyMetaSignature(BODY, '', SECRET), 'missing');
});

ok('a forged or wrong-secret signature is rejected', () => {
  assert.strictEqual(verifyMetaSignature(BODY, sign(BODY, 'wrong-secret'), SECRET), 'invalid');
  assert.strictEqual(verifyMetaSignature(BODY, 'sha256=' + 'a'.repeat(64), SECRET), 'invalid');
  assert.strictEqual(shouldAccept('invalid'), false);
});

ok('a signature valid for a DIFFERENT body is rejected', () => {
  // Replaying yesterday's signature over today's payload must not work.
  const other = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2' }] }));
  assert.strictEqual(verifyMetaSignature(other, sign(BODY), SECRET), 'invalid');
});

ok('one flipped byte is rejected', () => {
  const good = sign(BODY);
  const flipped = good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0');
  assert.strictEqual(verifyMetaSignature(BODY, flipped, SECRET), 'invalid');
});

ok('a truncated digest cannot crash the comparison', () => {
  // crypto.timingSafeEqual THROWS on a length mismatch. Unguarded, a
  // one-character signature would be a remote crash — a denial of service
  // handed to the same attacker the check exists to stop.
  for (const bad of ['sha256=', 'sha256=ab', 'sha256=' + 'f'.repeat(200)]) {
    assert.doesNotThrow(() => verifyMetaSignature(BODY, bad, SECRET));
    assert.strictEqual(verifyMetaSignature(BODY, bad, SECRET), 'invalid');
  }
});

ok('malformed and hostile inputs never throw', () => {
  const cases = [
    [null, null, SECRET], [undefined, sign(BODY), SECRET], [BODY, {}, SECRET],
    [BODY, 'md5=abc', SECRET], [Buffer.alloc(0), sign(BODY), SECRET],
    [BODY, sign(BODY), ''], [123, 456, 789],
  ];
  for (const [b, h, s] of cases) {
    assert.doesNotThrow(() => verifyMetaSignature(b, h, s), `threw on ${JSON.stringify([b, h, s])}`);
  }
});

// ── the deliberate escape hatch, and its limits ─────────────────────────────
ok('unconfigured is ALLOWED — but distinguishable from valid', () => {
  // Shipping a change that silently drops every real patient message is a worse
  // outage than the exposure it closes. So no secret means allow-and-warn, not
  // reject. What must never happen is unconfigured being reported as verified.
  assert.strictEqual(verifyMetaSignature(BODY, sign(BODY), undefined), 'unconfigured');
  assert.strictEqual(verifyMetaSignature(BODY, undefined, ''), 'unconfigured');
  assert.strictEqual(shouldAccept('unconfigured'), true);
  assert.notStrictEqual('unconfigured', 'valid');
});

ok('a wiring failure is not blamed on the sender', () => {
  // If the express.json verify hook is ever removed, rawBody vanishes and every
  // delivery would look forged. That is our bug, and it gets its own verdict so
  // the log says so instead of accusing Meta.
  assert.strictEqual(verifyMetaSignature(undefined, sign(BODY), SECRET), 'no-body');
  assert.strictEqual(shouldAccept('no-body'), false);
});

// ── ordering: the part that makes it more than decorative ───────────────────
ok('the check runs BEFORE the 200 and BEFORE any database write', () => {
  // Acking first and verifying second would still have written the attacker's
  // payload into webhook_events. Order is the fix as much as the HMAC is.
  const wa = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');
  const fn = wa.slice(wa.indexOf('async function handleIncomingWhatsApp'));
  const body = fn.slice(0, 3000);
  const verifyAt = body.indexOf('verifyMetaSignature(');
  const ackAt = body.indexOf('res.sendStatus(200)');
  const insertAt = body.indexOf('INSERT INTO webhook_events');
  assert(verifyAt > 0, 'the signature is never checked in the handler');
  assert(ackAt > 0 && verifyAt < ackAt, 'the 200 is sent before the signature is checked');
  assert(insertAt > 0 && verifyAt < insertAt, 'the payload is stored before the signature is checked');
  assert(/return res\.sendStatus\(403\)/.test(body), 'a rejected delivery does not return 403');
});

ok('the raw body is captured, because nothing else can reproduce it', () => {
  // The signature covers the exact bytes Meta sent. Re-serialising req.body
  // changes key order and unicode escaping, so it can never match.
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert(/verify:\s*\(req, _res, buf\)/.test(idx), 'express.json has no verify hook — rawBody will be undefined');
  assert(/req\.rawBody = buf/.test(idx), 'the raw buffer is never stored');
});

ok('whether we are enforcing is VISIBLE, not assumed', () => {
  const rc = fs.readFileSync(path.join(__dirname, '..', 'runtimeConfig.js'), 'utf8');
  assert(/waSignature: !!e\.META_APP_SECRET/.test(rc), 'signature state is not recorded per call');
  assert(/waSignature/.test(rc.slice(rc.indexOf('describeRuntimeConfig'))), 'it is not printed at boot');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
