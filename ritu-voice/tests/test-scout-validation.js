#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Scout pre-lock validation — the two LLM-based checks the user requested
// before flipping groq-scout to primary:
//
//   V1. Mid-call correction ("change it change it"): after a booking is
//       confirmed, patient asks to change the time. Scout must re-enter
//       scheduling (ask a question OR emit UPDATE_APPOINTMENT) — NOT just
//       say goodbye + END_CALL. This was the failure mode on an earlier call.
//
//   V2. Indic-name script integrity: run 10 varied names (Latin + Devanagari)
//       through a booking flow. The BOOK_APPOINTMENT JSON's patientName must
//       contain NO foreign-script mojibake (Bengali / Gurmukhi / Tamil /
//       Telugu / Kannada / Malayalam). Devanagari and Latin are both fine.
//
// Run: node test-scout-validation.js
// Uses groq-scout directly with the production SYSTEM_PROMPT.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('dotenv').config();
const { getProvider } = require('../llm');
const { SYSTEM_PROMPT } = require('../brain');

// ─── NO KEY IS A SKIP, NOT A FAILURE ────────────────────────────────────────
// This file makes REAL calls to Groq — it is a live vendor eval, not a unit
// test. getProvider() threw here at module scope, so without GROQ_API_KEY the
// file died before its own skip logic below could speak, and CI reported a
// failure that said nothing about our code.
//
// Same reasoning as the retired-model skip at the bottom of this file: a red
// that can never go green teaches everyone to ignore reds. A missing key means
// the check DID NOT RUN, which is different from the check failing — and the
// difference has to be visible, so this says exactly what went unverified.
if (!process.env.GROQ_API_KEY) {
  console.log('\n⏭  SKIP — GROQ_API_KEY is not set, so no call was made to Groq.');
  console.log('   NOT COVERED: Scout\'s script discipline and patientName integrity on live output.');
  console.log('   Set GROQ_API_KEY to run it. Scout is not in the live chain today');
  console.log('   (primary=gemini, fallback=groq llama-3.3-70b-versatile).');
  process.exit(0);
}

const scout = getProvider('groq-scout');
const TURN_PAUSE_MS = 1200;

const BANNED_SCRIPTS = [
  { re: /[ঀ-৿]/, label: 'Bengali' },
  { re: /[਀-੿]/, label: 'Gurmukhi' },
  { re: /[஀-௿]/, label: 'Tamil' },
  { re: /[ఀ-౿]/, label: 'Telugu' },
  { re: /[ಀ-೿]/, label: 'Kannada' },
  { re: /[ഀ-ൿ]/, label: 'Malayalam' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function runConversation(userTurns, { preBooked = false } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Call connected, greet the patient.' }
  ];
  if (preBooked) {
    messages.push({ role: 'system', content: 'Appointment ALREADY booked. BOOK_APPOINTMENT mat likh. Time change ke liye UPDATE_APPOINTMENT use kar.' });
  }
  const turns = [];
  let greet = await scout.complete(messages, { temperature: 0.6, maxTokens: 200 });
  messages.push({ role: 'assistant', content: greet.content });
  turns.push({ user: '(greet)', assistant: greet.content });
  for (const u of userTurns) {
    messages.push({ role: 'user', content: u });
    const r = await scout.complete(messages, { temperature: 0.6, maxTokens: 200 });
    messages.push({ role: 'assistant', content: r.content });
    turns.push({ user: u, assistant: r.content });
    await sleep(TURN_PAUSE_MS);
  }
  return turns;
}

async function validation1() {
  console.log('\n[V1] Mid-call correction — "change it change it" after booking');
  // Book, confirm, THEN ask to change the time twice.
  const turns = await runConversation([
    'Mera naam Siddharth hai',
    'Sir dard hai',
    'Kal subah gyarah baje',
    'Haan confirm karein',
    'Nahi nahi, ruko — time change karna hai',
    'Dopahar teen baje kar dein'
  ]);

  // Inspect the assistant's response to the correction turns (last 2).
  const correctionTurns = turns.slice(-2).map(t => t.assistant).join('\n');
  const lastTurn = turns[turns.length - 1].assistant || '';

  const endedPrematurely = /END_CALL:\s*true/i.test(correctionTurns);
  const reEnteredScheduling =
    /UPDATE_APPOINTMENT:/.test(correctionTurns) ||      // emitted reschedule
    /\?/.test(lastTurn) ||                               // asked a follow-up question
    /(time|baje|kab|kaunsa|theek)/i.test(lastTurn);      // discussing the new time

  assert('did NOT end call on correction', !endedPrematurely,
    endedPrematurely ? 'emitted END_CALL while patient was correcting' : '');
  assert('re-entered scheduling (question or UPDATE_APPOINTMENT)', reEnteredScheduling,
    `last turn: "${lastTurn.substring(0, 120)}"`);

  console.log('  --- correction-turn transcript ---');
  for (const t of turns.slice(-2)) {
    console.log(`    USER: ${t.user}`);
    console.log(`    RITU: ${(t.assistant||'').substring(0,160).replace(/\n/g,' | ')}`);
  }
}

const NAMES = [
  'Siddharth', 'Priyanka', 'Vikas', 'Atul', 'Jyoti',
  'अमित', 'रोहन', 'सिद्धार्थ पठानिया', 'प्रियंका शर्मा', 'विकास गायकवाड़'
];

async function validation2() {
  console.log('\n[V2] Indic-name script integrity — 10 names through booking JSON');
  let cleanCount = 0;
  for (const name of NAMES) {
    let turns;
    try {
      turns = await runConversation([
        `Mera naam ${name} hai`,
        'Bukhar hai',
        'Kal dopahar teen baje',
        'Haan confirm'
      ]);
    } catch (err) {
      assert(`name "${name}"`, false, `LLM error: ${err.message}`);
      continue;
    }
    const all = turns.map(t => t.assistant || '').join('\n');
    const m = all.match(/BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/);
    let parsed = null;
    if (m) { try { parsed = JSON.parse(m[1]); } catch {} }

    if (!parsed) {
      assert(`name "${name}" → BOOK_APPOINTMENT JSON parses`, false, 'no parseable JSON emitted');
      continue;
    }
    const nameField = parsed.patientName || '';
    const banned = BANNED_SCRIPTS.filter(b => b.re.test(nameField)).map(b => b.label);
    const clean = banned.length === 0;
    if (clean) cleanCount++;
    assert(`name "${name}" → JSON name "${nameField}" no mojibake`, clean,
      banned.length ? `found ${banned.join(',')}` : '');
    await sleep(TURN_PAUSE_MS);
  }
  console.log(`  → ${cleanCount}/${NAMES.length} names clean`);
}

(async () => {
  console.log(`Scout model: ${scout.model}`);
  await validation1();
  await validation2();
  console.log(`\n${pass}/${pass + fail} validation checks passing`);
  if (fail > 0) { console.log('\n⚠ Scout validation found issues — review before locking.'); process.exit(1); }
  console.log('\n✓ Scout validations passed. Safe to lock as primary.');
})().catch(e => {
  // ─── THE VENDOR RETIRED THE MODEL THIS FILE EXISTS TO CHECK ────────────────
  // 2026-08-08: every run dies on
  //   404 The model `meta-llama/llama-4-scout-17b-16e-instruct` does not exist
  // Groq has withdrawn Scout. It is listed in neither /v1/models nor our live
  // chain: production runs LLM_PRIMARY_PROVIDER=gemini with fallbacks
  // groq,gemini,deepinfra, where `groq` is llama-3.3-70b-versatile (confirmed
  // still listed). This file's own header says it was the gate to run "before
  // flipping groq-scout to primary" — a decision since made the other way, on
  // a model that no longer exists.
  //
  // So this is SKIP, not PASS and not FAIL. A red that can never go green
  // teaches everyone to ignore reds, and deleting the file would erase the two
  // checks if Scout ever returns.
  //
  // NARROW ON PURPOSE: only the vendor's "model does not exist" 404 skips.
  // Every other error — a real regression, a bad key, a timeout, mojibake in a
  // patientName — still exits 1. This must not become a way for a genuine
  // failure to leave quietly.
  const msg = String(e && (e.message || e));
  if (/does not exist or you do not have access/i.test(msg)) {
    console.log('\n⏭  SKIP — Groq has retired meta-llama/llama-4-scout-17b-16e-instruct.');
    console.log('   Scout is not in the live chain (primary=gemini, fallback=groq llama-3.3-70b-versatile).');
    console.log('   Nothing this file checks is running in production. Re-point GROQ_SCOUT_MODEL to revive it.');
    process.exit(0);
  }
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
