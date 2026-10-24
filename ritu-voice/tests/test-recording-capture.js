#!/usr/bin/env node
// ─── THE AUDIO WAS ONLY EVER KEPT WHEN SOMEBODY REMEMBERED ──────────────────
// Every accuracy number this project has produced came from calls.transcript,
// and the transcript IS the STT's output. "The STT lost it" has therefore been
// structurally invisible: we can see what Sarvam wrote, never what the caller
// said. capture-gap.js reports 46.2% of stated facts reaching the record, and
// that denominator only counts facts the STT already transcribed.
//
// MEASURED 2026-08-16: recording_url was set on 28 of 155 calls and NOT ONE of
// them by the server — every one fetched by hand, afterwards, by a person who
// had already noticed something wrong. The five most recent calls had no audio
// kept at all, including the Kannada caller recorded as ರಾಜಮ್ಮ after she said
// that was not her name. The evidence that would settle it expires on Exotel's
// retention clock.
//
// The calls worth listening to are not knowable in advance. That is the whole
// argument for doing this automatically.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.SKIP_BOOT_AUDIO = '1';

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nRECORDING CAPTURE — keeping the audio without being asked\n');

// A fake Exotel. The real API is IP-whitelisted to the deployment, so a test
// that reached the network would fail on every laptop AND in CI for a reason
// that has nothing to do with the code.
function stubFetch(plan) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (step.status && step.status !== 200) return { ok: false, status: step.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ Call: { RecordingUrl: step.url || null } }) };
  };
  return calls;
}

// A pool that records what was written, so the assertion is on the WRITE and
// not on the function having been entered.
function stubPool() {
  const writes = [];
  return { writes, query: async (sql, args) => { writes.push({ sql, args }); return { rowCount: 1, rows: [] }; } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { captureRecordingUrl, recordingUrlFor } = require('../exotelRecording.js');

(async () => {

  // ── 1. THE HAPPY PATH, THROUGH THE REAL FUNCTION ─────────────────────────
  await ok('a recording that exists is written to the call row', async () => {
    stubFetch([{ url: 'https://recordings.exotel.com/abc.mp3' }]);
    const pool = stubPool();
    captureRecordingUrl(pool, 'sid_ok', { delays: [5, 10, 15] });
    await wait(60);
    assert.strictEqual(pool.writes.length, 1, `expected one UPDATE, got ${pool.writes.length}`);
    assert(/UPDATE calls SET recording_url/.test(pool.writes[0].sql), pool.writes[0].sql);
    assert.deepStrictEqual(pool.writes[0].args, ['https://recordings.exotel.com/abc.mp3', 'sid_ok']);
  });

  // ── 2. THE REASON IT RETRIES AT ALL ──────────────────────────────────────
  await ok('NOT-YET IS NOT NO: a null first answer is retried, and the later URL is kept', async () => {
    // Exotel finishes writing the recording after the call ends. A single fetch
    // at hangup returns null, which reads as "this call has no recording" when
    // it means "come back in a moment". This is the whole reason the 28 rows
    // were hand-fetched minutes later and none were captured at hangup.
    stubFetch([{ url: null }, { url: null }, { url: 'https://recordings.exotel.com/late.mp3' }]);
    const pool = stubPool();
    captureRecordingUrl(pool, 'sid_late', { delays: [5, 10, 15] });
    await wait(120);
    assert.strictEqual(pool.writes.length, 1, 'the late recording was never stored');
    assert.strictEqual(pool.writes[0].args[0], 'https://recordings.exotel.com/late.mp3');
  });

  await ok('it gives up after the configured attempts — no unbounded polling', async () => {
    const seen = stubFetch([{ url: null }]);
    const pool = stubPool();
    captureRecordingUrl(pool, 'sid_never', { delays: [5, 10, 15] });
    await wait(150);
    assert.strictEqual(seen.length, 3, `expected exactly 3 attempts, got ${seen.length}`);
    assert.strictEqual(pool.writes.length, 0, 'wrote a row despite never getting a URL');
  });

  // ── 3. IT MUST NOT BE ABLE TO HURT A FINISHED CALL ───────────────────────
  await ok('a telephony API failure is contained — no throw, no write', async () => {
    stubFetch([{ status: 500 }]);
    const pool = stubPool();
    captureRecordingUrl(pool, 'sid_500', { delays: [5, 10, 15] });
    await wait(120);
    assert.strictEqual(pool.writes.length, 0);
  });

  await ok('a network error is contained too', async () => {
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    const pool = stubPool();
    captureRecordingUrl(pool, 'sid_net', { delays: [5, 10, 15] });
    await wait(120);
    assert.strictEqual(pool.writes.length, 0);
  });

  await ok('a write failure is reported as a WRITE failure, not a fetch failure', async () => {
    // THIS TEST WAS VACUOUS ON ITS FIRST DRAFT. It asserted "the DB error does
    // not escape", and mutation proved it green with the inner catch REMOVED —
    // because schedule() already wraps tryOnce() in .catch(), so containment
    // was never the inner catch's job. What the inner catch actually buys is
    // the diagnostic: "we reached Exotel, got a URL, and failed to store it" is
    // a different outage from "we could not reach Exotel", and only the message
    // distinguishes them at 2am. So assert the message.
    stubFetch([{ url: 'https://recordings.exotel.com/x.mp3' }]);
    const pool = { query: async () => { throw new Error('connection terminated'); } };
    const seen = [];
    const realErr = console.error;
    console.error = (...a) => seen.push(a.join(' '));
    try {
      captureRecordingUrl(pool, 'sid_dbfail', { delays: [5, 10, 15] });
      await wait(60);
    } finally { console.error = realErr; }
    assert(seen.some((l) => /fetch OK but write failed/.test(l)),
      `the failure was not attributed to the write: ${JSON.stringify(seen)}`);
    assert(seen.some((l) => /connection terminated/.test(l)),
      'the underlying database error was swallowed without being named');
  });

  await ok('no callSid and no pool are no-ops, not crashes', async () => {
    captureRecordingUrl(null, 'sid');
    captureRecordingUrl(stubPool(), null);
    captureRecordingUrl(stubPool(), '');
  });

  // ── 4. THE 401 THAT SENDS PEOPLE LOOKING IN THE WRONG PLACE ──────────────
  await ok('a 401 says it is IP whitelisting, not bad credentials', async () => {
    stubFetch([{ status: 401 }]);
    const { err } = await recordingUrlFor('sid_401');
    assert(err && /whitelist/i.test(err),
      `a developer seeing this on their laptop will go and rotate working credentials: ${err}`);
  });

  // ── 5. THE WIRING — the part that was missing, not the function ──────────
  await ok('crm.logCall actually calls it — the function existing is not the fix', async () => {
    // The capture function could be perfect and never run. That was precisely
    // the state before: tools/fetch-recording.js worked fine and nothing invoked it.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'crm.js'), 'utf8');
    assert(/require\('\.\/exotelRecording'\)/.test(src), 'crm.js does not import the capture at all');
    assert(/captureRecordingUrl\(db\.pool, callData\.callSid\)/.test(src),
      'crm.logCall no longer captures the recording — every future call loses its audio');
    const afterLog = src.indexOf('captureRecordingUrl(db.pool');
    const atLog = src.indexOf('await db.logCallToDb(callData)');
    assert(atLog > 0 && afterLog > atLog,
      'the capture runs BEFORE the row is inserted — the UPDATE would match nothing');
  });

  await ok('ONE construction of the Exotel URL, not a fourth copy', async () => {
    // fetch-recording.js, transcribe-truth.js and config.js each had their own
    // host default before this. A fourth would be the eighth duplicated rule
    // this repo has paid for.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'exotelRecording.js'), 'utf8');
    assert(/\/v1\/Accounts\/.*\/Calls\//.test(src), 'the endpoint construction moved out of the shared module');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
