#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ONCOREADY BROWSER SESSIONS — the contract, and the call path, driven.
//
// Two halves:
//   1. oncoreadyIntake.js on its own: signatures, request validation, single-use
//      tokens, the prompt, sentinel stripping, the result payload, the retrying
//      callback.
//   2. A real CallHandler in intake mode, with the LLM, STT and TTS stubbed:
//      the session opens in the requested language, every turn goes to the
//      intake prompt (never the booking brain), END_CALL ends it, a stray
//      BOOK_APPOINTMENT is neither spoken nor acted on, and endCall sends the
//      result to OncoReady INSTEAD of writing the clinic's call log.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');
process.env.SKIP_BOOT_AUDIO = '1';
process.env.ONCOREADY_SHARED_SECRET = 'test-secret';
const assert = require('assert');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const SCRIPT = {
  purpose: 'pre_visit_intake',
  rules: ['Collect information only. Never diagnose.'],
  steps: [
    { id: 'current_symptoms', goal: 'Every symptom now: what, since when, how bad.', prompts: ['What problems are you having right now?'] },
    { id: 'previous_records', goal: 'Which earlier records they have.', prompts: ['Do you have earlier reports?'] },
  ],
  closing: 'Thank you, I will share this with your doctor.',
};
const REQUEST = {
  external_ref: 'oncoready:org-1:sess-1',
  language: 'hi-IN',
  context: { patient_display_name: 'Maria Placeholder', clinic_display_name: 'Demo clinic' },
  script: SCRIPT,
  callback_url: 'http://oncoready.test/integrations/ritu/sessions',
  max_duration_s: 600,
};

(async () => {
  const oncoready = require('../oncoreadyIntake');

  console.log('\nONCOREADY — contract\n');

  await check('signature: valid passes; wrong secret, tampered body, stale timestamp fail', () => {
    const body = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    assert.ok(oncoready.verify(ts, oncoready.sign(ts, body), body));
    assert.ok(!oncoready.verify(ts, oncoready.sign(ts, body, 'other'), body));
    assert.ok(!oncoready.verify(ts, oncoready.sign(ts, body), body + ' '));
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    assert.ok(!oncoready.verify(old, oncoready.sign(old, body), body));
    assert.ok(!oncoready.verify(ts, 'zz-not-hex', body));
  });

  await check('request validation: language, callback URL, steps', () => {
    assert.ok(oncoready.validateRequest(REQUEST).value);
    assert.match(oncoready.validateRequest({ ...REQUEST, language: 'fr-FR' }).error, /language/);
    assert.match(oncoready.validateRequest({ ...REQUEST, callback_url: 'ftp://x' }).error, /callback_url/);
    assert.match(oncoready.validateRequest({ ...REQUEST, script: { steps: [] } }).error, /steps/);
    assert.match(oncoready.validateRequest({ ...REQUEST, external_ref: '' }).error, /external_ref/);
  });

  await check('tokens are single-use and expire', () => {
    const now = Date.now();
    const s1 = oncoready.createSession(oncoready.validateRequest(REQUEST).value, now);
    assert.ok(oncoready.consumeToken(s1.token, now + 1000));
    assert.strictEqual(oncoready.consumeToken(s1.token, now + 2000), null, 'second use must fail');
    const s2 = oncoready.createSession(oncoready.validateRequest(REQUEST).value, now);
    assert.strictEqual(oncoready.consumeToken(s2.token, now + 3 * 60 * 1000), null, 'expired token must fail');
    assert.strictEqual(oncoready.consumeToken('nope', now), null);
  });

  await check('POST /v1/browser-sessions: 401 unsigned, 201 signed with ws_url + token', () => {
    process.env.ONCOREADY_PUBLIC_WS_BASE = 'wss://ritu.example';
    const body = JSON.stringify(REQUEST);
    const res = () => ({ code: 0, json: null, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; } });
    const req = (headers) => ({ rawBody: Buffer.from(body), body: REQUEST, headers, get: (h) => headers[h] });
    const r1 = res();
    oncoready.createSessionHandler(req({}), r1);
    assert.strictEqual(r1.code, 401);
    const ts = String(Math.floor(Date.now() / 1000));
    const r2 = res();
    oncoready.createSessionHandler(req({ 'X-Ritu-Timestamp': ts, 'X-Ritu-Signature': oncoready.sign(ts, body) }), r2);
    assert.strictEqual(r2.code, 201, JSON.stringify(r2.json));
    assert.strictEqual(r2.json.ws_url, 'wss://ritu.example/media-stream?sample-rate=8000');
    assert.match(r2.json.session_id, /^rs_/);
    assert.ok(r2.json.token && r2.json.expires_at);
  });

  await check('prompt: steps in order, language, no-advice rules, END_CALL instruction', () => {
    const s = oncoready.createSession(oncoready.validateRequest(REQUEST).value);
    const p = oncoready.buildIntakePrompt(s, 'Hindi');
    assert.ok(p.indexOf('[current_symptoms]') < p.indexOf('[previous_records]'));
    assert.match(p, /Speak ONLY Hindi/);
    assert.match(p, /Never diagnose/);
    assert.match(p, /END_CALL:true/);
    assert.match(p, /Maria Placeholder/);
  });

  await check('reply parsing strips every sentinel line and reads END_CALL', () => {
    const r = oncoready.parseReply('धन्यवाद, मैं यह डॉक्टर को भेज दूँगी।\nEND_CALL:true');
    assert.deepStrictEqual(r, { text: 'धन्यवाद, मैं यह डॉक्टर को भेज दूँगी।', endCall: true });
    const b = oncoready.parseReply('ठीक है।\nBOOK_APPOINTMENT: {"doctor":"X"}');
    assert.deepStrictEqual(b, { text: 'ठीक है।', endCall: false });
  });

  await check('result: completed with patient speech, no_input without, failed on crash', () => {
    const s = { sessionId: 'rs_1', externalRef: 'x', language: 'en-IN' };
    const t = [{ role: 'ritu', text: 'Hi' }, { role: 'patient', text: 'I cough' }, { role: 'system', text: 'x' }];
    const done = oncoready.buildResult(s, { transcript: t, endTrigger: 'llm_end_call' });
    assert.strictEqual(done.status, 'completed');
    assert.deepStrictEqual(done.transcript.map((x) => x.role), ['ritu', 'patient']);
    assert.strictEqual(oncoready.buildResult(s, { transcript: [t[0]] }).status, 'no_input');
    assert.strictEqual(oncoready.buildResult(s, { transcript: [], criticalErrors: 1 }).status, 'failed');
  });

  await check('callback: signed, retried on 5xx, stops on a 4xx that will not change', async () => {
    const s = { sessionId: 'rs_2', callbackUrl: 'http://cb.test/x' };
    const result = { status: 'completed', transcript: [] };
    const seen = [];
    const flaky = async (url, body, opts) => {
      seen.push(opts.headers);
      return { status: seen.length < 3 ? 503 : 200 };
    };
    assert.strictEqual(await oncoready.postResult(s, result, { delays: [0, 0, 0, 0], post: flaky }), true);
    assert.strictEqual(seen.length, 3);
    const h = seen[2];
    assert.ok(oncoready.verify(h['X-Ritu-Timestamp'], h['X-Ritu-Signature'], JSON.stringify(result)));
    let calls = 0;
    const reject = async () => { calls++; return { status: 401 }; };
    assert.strictEqual(await oncoready.postResult(s, result, { delays: [0, 0, 0], post: reject }), false);
    assert.strictEqual(calls, 1);
  });

  // ── the call path, driven ─────────────────────────────────────────────────
  console.log('\nONCOREADY — CallHandler in intake mode, driven\n');

  const llm = require('../llm');
  const replies = [];
  const llmCalls = [];
  llm.completeWithFailover = async (messages) => {
    llmCalls.push(messages);
    return { content: replies.shift() || '', usage: null };
  };
  llm.prewarmPrimary = () => {};
  const sarvam = require('../sarvam');
  sarvam.createStreamingSTT = () => ({ sendAudio() {}, close() {} });
  const crm = require('../crm');
  let clinicLogs = 0;
  crm.logCall = async () => { clinicLogs++; };
  const db = require('../db');
  let upserts = 0;
  db.upsertPatient = async () => { upserts++; };
  const delivered = [];
  oncoready.postResult = async (session, result) => { delivered.push({ session, result }); return true; };

  const CallHandler = require('../callHandler');
  const ws = { readyState: 1, send() {}, close() { this.readyState = 3; } };
  const handler = new CallHandler('rs_live', 'Unknown', ws, 'oncoready_browser', false, null);
  handler.intake = oncoready.createSession(oncoready.validateRequest(REQUEST).value);
  const spoken = [];
  handler.speak = async (text) => { spoken.push(text); handler.transcript.push({ role: 'ritu', text, time: new Date().toISOString() }); };

  replies.push('नमस्ते मारिया जी! डॉक्टर के लिए कुछ सवाल। अभी आपको क्या तकलीफ़ है?');
  await handler.start();

  await check('opens pinned to the session language with a model-written greeting', () => {
    assert.strictEqual(handler._langCode(), 'hi-IN');
    assert.strictEqual(handler._langPinned, true);
    assert.strictEqual(spoken[0], 'नमस्ते मारिया जी! डॉक्टर के लिए कुछ सवाल। अभी आपको क्या तकलीफ़ है?');
    assert.match(llmCalls[0][0].content, /PRE-VISIT check-in/);
    assert.strictEqual(handler.patientName, 'Maria Placeholder');
  });

  handler.transcript.push({ role: 'patient', text: 'दो हफ्ते से सांस फूल रही है', time: new Date().toISOString() });
  handler.conversationHistory.push({ role: 'user', content: 'दो हफ्ते से सांस फूल रही है' });
  replies.push('समझ गई।\nBOOK_APPOINTMENT: {"doctor":"Dr X","time":"kal"}');
  await handler.processIntent('दो हफ्ते से सांस फूल रही है');

  await check('every turn uses the intake prompt; a stray booking sentinel is neither spoken nor acted on', () => {
    assert.strictEqual(spoken[1], 'समझ गई।');
    assert.strictEqual(handler.appointmentBooked, false);
    assert.match(llmCalls[1][0].content, /PRE-VISIT check-in/);
  });

  await check('the booking brain speculation is off in intake mode', () => {
    assert.strictEqual(handler._maybeStartSpeculation(300), undefined);
    assert.strictEqual(handler._speculation, null);
  });

  replies.push('धन्यवाद, मैं यह डॉक्टर को भेज दूँगी।\nEND_CALL:true');
  await handler.processIntent('नहीं, बस इतना ही');

  await check('END_CALL ends the session after the closing line', () => {
    assert.strictEqual(handler.shouldEndCall, true);
    assert.strictEqual(spoken[2], 'धन्यवाद, मैं यह डॉक्टर को भेज दूँगी।');
  });

  await handler.endCall();

  await check('endCall sends the result to OncoReady instead of the clinic call log', () => {
    assert.strictEqual(clinicLogs, 0, 'clinic call log must not be written');
    assert.strictEqual(upserts, 0, 'no clinic patient row for an OncoReady patient');
    assert.strictEqual(delivered.length, 1);
    const r = delivered[0].result;
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.external_ref, REQUEST.external_ref);
    assert.deepStrictEqual(r.transcript.map((t) => t.role), ['ritu', 'patient', 'ritu', 'ritu']);
  });

  // A clinic call on the same build still writes the clinic log (regression guard).
  const clinic = new CallHandler('CA-clinic', '+919876543210', { readyState: 1, send() {}, close() {} }, 'exotel', false, null);
  await clinic.endCall();
  await check('a normal clinic call still writes the clinic call log', () => {
    assert.strictEqual(clinicLogs, 1);
    assert.strictEqual(delivered.length, 1);
  });

  // Language follows the patient; captions reach the browser.
  const sent = [];
  const h3 = new CallHandler('rs_lang', 'Unknown', { readyState: 1, send: (m) => sent.push(JSON.parse(m)), close() {} }, 'oncoready_browser', false, null);
  h3.intake = oncoready.createSession(oncoready.validateRequest({ ...REQUEST, language: 'en-IN' }).value);
  h3.speak = async (t) => { h3.transcript.push({ role: 'ritu', text: t, time: new Date().toISOString() }); };
  llm.completeWithFailover = async () => ({ content: 'Hello John! What problems are you having right now?', usage: null });
  await h3.start();
  await check('captions: every spoken line is sent to the browser', () => {
    assert.deepStrictEqual(sent.filter((m) => m.event === 'oncoready_caption').map((m) => m.role), ['ritu']);
    h3.transcript.push({ role: 'patient', text: 'teen hafte se khansi hai', time: null });
    assert.strictEqual(sent[sent.length - 1].text, 'teen hafte se khansi hai');
  });
  await check('a one-word fragment does not switch the language; two agreeing ones do', () => {
    h3._intakeFollowLanguage('हाँ', { languageCode: 'hi-IN' });
    assert.strictEqual(h3._langCode(), 'en-IN');
    h3._intakeFollowLanguage('जी', { languageCode: 'hi-IN' });
    assert.strictEqual(h3._langCode(), 'hi-IN');
  });
  await check('a full sentence in another language switches voice and prompt at once', () => {
    h3._intakeFollowLanguage('I have had a dry cough for three weeks now', { languageCode: 'en-IN' });
    assert.strictEqual(h3._langCode(), 'en-IN');
    h3._intakeFollowLanguage('तीन हफ्ते से सूखी खांसी हो रही है', { languageCode: 'hi-IN' });
    assert.strictEqual(h3._langCode(), 'hi-IN');
    assert.match(h3._intakeSystem, /Speak ONLY Hindi/);
  });
  await check('an explicit request switches even on a short line; unsupported tags are ignored', () => {
    h3._intakeFollowLanguage('English mein baat karo', { languageCode: 'hi-IN' });
    assert.strictEqual(h3._langCode(), 'en-IN');
    h3._intakeFollowLanguage('some words in a language with no voice here', { languageCode: 'ur-IN' });
    assert.strictEqual(h3._langCode(), 'en-IN');
  });
  await check('longer oncology scripts and patient background are carried into the prompt', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ id: `step_${i}`, goal: `goal ${i}`, prompts: ['q'] }));
    const v = oncoready.validateRequest({ ...REQUEST, script: { ...SCRIPT, steps, background: 'cancer type: lung cancer; treatment status: not started' } }).value;
    assert.strictEqual(v.script.steps.length, 8);
    const p = oncoready.buildIntakePrompt(oncoready.createSession(v), 'English');
    assert.match(p, /WHAT YOU ALREADY KNOW: cancer type: lung cancer/);
    assert.ok(p.indexOf('[step_0]') < p.indexOf('[step_7]'));
  });
  await check('closing follows the guidance instead of a fixed line', () => {
    const s = oncoready.createSession(oncoready.validateRequest({ ...REQUEST, script: { ...SCRIPT, closing: 'Only if they have records, ask them to upload them.' } }).value);
    assert.match(oncoready.buildIntakePrompt(s, 'Hindi'), /following this guidance: Only if they have records/);
  });
  await h3.endCall();

  await check('voice style: validated, and a session uses its own speaker, pace and temperature', () => {
    assert.match(oncoready.validateRequest({ ...REQUEST, voice: { speaker: 'Roopa!' } }).error, /speaker/);
    assert.match(oncoready.validateRequest({ ...REQUEST, voice: { pace: 5 } }).error, /pace/);
    assert.match(oncoready.validateRequest({ ...REQUEST, voice: { temperature: 0 } }).error, /temperature/);
    const styled = new CallHandler('rs_voice', 'Unknown', { readyState: 1, send() {}, close() {} }, 'oncoready_browser', false, null);
    styled.intake = oncoready.createSession(oncoready.validateRequest({ ...REQUEST, voice: { speaker: 'roopa', pace: 1, temperature: 0.45 } }).value);
    assert.strictEqual(styled._currentSpeaker(), 'roopa');
    assert.deepStrictEqual(styled._ttsStyle(), { pace: 1, temperature: 0.45 });
    const plain = new CallHandler('CA-plain', '+919876543210', { readyState: 1, send() {}, close() {} }, 'exotel', false, null);
    assert.deepStrictEqual(plain._ttsStyle(), {}, 'clinic calls keep the deploy defaults');
    assert.notStrictEqual(plain._currentSpeaker(), 'roopa');
  });

  // Opening generation fails → canned opening, session continues.
  const h2 = new CallHandler('rs_fail', 'Unknown', { readyState: 1, send() {}, close() {} }, 'oncoready_browser', false, null);
  h2.intake = oncoready.createSession(oncoready.validateRequest({ ...REQUEST, language: 'en-IN' }).value);
  const spoken2 = [];
  h2.speak = async (t) => { spoken2.push(t); };
  llm.completeWithFailover = async () => { throw new Error('provider down'); };
  await h2.start();
  await check('a failed opening generation falls back to a canned opening', () => {
    assert.match(spoken2[0], /a few questions for your doctor/);
    assert.strictEqual(h2._ended, false);
  });
  await h2.endCall();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
