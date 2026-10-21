#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Groq Llama 4 Scout vs Llama 3.3 70B — behavior parity test
//
// Runs five scripted multi-turn conversations against BOTH models using the
// real Ritu system prompt and realistic patient input. Compares:
//
//   1. Sentinel emission fidelity   (does Scout emit PATIENT_NAME,
//      BOOK_APPOINTMENT, EMERGENCY_DETECTED, etc. in the exact format brain.js
//      parses?)
//   2. Response quality             (Hinglish/Hindi script consistency,
//      tone, brevity, no English-only drift)
//   3. Latency                      (per-turn TTFT and total)
//   4. Token economy                (input/output tokens — relevant since
//      Scout has 5× the daily budget but per-call cost still matters)
//
// Run:   node test-scout-vs-70b.js
// Needs: GROQ_API_KEY in .env
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('dotenv').config();

const { getProvider } = require('../llm');
const { SYSTEM_PROMPT } = require('../brain');

// Pacing — keep us well under Groq llama-3.3-70b-versatile's 12K TPM cap.
// Without these, a serial burst across 5 scenarios × 6 turns × 2 models
// blows the TPM window and 70B starts 429ing mid-test, which contaminates
// the comparison (you can't tell if 70B "failed" the scenario or just
// failed to respond).
const TURN_PAUSE_MS     = parseInt(process.env.TURN_PAUSE_MS     || '1500', 10);
const SCENARIO_PAUSE_MS = parseInt(process.env.SCENARIO_PAUSE_MS || '45000', 10);

// ─── Scenarios ─────────────────────────────────────────────────────────────
// Each scenario is a sequence of user turns. We replay them serially against
// the model, accumulating conversation history, capturing each turn's
// response + sentinels + latency. The first user turn is "Call connected,
// greet the patient." to match how brain.js seeds history (see callHandler.start).
const SCENARIOS = [
  {
    id: 'booking',
    label: 'Happy-path booking',
    user_turns: [
      'Namaste, mujhe doctor se appointment chahiye',
      'Mera naam Siddharth hai',
      'Sir dard ho raha hai do din se',
      'Kal subah 11 baje aa sakta hoon',
      'Haan, confirm karein'
    ],
    expected_sentinels: ['PATIENT_NAME', 'PATIENT_REASON', 'BOOK_APPOINTMENT']
  },
  {
    id: 'reschedule',
    label: 'Reschedule existing appointment',
    user_turns: [
      'Hello, mera appointment hai kal ka, time change karna hai',
      'Mera naam Priya Sharma hai',
      'Kal subah 9 baje ke bajaye dopahar 3 baje kar dein',
      'Haan, change karein'
    ],
    expected_sentinels: ['PATIENT_NAME', 'UPDATE_APPOINTMENT'],
    appointment_already_booked: true
  },
  {
    id: 'emergency',
    label: 'Emergency detection (chest pain)',
    user_turns: [
      'Hello, papa ko chest mein bahut tez dard ho raha hai aur saans nahi aa rahi'
    ],
    expected_sentinels: ['EMERGENCY_DETECTED']
  },
  {
    id: 'language_switch',
    label: 'Hinglish to Hindi switch',
    user_turns: [
      'Hi, I need to book an appointment for tomorrow',
      'Mera naam Rajesh hai, fever hai mujhe',
      'कल सुबह दस बजे आ सकता हूँ',
      'हाँ confirm कर दीजिये'
    ],
    expected_sentinels: ['PATIENT_NAME', 'PATIENT_REASON', 'BOOK_APPOINTMENT']
  },
  {
    id: 'multi_doctor',
    label: 'Doctor specialty disambiguation (single-doctor codebase — should defer politely)',
    user_turns: [
      'Mujhe skin specialist se milna hai',
      'Mera naam Anjali hai, face pe red rashes hain',
      'Kal shaam 5 baje',
      'Haan ji confirm'
    ],
    expected_sentinels: ['PATIENT_NAME', 'PATIENT_REASON', 'BOOK_APPOINTMENT']
  }
];

// ─── Sentinel extraction (mirrors brain.js parsers) ────────────────────────
const SENTINEL_PATTERNS = {
  PATIENT_NAME:        /PATIENT_NAME:\s*(.+)/i,
  PATIENT_REASON:      /PATIENT_REASON:\s*(.+)/i,
  BOOK_APPOINTMENT:    /BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/,
  UPDATE_APPOINTMENT:  /UPDATE_APPOINTMENT:\s*(\{[\s\S]*?\})/,
  END_CALL:            /END_CALL:\s*true/i,
  EMERGENCY_DETECTED:  /EMERGENCY_DETECTED:\s*true/i
};
function extractSentinels(text) {
  const found = {};
  for (const [key, pattern] of Object.entries(SENTINEL_PATTERNS)) {
    const m = text.match(pattern);
    if (m) found[key] = m[1] !== undefined ? m[1].trim() : true;
  }
  return found;
}

// ─── Script quality heuristics ─────────────────────────────────────────────
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN_LETTER = /[a-zA-Z]/g;
const NON_HINDI_INDIC = /[਀-෿]/g; // Gurmukhi..Malayalam — script drift signal
function analyzeText(text) {
  const dev = (text.match(DEVANAGARI) || []).length;
  const lat = (text.match(LATIN_LETTER) || []).length;
  const drift = (text.match(NON_HINDI_INDIC) || []).length;
  return {
    chars: text.length,
    devanagari: dev,
    latin: lat,
    scriptDrift: drift,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length
  };
}

// ─── Driver ────────────────────────────────────────────────────────────────
async function runScenarioOnModel(provider, scenario) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Call connected, greet the patient.' }
  ];
  if (scenario.appointment_already_booked) {
    messages.push({
      role: 'system',
      content: 'Appointment ALREADY booked. BOOK_APPOINTMENT mat likh. Time change ke liye UPDATE_APPOINTMENT use kar.'
    });
  }

  const turnRecords = [];
  let allSentinels = {};
  let totalLatency = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Initial greeting turn (mirrors brain.js's first invocation).
  let greetResult;
  try {
    greetResult = await provider.complete(messages, { temperature: 0.6, maxTokens: 200 });
  } catch (err) {
    return { error: err.message };
  }
  messages.push({ role: 'assistant', content: greetResult.content });
  turnRecords.push({
    user: '(connected)',
    assistant: greetResult.content,
    latencyMs: greetResult.latencyMs,
    inputTokens: greetResult.usage.prompt,
    outputTokens: greetResult.usage.completion,
    sentinels: extractSentinels(greetResult.content)
  });
  totalLatency += greetResult.latencyMs;
  totalInputTokens += greetResult.usage.prompt || 0;
  totalOutputTokens += greetResult.usage.completion || 0;
  Object.assign(allSentinels, turnRecords[0].sentinels);

  for (const userText of scenario.user_turns) {
    messages.push({ role: 'user', content: userText });
    let r;
    try {
      r = await provider.complete(messages, { temperature: 0.6, maxTokens: 200 });
    } catch (err) {
      turnRecords.push({ user: userText, error: err.message });
      break;
    }
    messages.push({ role: 'assistant', content: r.content });
    const s = extractSentinels(r.content);
    turnRecords.push({
      user: userText,
      assistant: r.content,
      latencyMs: r.latencyMs,
      inputTokens: r.usage.prompt,
      outputTokens: r.usage.completion,
      sentinels: s
    });
    totalLatency += r.latencyMs;
    totalInputTokens += r.usage.prompt || 0;
    totalOutputTokens += r.usage.completion || 0;
    Object.assign(allSentinels, s);
    await new Promise(res => setTimeout(res, TURN_PAUSE_MS));
  }

  // Did we get every expected sentinel?
  const expected = scenario.expected_sentinels || [];
  const missing = expected.filter(s => !(s in allSentinels));
  const extra = Object.keys(allSentinels).filter(s => !expected.includes(s));

  // Script analysis on the full assistant content concatenated
  const allAssistant = turnRecords.map(t => t.assistant || '').join('\n');
  const textStats = analyzeText(allAssistant);

  return {
    turns: turnRecords,
    sentinelsFound: Object.keys(allSentinels),
    sentinelsMissing: missing,
    sentinelsExtra: extra,
    totalLatencyMs: totalLatency,
    avgLatencyMs: Math.round(totalLatency / turnRecords.length),
    totalInputTokens,
    totalOutputTokens,
    textStats
  };
}

async function main() {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.error('GROQ_API_KEY is not set; cannot run comparison.');
    process.exit(1);
  }

  const llama70b = getProvider('groq');
  const scout    = getProvider('groq-scout');
  console.log(`70B   model: ${llama70b.model}`);
  console.log(`Scout model: ${scout.model}\n`);

  const results = {};
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    console.log(`▶ [${i + 1}/${SCENARIOS.length}] ${scenario.label}`);
    console.log(`     • 70B …`);
    const r70 = await runScenarioOnModel(llama70b, scenario);
    console.log(`     • Scout …`);
    const rScout = await runScenarioOnModel(scout, scenario);
    results[scenario.id] = {
      label: scenario.label,
      expected_sentinels: scenario.expected_sentinels,
      llama70b: r70,
      scout: rScout
    };
    if (i < SCENARIOS.length - 1) {
      const s = Math.round(SCENARIO_PAUSE_MS / 1000);
      console.log(`     ⏸  pausing ${s}s before next scenario (70B TPM cooldown)`);
      await new Promise(res => setTimeout(res, SCENARIO_PAUSE_MS));
    }
  }

  // ─── Summary report ──────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY — Llama 4 Scout vs Llama 3.3 70B');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  let scoutPasses = 0;
  let scoutFails = 0;

  for (const [id, r] of Object.entries(results)) {
    console.log(`▼ ${r.label} (${id})`);
    console.log(`  expected sentinels: ${r.expected_sentinels.join(', ')}`);
    if (r.llama70b.error) { console.log(`  70B   ERROR: ${r.llama70b.error}`); continue; }
    if (r.scout.error)    { console.log(`  Scout ERROR: ${r.scout.error}`); continue; }

    const sentinelParity = JSON.stringify([...new Set(r.llama70b.sentinelsFound)].sort())
                        === JSON.stringify([...new Set(r.scout.sentinelsFound)].sort());
    const scoutMissed = r.scout.sentinelsMissing;
    const seventyMissed = r.llama70b.sentinelsMissing;
    const status = (scoutMissed.length === 0) ? '✓ pass' : `✗ missing ${scoutMissed.join(', ')}`;

    if (scoutMissed.length === 0) scoutPasses++; else scoutFails++;

    console.log(`  70B   sentinels: [${r.llama70b.sentinelsFound.join(', ')}]${seventyMissed.length ? ` (missing ${seventyMissed.join(', ')})` : ''}`);
    console.log(`  Scout sentinels: [${r.scout.sentinelsFound.join(', ')}] ${status}`);
    console.log(`  parity: ${sentinelParity ? 'YES' : 'NO'}`);
    console.log(`  latency  70B=${r.llama70b.totalLatencyMs}ms (avg ${r.llama70b.avgLatencyMs}ms/turn)   Scout=${r.scout.totalLatencyMs}ms (avg ${r.scout.avgLatencyMs}ms/turn)`);
    console.log(`  tokens   70B in/out=${r.llama70b.totalInputTokens}/${r.llama70b.totalOutputTokens}   Scout in/out=${r.scout.totalInputTokens}/${r.scout.totalOutputTokens}`);
    console.log(`  script   70B dev/lat/drift=${r.llama70b.textStats.devanagari}/${r.llama70b.textStats.latin}/${r.llama70b.textStats.scriptDrift}   Scout=${r.scout.textStats.devanagari}/${r.scout.textStats.latin}/${r.scout.textStats.scriptDrift}`);
    if (r.scout.textStats.scriptDrift > 0) {
      console.log(`  ⚠  Scout emitted non-Hindi Indic script (${r.scout.textStats.scriptDrift} chars) — TTS will mis-render`);
    }
    console.log('');
  }

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`Scout pass: ${scoutPasses}/${SCENARIOS.length}    fail: ${scoutFails}/${SCENARIOS.length}`);
  console.log('──────────────────────────────────────────────────────────────────────');

  // Optional: save full transcripts for review
  const out = require('path').join(__dirname, 'test-scout-vs-70b.json');
  require('fs').writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nFull per-turn transcripts saved to ${out}`);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
