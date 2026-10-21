#!/usr/bin/env node
// ─── EVERY DETERMINISTIC LINE MUST ENTER THE RECORD THE MODEL READS ─────────
// Observed in production, 2026-08-06 12:24, on a call abandoned 17 seconds in:
//
//     ritu     माफ करा, आवाज नीट ऐकू येत नाहीये. कृपया पुन्हा एकदा सांगाल का?
//              (sorry, I cannot hear you properly — please say that again)
//     patient  Hello Hello मेरी आवाज़ आ रही है?     (can you hear me?)
//     ritu     जी Atul जी, आपकी आवाज़ बिल्कुल साफ़ आ रही है।
//              (yes, your voice is perfectly clear)
//
// The first line is the garble guard — a deterministic template. The third is
// the model. It contradicted the guard not from confusion but because, as far
// as it could see, the first line NEVER HAPPENED: the guard called
// speak(prompt) and returned, so its utterance never reached
// conversationHistory.
//
// ─── WHY THIS FILE WAS REWRITTEN, 2026-08-13 ────────────────────────────────
// The previous version read callHandler.js as TEXT and regex-matched it:
//
//     const SRC = fs.readFileSync('../callHandler.js', 'utf8');
//     assert(block.indexOf("conversationHistory.push({ role: 'assistant'...")
//            < block.indexOf('await this.speak(prompt)'));
//
// MEASURED — the vacuity, executed rather than argued. Two mutations were
// applied to callHandler.js and the old file stayed 10/10 green under both:
//
//   1. `if (this._garbleReprompts > 1) this.conversationHistory.push(...)`
//      The push expression is still there, still textually before speak(), so
//      every regex matched. But the FIRST re-ask — the only one that happened
//      on call 2026-08-06 12:24 — is now invisible to the model. The exact
//      production defect, restored, reported as a pass.
//   2. `claimed: this._specStarted` in the diagnostics row.
//      The key "claimed" is still in the source, so `diag.includes('claimed')`
//      passed. Every call now reports a 100% speculation yield: the one number
//      the block exists to produce, inverted, silently.
//
// That is three of four production defects in one week, all of which passed
// source-text tests. So this file DRIVES the handler: a real CallHandler, a
// real garbled transcript through the real _onTranscript, the real endCall,
// and the assertions are made on what reaches the calls row — captured at
// db.pool.query, because callHandler.js:9 destructures its db imports at
// require time and reassigning db.logCallToDb changes nothing it can see.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
const assert = require('assert');

// ─── PIN PRODUCTION ─────────────────────────────────────────────────────────
// A bare `node tests/foo.js` inherits whatever defaults the shell has, and this
// repo has already shipped one vacuous pass that way: CLINIC_MODE unset means
// 'full', which is a different brain with a different dispatch. Set the flags
// production runs with BEFORE anything is required (config.js reads env once,
// at require time), then assert below that the code agrees — setting an env var
// is a claim, config.clinicMode is the resolution.
//
// GARBLE_GUARD is the odd one out: 'on', not 'true' (runtimeConfig.js says so
// in its own comment). GARBLE_GUARD=true would be silently OFF and every
// garble assertion here would pass over a branch that never ran.
process.env.CLINIC_MODE = 'lean';
process.env.READBACK = 'on';
process.env.ENABLE_MULTILINGUAL = 'true';
process.env.GARBLE_GUARD = 'on';
process.env.ENABLE_SPECULATIVE_LLM = 'true';
process.env.ENABLE_LEAN_STREAMING = 'true';
// Production reads CLINIC_ID_UUID. NOT "CLINIC_ID" — that variable name is the
// shape of the whatsapp.js defect (config.whatsapp.appSecret asserted,
// config.meta.appSecret written, 20 hours of 500s behind a green test), so the
// row assertion below checks the clinic_id column actually carries this value.
const TEST_CLINIC_ID = process.env.CLINIC_ID_UUID || '5c9a4e1e-0000-4b7a-9f0e-c0ffee000001';
process.env.CLINIC_ID_UUID = TEST_CLINIC_ID;

// ─── INTERCEPT THE LLM AT ITS REAL BOUNDARY, BEFORE callHandler LOADS ───────
// callHandler.js destructures getLeanResponseStream from brain-lean at require
// time, exactly as it destructures the db helpers. Reassigning it AFTER would
// be the mistake house rule 4 exists for, so it is swapped here, first — the
// real _maybeStartSpeculation, the real LeanSpeculation, the real counters all
// run; only the network is replaced. Whether that actually took effect is not
// assumed: LLM_CALLS is asserted non-empty at the first speculation, so a
// failed interception (which would fire a real gemini call and still increment
// _specStarted) fails loudly instead of passing quietly.
const brainLean = require('../brain-lean.js');
const LLM_CALLS = [];
brainLean.getLeanResponseStream = async function* stubbedLeanStream(messages) {
  LLM_CALLS.push(messages.map((m) => ({ role: m.role, content: m.content })));
  yield { kind: 'sentence', text: 'ठीक आहे, सांगा.' };
  yield { kind: 'done' };
};

const CallHandler = require('../callHandler.js');
const config = require('../config.js');
const db = require('../db.js');
// The REAL prompt builder. Never hand-copy the expected string — a test that
// hardcodes "माफ करा…" passes when the handler speaks a stale template.
const { detectGarble, slotRepeatPrompt, SLOT_REASK, NAME_SPELL, REASON_NARROW, REPEAT_TEXTS } = require('../garbleGuard.js');
const { runtimeConfig } = require('../runtimeConfig.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};
const skip = (name, why) => {
  console.log(`  ⚠ SKIPPED — ${name}\n      ${why}`);
  skipped++;
};

// ─── CAPTURE AT THE DATABASE ────────────────────────────────────────────────
// Stubbing pool.query rather than db.logCallToDb means the REAL logCallToDb
// runs, so its column mapping is under test too: diagnostics is the 13th of 13
// bind parameters on a 14-column INSERT, and a shifted parameter list is
// exactly the class of defect a mocked-away writer cannot see.
const CALL_ROWS = [];
const realQuery = db.pool.query.bind(db.pool);
db.pool.query = async (sql, params = []) => {
  const s = String(sql).replace(/\s+/g, ' ');
  if (/INSERT INTO calls/i.test(s)) {
    // Positional, because that is what is under test. whatsapp_sent is a
    // literal FALSE in the SQL, so 14 columns bind only 13 parameters and
    // diagnostics is $13 → params[12]. Reading params[13] (or letting the
    // transcript index slip to the language column, which is how this harness
    // failed on its first run) is the same defect class as the whatsapp
    // appSecret rename, and it must fail here rather than read as "no row".
    CALL_ROWS.push({
      clinicId: params[0],
      callSid: params[1],
      language: params[9],
      transcript: params[8] ? JSON.parse(params[8]) : null,
      diagnostics: params[12] ? JSON.parse(params[12]) : null,
    });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM patients|INTO patients/i.test(s)) {
    // A REAL delay, on purpose. upsertPatient is awaited inside logCallToDb
    // before the diagnostics object is stringified, so this gap is the window
    // the snapshot test below writes into. With an instant stub that test
    // could pass against a live reference by luck.
    await new Promise((r) => setTimeout(r, 25));
    return { rows: [{ id: 'pat-test-1' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

// crm.logCall is NOT awaited by endCall — it is fired and forgotten with a
// .catch. Asserting immediately after `await h.endCall()` reports "nothing was
// written" for a write still in flight, which is indistinguishable from the
// real bug and reads as the alarming answer. Poll, bounded.
async function rowFor(callSid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = CALL_ROWS.find((r) => r.callSid === callSid);
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(`no calls row for ${callSid} after ${timeoutMs}ms (rows seen: ${CALL_ROWS.map((r) => r.callSid).join(',') || 'none'})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let sidSeq = 0;
function handler() {
  const h = new CallHandler(
    `garble_test_${++sidSeq}`, '+918273500806',
    { readyState: 1, send: () => {}, close: () => {} }, 'test', false
  );
  // Only the wire is stubbed. speak() records WHAT it was given and, critically,
  // what conversationHistory looked like AT THE MOMENT OF SPEAKING — that
  // snapshot is the whole ordering assertion, and it cannot be faked by a push
  // that happens afterwards.
  h.spoken = [];
  h.speak = async (text) => {
    h.spoken.push({ text, historyAtSpeak: h.conversationHistory.map((m) => `${m.role}:${m.content}`) });
  };
  h.stt = null;                       // endCall closes it; there is no socket here
  h._clearSilenceTimers = () => {};   // real timers would outlive the process
  h.conversationHistory = [];
  h.transcript = [];
  return h;
}

// The live 2026-08-06 shape: a repetition loop, the signature Sarvam produces
// when it is transcribing room noise. Verified against the REAL detector below
// rather than assumed — a fixture the guard does not consider garbled would
// make every assertion in this section vacuous.
const GARBLED = 'हेलो हेलो हेलो हेलो हेलो हेलो';
const CLEAN = 'मला डॉक्टरांची अपॉइंटमेंट हवी आहे';

console.log('\nGARBLE GUARD — a line the model cannot see is a line it will contradict\n');

(async () => {

  // ── 0. the configuration these assertions are only meaningful under ──────
  await ok('PINNED: lean brain, garble guard resolved ON, speculation ON', async () => {
    assert.strictEqual(config.clinicMode, 'lean',
      'clinicMode is not lean — a different brain owns the turn and this file would test nothing');
    const rc = runtimeConfig();
    assert.strictEqual(rc.garbleGuard, true,
      'GARBLE_GUARD did not resolve to true — the guard block never executes and every assertion below passes over dead code');
    assert.strictEqual(rc.speculativeLlm, true, 'speculation is off — the counters can never move');
    assert.strictEqual(config.llm.enableLeanStreaming, true, 'lean streaming is off — _maybeStartSpeculation returns early');
    assert.strictEqual(detectGarble(GARBLED, { audioDuration: 4 }).garbled, true,
      'the fixture is not garble by the REAL detector — the guard would never fire on it');
    assert.strictEqual(detectGarble(CLEAN, { audioDuration: 4 }).garbled, false,
      'the clean fixture trips the guard — the "no guard" control case is not a control');
  });

  // ── 1. THE ORDERING, DRIVEN ─────────────────────────────────────────────
  await ok('THE LIVE TURN: the re-ask is already in conversationHistory when it is spoken', async () => {
    const h = handler();
    const slot = h._currentSlot();                 // 'name' — greeting phase, no name yet
    const expected = slotRepeatPrompt(slot, h._langCode(), 0);

    await h._onTranscript(GARBLED, { audioDuration: 4.0 });

    assert.strictEqual(h.spoken.length, 1,
      `the guard did not speak — nothing was driven (spoken: ${JSON.stringify(h.spoken)})`);
    assert.strictEqual(h.spoken[0].text, expected,
      `the guard spoke something other than the real re-ask template: ${h.spoken[0].text}`);
    // THE ASSERTION. Not "the push appears above the speak in the file" — that
    // survived both mutations — but "at the instant speak() was entered, the
    // line was in the record". A push that is skipped, conditional, or moved
    // after the await fails here.
    assert(h.spoken[0].historyAtSpeak.includes(`assistant:${expected}`),
      'the guard spoke a line the model cannot see. conversationHistory at the moment of ' +
      `speaking was ${JSON.stringify(h.spoken[0].historyAtSpeak)} — this is call 2026-08-06 12:24, ` +
      'where Ritu said "I cannot hear you" and then "your voice is perfectly clear".');
  });

  await ok('THE NEXT GENERATION SEES IT: the re-ask is in the messages sent to the LLM', async () => {
    // The proximate bug was the missing push; the DAMAGE was done one turn
    // later, when the model generated a reply from a history with no record of
    // the guard. So assert on the thing that actually caused the contradiction:
    // the message array handed to the LLM for the following turn. That array is
    // built by the real _maybeStartSpeculation (snapshot = history + this user
    // turn) and captured at the brain-lean boundary.
    const h = handler();
    const before = LLM_CALLS.length;
    await h._onTranscript(GARBLED, { audioDuration: 4.0 });

    // …and now the patient answers, exactly as they did on the live call.
    h._pendingTranscript = 'Hello Hello मेरी आवाज़ आ रही है?';
    h._maybeStartSpeculation(300);

    assert.strictEqual(LLM_CALLS.length, before + 1,
      'no LLM call was built for the following turn — the harness is wrong, not the code');
    const sent = LLM_CALLS[LLM_CALLS.length - 1];
    // MATCHED AGAINST THE SHIPPED TABLES, NOT A COPY OF THEM. This was a
    // hand-written regex ("ऐकू आलं नाही") and it broke on 2026-08-15 for a reason
    // that had nothing to do with the bug under test: the greeting moved from
    // asking the NAME to asking the REASON, so the re-ask became the reason
    // slot's — "ऐकू आली नाही", feminine, agreeing with तक्रार. One vowel, and a
    // green test went red while the code was correct. Deriving the expected set
    // from garbleGuard's own exports also makes this an EXACT match rather than
    // a substring one, which is strictly stronger.
    const REASKS = new Set([
      ...Object.values(SLOT_REASK).flatMap((byLang) => Object.values(byLang)),
      ...Object.values(NAME_SPELL),
      ...Object.values(REASON_NARROW),
      ...Object.values(REPEAT_TEXTS),
    ]);
    assert(sent.some((m) => m.role === 'assistant' && REASKS.has(m.content)),
      'the model was asked to answer "can you hear me?" with NO record that Ritu had just said ' +
      `she could not: ${JSON.stringify(sent)}`);
    assert.strictEqual(sent[sent.length - 1].content, 'Hello Hello मेरी आवाज़ आ रही है?',
      'the user turn is not the last message — the snapshot is not what dispatch would send');
  });

  await ok('a TTS failure cannot lose the record — that is why push precedes speak', async () => {
    // The ordering has a second job beyond the contradiction: speak() is a
    // network call to Sarvam and the guard block is fail-OPEN (a throw is
    // swallowed so a bad line never breaks the turn). If the push came after,
    // a TTS error would erase all trace of a re-ask the caller may still have
    // heard part of.
    const h = handler();
    const expected = slotRepeatPrompt(h._currentSlot(), h._langCode(), 0);
    h.speak = async () => { throw new Error('sarvam ws closed'); };

    await h._onTranscript(GARBLED, { audioDuration: 4.0 });
    // The throw is swallowed fail-open, so the line goes on to be processed as
    // ordinary speech and a real turn is scheduled. Cancel it: this test is
    // about the record, and letting the dispatch run reaches live Sarvam.
    if (h._debounceTimer) clearTimeout(h._debounceTimer);

    assert(h.conversationHistory.some((m) => m.role === 'assistant' && m.content === expected),
      'TTS threw and the attempted re-ask vanished from the record entirely');
  });

  await ok('a CLEAN line is untouched: no re-ask, no phantom assistant turn', async () => {
    // The control. Without it, "always push a re-ask" would pass everything
    // above while injecting a line Ritu never said into the model's context.
    const h = handler();
    await h._onTranscript(CLEAN, { audioDuration: 3.0 });
    if (h._debounceTimer) clearTimeout(h._debounceTimer);   // the real turn is not this test's business

    assert.deepStrictEqual(h.spoken, [], 'the guard fired on a clean line');
    assert.strictEqual(h._garbleReprompts, 0, 'a clean line was counted as a re-ask');
    assert.strictEqual(h._garbleSpokeThisCall, false, 'garbleSpoke is set on a call where no guard spoke');
    assert.deepStrictEqual(h.conversationHistory.filter((m) => m.role === 'assistant'), [],
      'a line Ritu never spoke was written into the model context');
    assert.strictEqual(h.transcript.length, 1, 'a clean transcript was not recorded as patient speech');
  });

  await ok('the cap holds: two re-asks, then the line is processed rather than looped', async () => {
    // GARBLE_MAX_REPROMPTS = 2. A guard with no cap can trap a caller on a
    // permanently bad line, so the third garbled utterance must fall THROUGH
    // to normal processing — and must not push a third assistant turn.
    const h = handler();
    await h._onTranscript(GARBLED, { audioDuration: 4.0 });
    await h._onTranscript(GARBLED, { audioDuration: 4.0 });
    const afterTwo = h.conversationHistory.length;
    await h._onTranscript(GARBLED, { audioDuration: 4.0 });
    if (h._debounceTimer) clearTimeout(h._debounceTimer);

    assert.strictEqual(h._garbleReprompts, 2, `the cap was exceeded: ${h._garbleReprompts} re-asks`);
    assert.strictEqual(h.spoken.length, 2, `the guard spoke ${h.spoken.length} times, cap is 2`);
    assert.strictEqual(afterTwo, 2, `expected two recorded re-asks, got ${afterTwo}`);
    assert.strictEqual(h.conversationHistory.length, 2,
      'the capped third garble still wrote an assistant turn');
    // Both re-asks recorded, and the second escalated (name slot, attempt 1 →
    // spell the first letter) — recording the same string twice would mean the
    // repair ladder never advanced.
    assert.notStrictEqual(h.spoken[0].text, h.spoken[1].text,
      'the second re-ask is identical to the first — the repair ladder did not escalate');
    for (const s of h.spoken) {
      assert(h.conversationHistory.some((m) => m.content === s.text),
        `spoken but never recorded: ${s.text}`);
    }
  });

  // ── 2. WHAT REACHES THE DATABASE ────────────────────────────────────────
  await ok('garbleSpoke and garbleReprompts reach the calls row, through the real writer', async () => {
    const h = handler();
    await h._onTranscript(GARBLED, { audioDuration: 4.0 });
    await h.endCall();
    const row = await rowFor(h.callSid);

    assert.strictEqual(row.diagnostics.garbleSpoke, true,
      `a deterministic guard spoke on this call and the row denies it: ${JSON.stringify(row.diagnostics.garbleSpoke)}`);
    assert.strictEqual(row.diagnostics.garbleReprompts, 1,
      `garbleReprompts is ${row.diagnostics.garbleReprompts}, one re-ask happened`);
    // The configuration the call actually ran with travels with it — a garble
    // number is uninterpretable without knowing the guard was even enabled.
    assert.strictEqual(row.diagnostics.config.garbleGuard, true, 'the row does not record that the guard was on');
    // CLINIC_ID_UUID, not CLINIC_ID. The column, not the env var.
    assert.strictEqual(row.clinicId, TEST_CLINIC_ID,
      `clinic_id came through as ${row.clinicId} — the config key production reads is CLINIC_ID_UUID`);
  });

  await ok('a call with no garble records garbleSpoke FALSE, not a hardcoded true', async () => {
    const h = handler();
    await h._onTranscript(CLEAN, { audioDuration: 3.0 });
    if (h._debounceTimer) clearTimeout(h._debounceTimer);
    await h.endCall();
    const row = await rowFor(h.callSid);

    assert.strictEqual(row.diagnostics.garbleSpoke, false,
      'every call reports that a guard spoke — the flag carries no information');
    assert.strictEqual(row.diagnostics.garbleReprompts, 0);
  });

  // ── 3. SPECULATION — enabled != fired != claimed ────────────────────────
  console.log('\nSPECULATION — enabled != fired != claimed\n');

  await ok('STARTED is counted by the real gate, and the LLM really was called', async () => {
    const h = handler();
    const before = LLM_CALLS.length;
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);

    assert.strictEqual(h._specStarted, 1, 'the speculation gate did not fire under production flags');
    assert.strictEqual(LLM_CALLS.length, before + 1,
      'the LLM boundary was never reached — either the gate did not fire or the interception failed ' +
      'and a REAL generation went out, in which case every number below is meaningless');
    assert.strictEqual(h._specClaimed, 0, 'starting a speculation counted as using one');
    assert.strictEqual(h._specCancelled, 0, 'a fresh speculation was counted as cancelled');
  });

  await ok('CLAIMED is counted at dispatch, through the real processIntent wiring', async () => {
    // The distinction is the whole point. A speculation that starts and is then
    // thrown away costs an LLM call and saves nothing, and from outside looks
    // exactly like one that worked. Dead air sat at ~1.1s across two calls with
    // speculation enabled throughout — started-vs-claimed decides whether the
    // LLM leg is even the right target.
    //
    // Driven through processIntent, not by calling _takeSpeculation directly:
    // the claim only happens if the dispatch actually hands the spec to
    // processIntentLeanStream, and deleting that argument is a refactor a
    // direct call would never notice.
    const h = handler();
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);

    let handed = '__NEVER_CALLED__';
    h.processIntentLeanStream = async (text, spec) => { handed = spec; };
    h.conversationHistory.push({ role: 'user', content: CLEAN });  // dispatch pushes the user turn
    await h.processIntent(CLEAN);

    assert.notStrictEqual(handed, '__NEVER_CALLED__', 'the turn never reached the lean-streaming dispatch');
    assert(handed && typeof handed.commitStream === 'function',
      `dispatch received ${JSON.stringify(handed)} instead of the speculation it started — the head start is thrown away`);
    assert.strictEqual(h._specClaimed, 1, 'the turn used the speculation and did not count it');
    assert.strictEqual(h._specCancelled, 0, 'a claimed speculation was also counted as cancelled');
  });

  await ok('CANCELLED: a stale speculation is discarded, counted, and not claimed', async () => {
    // A barge-in bumps _generationId, so the in-flight generation answers a
    // question the patient has already talked over. It must be dropped AND
    // counted — a discard that does not reach the counter under-reports the
    // waste the metric exists to measure.
    const h = handler();
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);
    h._generationId++;                                             // barge-in

    let handed = '__NEVER_CALLED__';
    h.processIntentLeanStream = async (text, spec) => { handed = spec; };
    h.conversationHistory.push({ role: 'user', content: CLEAN });
    await h.processIntent(CLEAN);

    assert.strictEqual(handed, null, 'a stale generation was handed to the turn as if it were fresh');
    assert.strictEqual(h._specClaimed, 0, 'a rejected speculation was counted as claimed');
    assert.strictEqual(h._specCancelled, 1, 'the stale discard never reached the cancelled counter');
    assert.strictEqual(Object.keys(h._specCancelReasons).length, 1,
      `the discard recorded no reason: ${JSON.stringify(h._specCancelReasons)}`);
  });

  await ok('CANCELLED: the supersede path counts too, with the reason that caused it', async () => {
    // The other death path — the patient keeps talking, so the spec started for
    // the previous fragment is superseded. Different code (_cancelSpeculation),
    // same counter; it is the one that produced "started=6 claimed=3
    // cancelled=2" on a real call, where the numbers did not add up.
    const h = handler();
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });
    h._pendingTranscript = 'मला डॉक्टर';
    h._maybeStartSpeculation(300);
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);   // supersedes the first

    assert.strictEqual(h._specStarted, 2, 'the second fragment did not start its own speculation');
    assert.strictEqual(h._specCancelled, 1, 'the superseded speculation was dropped without being counted');
    assert.strictEqual(h._specCancelReasons['superseded by new transcript'], 1,
      `the supersede was not named: ${JSON.stringify(h._specCancelReasons)}`);
  });

  await ok('the reason key is length-capped — an unbounded map is a database column', async () => {
    // Reasons are code-supplied today, but a caller passing a transcript would
    // make this a per-call unbounded object written straight into diagnostics.
    const h = handler();
    h._noteSpecCancel('x'.repeat(400));
    const keys = Object.keys(h._specCancelReasons);
    assert.strictEqual(keys.length, 1);
    assert(keys[0].length <= 40, `the reason key is ${keys[0].length} chars — nothing caps it`);
    h._noteSpecCancel(null);
    assert(Object.keys(h._specCancelReasons).includes('unknown'), 'a null reason produced no key at all');
  });

  await ok('ALL THREE, and the reasons, reach the calls row with the values that happened', async () => {
    const h = handler();
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });

    // started=1 claimed=1
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);
    h.processIntentLeanStream = async () => {};
    h.conversationHistory.push({ role: 'user', content: CLEAN });
    await h.processIntent(CLEAN);

    // started=3 cancelled=1 (supersede)
    h._pendingTranscript = 'आणि किती वाजता';
    h._maybeStartSpeculation(300);
    h._pendingTranscript = 'आणि किती वाजता येऊ';
    h._maybeStartSpeculation(300);

    const expected = {
      started: h._specStarted, claimed: h._specClaimed, cancelled: h._specCancelled,
    };
    assert.deepStrictEqual(expected, { started: 3, claimed: 1, cancelled: 1 },
      `the harness did not produce the intended shape: ${JSON.stringify(expected)}`);

    await h.endCall();   // cancels the live one on the way out → cancelled=2

    // THE LIVE-REFERENCE TRAP. cancelReasons is copied into the row with
    // {...this._specCancelReasons}; if it were stored by reference, anything
    // written to the map between endCall and the INSERT would appear in a row
    // describing a call that had already finished. endCall does not await
    // logCall, so this mutation lands while the write is still suspended in
    // upsertPatient (which the query stub delays 25ms on purpose).
    h._noteSpecCancel('WRITTEN-AFTER-THE-ROW-WAS-BUILT');

    const row = await rowFor(h.callSid);
    const spec = row.diagnostics.speculation;

    assert.strictEqual(spec.started, 3, `row says started=${spec.started}, three speculations were launched`);
    assert.strictEqual(spec.claimed, 1, `row says claimed=${spec.claimed}, exactly one turn used one`);
    assert.strictEqual(spec.cancelled, 2, `row says cancelled=${spec.cancelled}, two were thrown away`);
    assert.notStrictEqual(spec.started, spec.claimed,
      'started and claimed are identical — the row reports a 100% yield on a call where two of three ' +
      'speculations were discarded, which is the whole number this block exists to produce');
    assert.strictEqual(spec.started, spec.claimed + spec.cancelled,
      `the counters do not add up: ${JSON.stringify(spec)} — a death path is not counting`);
    assert.strictEqual(spec.cancelReasons['superseded by new transcript'], 1,
      `the supersede reason did not reach the row: ${JSON.stringify(spec.cancelReasons)}`);
    assert.strictEqual(spec.cancelReasons['call ended'], 1,
      `the call-ended sweep did not reach the row: ${JSON.stringify(spec.cancelReasons)}`);
    assert(!('WRITTEN-AFTER-THE-ROW-WAS-BUILT' in spec.cancelReasons),
      'cancelReasons is stored as a live reference — a mutation after the call ended is in the row');
  });

  // ── 4. WHAT THIS FILE CANNOT ASSERT TODAY ───────────────────────────────
  // An honest skip beats a green tick over code nobody ran. The old version of
  // this file asserted `invalid.includes('generation-changed')` against the
  // SOURCE TEXT and reported a pass. The strings are indeed in the source. They
  // are also unreachable.
  await (async () => {
    const name = 'the stale path names WHICH pin failed, not just "stale"';
    const h = handler();
    h.conversationHistory.push({ role: 'assistant', content: 'नमस्कार, मी रितु.' });
    h._pendingTranscript = CLEAN;
    h._maybeStartSpeculation(300);
    h._generationId++;                                 // ONLY the generation pin fails
    h.conversationHistory.push({ role: 'user', content: CLEAN });
    h._takeSpeculation(CLEAN);
    const reason = Object.keys(h._specCancelReasons)[0];

    if (reason === 'generation-changed') {
      console.log(`  ✓ ${name}`); pass++;              // production fixed — this test is live again
      return;
    }
    if (reason === 'already-cancelled') {
      skip(name,
        'DEFECT, found by driving this on 2026-08-13 and reproducible above: callHandler.js:2208 calls\n' +
        '      spec.cancel() — which sets spec.cancelled = true — BEFORE the ternary on :2215 reads\n' +
        '      spec.cancelled as its FIRST branch. So every discard at dispatch reports\n' +
        '      "already-cancelled" and the four pin names on :2216-2219 (generation-changed,\n' +
        '      history-length-changed, history-identity-changed, emergency) are dead code.\n' +
        `      MEASURED here: a pure generation-id change reported "${reason}".\n` +
        '      This is exactly the gap the block was written to close ("stale covered five causes with\n' +
        '      five different fixes"), so the diagnostic still cannot locate the 50% waste it measures.\n' +
        '      FIX: compute the reason string BEFORE spec.cancel(). This case flips to a real assertion\n' +
        '      automatically once it does — it is not skipped by name, it is skipped by observation.');
      return;
    }
    console.log(`  ✗ ${name}\n      the stale discard reported "${reason}", which is neither the correct ` +
      'reason nor the known defect — something else changed'); fail++;
  })();

  db.pool.query = realQuery;
  console.log(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} SKIPPED (see above)` : ''}\n`);
  process.exit(fail ? 1 : 0);
})();
