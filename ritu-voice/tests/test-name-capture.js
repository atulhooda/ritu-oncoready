#!/usr/bin/env node
// ─── "मेरा नाम अतुल है" WAS STORED AS "your name" ───────────────────────────
// Two production calls, both with a PERFECT transcript:
//
//     "मेरा नाम अतुल है।"    -> patients.name = "your name"
//     "मेरा नाम अब्दुल है।"   -> patients.name = "your name"
//
// The STT was not at fault. The model echoed the question back as the answer,
// and nothing between it and the database disagreed — because brain-lean.js has
// TWO places that parse PATIENT_NAME and only one of them guarded it:
//
//     line ~882   const patientName = cleanPersonName(rawName);   // + logs rejects
//     line ~1416  patientName: nameMatch ? nameMatch[1]... : null // STREAMING
//
// The streaming path is the one production takes for a lean call. That is the
// FOURTH time in this file's history that one rule has lived in two places and
// the second copy has cost a production defect — see SENTINEL_NAMES in brain.js
// (four lists), patientIdentity.js (three patient resolvers).
//
// MEASURED on the patients table: "your name" x2, "[Patient Name]", "Unknown"
// x8, "ಅಪರಿಚಿತ", ".". cleanPersonName already returns null for every one of
// them; it was simply never called on this path.
//
// Not learning a name is a NORMAL outcome. Writing a fake one is how a caller
// gets greeted as "your name जी" on every future call.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
process.env.CLINIC_MODE = 'lean';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nNAME CAPTURE — a placeholder must never become a patient\n');

// STUB THE LLM BEFORE brain-lean IS REQUIRED. brain-lean.js:21 does
//     const { completeWithFailover, streamWithFailover } = require('./llm');
// — destructured at ITS require time — so replacing llm.streamWithFailover
// afterwards changes nothing it can see. Same trap as db.js's
// saveConfirmedMedication (tests/test-midreadback-history.js) and callHandler's
// destructured db imports. Seeding require.cache first is the only interception
// that the consumer actually observes.
const path = require('path');
const LLM = path.join(__dirname, '..', 'llm', 'index.js');
const realLlm = require(LLM);
let NEXT_CHUNKS = [];
require.cache[require.resolve(LLM)].exports = {
  ...realLlm,
  streamWithFailover: async function* () {
    for (const c of NEXT_CHUNKS) yield { content: c };
    yield { done: true };
  },
};

(async () => {
  const lean = require('../brain-lean.js');
  const { cleanPersonName } = require('../nameGuard.js');

  // Every junk value observed in the production patients table, plus the
  // template shapes the model emits when it echoes the prompt.
  const JUNK = ['your name', 'आपका नाम', 'naam', 'Patient', 'Patient Name', '[Patient Name]',
    '{{name}}', '<name>', 'Unknown', 'ಅಪರಿಚಿತ', '.', 'ji', 'हाँ'];
  const REAL = ['Atul', 'अतुल', 'Abdul', 'सिद्धार्थ', 'ದೀಕ್ಷಿತ', 'আদিত্য ঝা', 'Aman Nambaria'];

  // ── 1. the guard itself ─────────────────────────────────────────────────
  await ok('the guard rejects every junk value seen in production', () => {
    for (const j of JUNK) {
      assert.strictEqual(cleanPersonName(j), null,
        `${JSON.stringify(j)} would be stored as a person's name`);
    }
  });

  await ok('and still accepts real names, in every script', () => {
    for (const n of REAL) {
      assert(cleanPersonName(n), `${JSON.stringify(n)} was rejected as a name`);
    }
  });

  // ── 2. THE GAP: the streaming path is the one production takes ──────────
  // A pure-function test proves nothing if the caller never invokes it — that
  // is precisely how this defect survived a guard that already rejected it.
  const streamed = async (raw) => {
    NEXT_CHUNKS = raw.match(/[\s\S]{1,24}/g) || [raw];
    let done = null;
    for await (const ev of lean.getLeanResponseStream([{ role: 'user', content: 'x' }], '+918273500806', {
      clinicId: 'c1', callerPhone: '+918273500806', languageCode: 'hi-IN',
    })) {
      if (ev.kind === 'done') done = ev.result;
    }
    return done;
  };

  await ok('THE LIVE BUG: a streamed "your name" never becomes a patient', async () => {
    const r = await streamed('ठीक है जी।\nPATIENT_NAME:your name');
    assert(r, 'the stream produced no result');
    assert.strictEqual(r.patientName, null,
      `the streaming path stored ${JSON.stringify(r.patientName)} — this is the "मेरा नाम अतुल है" -> "your name" defect`);
  });

  await ok('a streamed template placeholder never becomes a patient', async () => {
    const r = await streamed('ठीक है जी।\nPATIENT_NAME:[Patient Name]');
    assert.strictEqual(r.patientName, null,
      `stored ${JSON.stringify(r.patientName)} — a prompt placeholder reached the record on a live Bengali call`);
  });

  await ok('a streamed REAL name still lands', async () => {
    const r = await streamed('नमस्ते अतुल जी।\nPATIENT_NAME:अतुल');
    assert.strictEqual(r.patientName, 'अतुल',
      `a real name was lost by the guard: ${JSON.stringify(r.patientName)}`);
  });

  await ok('a streamed name in a non-Devanagari script still lands', async () => {
    // The Kannada call (7da9c84c) is why: three renderings, all Kannada.
    const r = await streamed('ನಮಸ್ತೆ.\nPATIENT_NAME:ದೀಕ್ಷಿತ');
    assert.strictEqual(r.patientName, 'ದೀಕ್ಷಿತ',
      `a Kannada name was rejected: ${JSON.stringify(r.patientName)}`);
  });

  // ── 3. the two paths must agree, which is the actual lesson ─────────────
  await ok('the STREAMING and NON-STREAMING paths reach the same verdict', async () => {
    for (const v of ['your name', '[Patient Name]', 'अतुल', 'ದೀಕ್ಷಿತ', 'Unknown']) {
      const viaStream = (await streamed(`ok\nPATIENT_NAME:${v}`)).patientName;
      const viaDirect = await lean.processLeanRaw(`ok\nPATIENT_NAME:${v}`, {
        clinicId: 'c1', callerPhone: '+918273500806', languageCode: 'hi-IN',
      });
      assert.strictEqual(viaStream, viaDirect.patientName,
        `the two parse sites disagree on ${JSON.stringify(v)}: streaming=${JSON.stringify(viaStream)} direct=${JSON.stringify(viaDirect.patientName)} — ` +
        `one rule in two places is how this defect happened`);
    }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
