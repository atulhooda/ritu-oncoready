// ─── THE INBOUND WEBHOOK, ACTUALLY EXECUTED ─────────────────────────────────
// 2026-08-07 21:46 the HMAC check shipped reading `config.meta.appSecret`.
// There is no config.meta — the key is config.whatsapp. Every inbound WhatsApp
// delivery threw and returned 500 for the next twenty hours:
//
//     POST /whatsapp/incoming → 500 (3ms)
//     TypeError: Cannot read properties of undefined (reading 'appSecret')
//         at handleIncomingWhatsApp (/app/whatsapp.js:452:96)
//
// Meta retries a 500 for up to 36 hours and then disables the subscription, so
// this was on a clock. Nothing malicious got through — it failed closed — but
// no patient message got through either.
//
// WHY THE EXISTING TEST DIDN'T CATCH IT. test-meta-signature.js proved the
// signature check runs before the 200 and before the INSERT, and it proved that
// by READING whatsapp.js as a string and comparing indexOf positions. Every
// assertion was true. The function was never called.
//
// That is the same failure as the ReferenceError shipped two days earlier in
// the call-end path: `node --check` validates syntax, not scope, and the
// pre-push gate never executes a webhook delivery or a call teardown. Source
// text is evidence about source text. Only running the thing is evidence about
// running the thing.
//
// So this file drives handleIncomingWhatsApp with a fake req/res. Ordering
// stays in the other file; correctness lives here.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const done = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return done;
};

// ── isolate: no database, no Meta, no network ───────────────────────────────
// The handler inserts into webhook_events and may call the brain. We are
// testing the authentication gate, so stub the edges and let the real code run.
const SECRET = 'test-app-secret-not-a-real-one';
process.env.META_APP_SECRET = SECRET;
process.env.META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || 'test-phone-id';
process.env.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'test-token';

const db = require('../db');
const queries = [];
db.pool = db.pool || {};
db.pool.query = async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; };

const whatsapp = require('../whatsapp');

const BODY_OBJ = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [] }] };
const RAW = Buffer.from(JSON.stringify(BODY_OBJ));
const sign = (buf, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

function fakeReq(opts = {}) {
  // NOT a default parameter. `rawBody = RAW` would substitute a real body for
  // the one case that needs a genuinely absent one, and that case would pass
  // while testing nothing — which is the exact defect this file was written
  // about, reappearing one level up in the harness.
  const rawBody = 'rawBody' in opts ? opts.rawBody : RAW;
  const body = 'body' in opts ? opts.body : BODY_OBJ;
  return { rawBody, body, get: (h) => (h.toLowerCase() === 'x-hub-signature-256' ? opts.sig : undefined) };
}
function fakeRes() {
  const r = { statuses: [], sendStatus(c) { r.statuses.push(c); return r; } };
  return r;
}
// A throw inside the handler is the bug we are hunting, so surface it rather
// than letting an assertion on res report it as a mere wrong status code.
async function drive(req) {
  const res = fakeRes();
  await whatsapp.handleIncomingWhatsApp(req, res);
  return res;
}

console.log('\nINBOUND WHATSAPP — driven, not read\n');

(async () => {

  await ok('THE REGRESSION: a genuine signed delivery does not throw, and acks 200', async () => {
    // This is the assertion that was missing. It fails outright — not on a
    // status code, on an uncaught TypeError — with config.meta.appSecret.
    const res = await drive(fakeReq({ sig: sign(RAW) }));
    assert.deepStrictEqual(res.statuses, [200],
      `expected a 200 ack, got ${JSON.stringify(res.statuses)}`);
  });

  await ok('the secret is read from a key that EXISTS on config', async () => {
    // Names the root cause directly, so a future rename of config.whatsapp
    // fails here with an explanation rather than at 3am in Railway's log.
    const config = require('../config');
    assert(config.whatsapp && typeof config.whatsapp === 'object',
      'config.whatsapp is gone — whatsapp.js reads appSecret from it');
    assert.strictEqual(config.whatsapp.appSecret, SECRET,
      'config.whatsapp.appSecret does not carry META_APP_SECRET');
    assert.strictEqual(config.meta, undefined,
      'config.meta now exists — if it is the real home for appSecret, whatsapp.js must be updated too');
  });

  await ok('an unsigned POST is REJECTED with 403, and writes nothing', async () => {
    // The whole point of the change: this is what used to be accepted.
    queries.length = 0;
    const res = await drive(fakeReq({ sig: undefined }));
    assert.deepStrictEqual(res.statuses, [403], 'an unsigned delivery was not rejected');
    assert.strictEqual(queries.length, 0, 'a rejected delivery still wrote to the database');
  });

  await ok('a forged signature is REJECTED with 403', async () => {
    const res = await drive(fakeReq({ sig: sign(RAW, 'wrong-secret') }));
    assert.deepStrictEqual(res.statuses, [403]);
  });

  await ok('a signature over a DIFFERENT body is rejected', async () => {
    const other = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2' }] }));
    const res = await drive(fakeReq({ rawBody: other, sig: sign(RAW) }));
    assert.deepStrictEqual(res.statuses, [403]);
  });

  await ok('a hostile signature header cannot crash the handler', async () => {
    // timingSafeEqual throws on length mismatch. A crash here is a 500, and a
    // 500 is exactly the outage this file exists to prevent.
    for (const sig of ['sha256=', 'sha256=zz', 'sha256=' + 'f'.repeat(500), 'garbage', '']) {
      const res = await drive(fakeReq({ sig }));
      assert.deepStrictEqual(res.statuses, [403], `hostile header "${sig.slice(0, 12)}" did not cleanly 403`);
    }
  });

  await ok('a missing raw body is OUR bug, and 403s without accusing Meta', async () => {
    const res = await drive(fakeReq({ rawBody: undefined, sig: sign(RAW) }));
    assert.deepStrictEqual(res.statuses, [403]);
  });

  await ok('with NO secret configured, a real delivery still gets through', async () => {
    // Fail-open is deliberate: dropping every patient message is a worse
    // outage than the exposure. But it has to actually work, and it runs a
    // different branch — which is precisely where the crash lived.
    const config = require('../config');
    const saved = config.whatsapp.appSecret;
    config.whatsapp.appSecret = undefined;
    try {
      const res = await drive(fakeReq({ sig: undefined }));
      assert.deepStrictEqual(res.statuses, [200],
        'unconfigured should allow-and-warn, not reject');
    } finally { config.whatsapp.appSecret = saved; }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
