#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// QUAD comparison — 4 Groq models × 6 scripted Ritu scenarios.
//
// Models under test:
//   • groq          → llama-3.3-70b-versatile     (proven baseline)
//   • groq-scout    → llama-4-scout-17b-16e       (5× Groq TPD, preview)
//   • groq-qwen     → qwen3-32b (no-think mode)   (5× Groq TPD, 60 RPM)
//   • groq-gpt-oss  → openai/gpt-oss-120b         (2× Groq TPD, 30 RPM)
//
// Scenarios:
//   1. booking
//   2. reschedule
//   3. emergency             — exact mandated script check
//   4. language_switch       — Hinglish → Devanagari mid-call
//   5. multi_doctor          — specialty disambiguation
//   6. indic_name_json       — Devanagari patient name embedded in
//                              BOOK_APPOINTMENT JSON sentinel (mojibake
//                              test). Includes a Marathi-script turn.
//
// Pacing: TURN_PAUSE_MS=2500, SCENARIO_PAUSE_MS=60000 to stay under the
// tightest tier limit (70B: 30 RPM, 100K TPD; gpt-oss: 30 RPM, 200K TPD).
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('dotenv').config();

const { getProvider } = require('../llm');
const { SYSTEM_PROMPT } = require('../brain');

const TURN_PAUSE_MS     = parseInt(process.env.TURN_PAUSE_MS     || '2500',  10);
const SCENARIO_PAUSE_MS = parseInt(process.env.SCENARIO_PAUSE_MS || '60000', 10);
const MODELS = ['groq', 'groq-scout', 'groq-qwen', 'groq-gpt-oss'];

// ─── Scenarios ─────────────────────────────────────────────────────────────
const INDIC_NAME = 'सिद्धार्थ पठानिया';

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
    expected_sentinels: ['EMERGENCY_DETECTED'],
    // Exact-script check: the prompt mandates this literal phrase.
    expected_phrase: /Yeh emergency hai\. ABHI 108 call karein ya hospital jaayein/i
  },
  {
    id: 'language_switch',
    label: 'Hinglish to Devanagari switch',
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
    label: 'Specialty disambiguation',
    user_turns: [
      'Mujhe skin specialist se milna hai',
      'Mera naam Anjali hai, face pe red rashes hain',
      'Kal shaam 5 baje',
      'Haan ji confirm'
    ],
    expected_sentinels: ['PATIENT_NAME', 'PATIENT_REASON', 'BOOK_APPOINTMENT']
  },
  {
    id: 'indic_name_json',
    label: 'Devanagari name in BOOK_APPOINTMENT JSON (mojibake test) + Marathi turn',
    user_turns: [
      'नमस्ते, मला डॉक्टरांची भेट हवी आहे',                     // Marathi (also Devanagari)
      `मेरा नाम ${INDIC_NAME} है`,                              // Devanagari name
      'दो दिन से बहुत बुखार है',
      'कल दोपहर तीन बजे',
      'हाँ कन्फर्म करें'
    ],
    expected_sentinels: ['PATIENT_NAME', 'PATIENT_REASON', 'BOOK_APPOINTMENT'],
    // Extra checks specific to this scenario:
    extra: {
      requires_devanagari_name_in_json: true,
      banned_script_ranges: [
        { range: /[ঀ-৿]/, label: 'Bengali' },
        { range: /[਀-੿]/, label: 'Gurmukhi' },
        { range: /[஀-௿]/, label: 'Tamil' }
      ]
    }
  }
];

// ─── Sentinel extraction (mirrors brain.js) ────────────────────────────────
const SENTINEL_PATTERNS = {
  PATIENT_NAME:       /PATIENT_NAME:\s*(.+)/i,
  PATIENT_REASON:     /PATIENT_REASON:\s*(.+)/i,
  BOOK_APPOINTMENT:   /BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/,
  UPDATE_APPOINTMENT: /UPDATE_APPOINTMENT:\s*(\{[\s\S]*?\})/,
  END_CALL:           /END_CALL:\s*true/i,
  EMERGENCY_DETECTED: /EMERGENCY_DETECTED:\s*true/i
};
function extractSentinels(text) {
  const found = {};
  for (const [k, re] of Object.entries(SENTINEL_PATTERNS)) {
    const m = text.match(re);
    if (m) found[k] = m[1] !== undefined ? m[1].trim() : true;
  }
  return found;
}

// ─── Helpers for analysis ──────────────────────────────────────────────────
function tryParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function hasDevanagari(text) { return /[ऀ-ॿ]/.test(text || ''); }
function findBannedScripts(text, bans) {
  return bans.filter(b => b.range.test(text || '')).map(b => b.label);
}

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
  const allSentinels = {};
  let totalLatency = 0, totalInputTokens = 0, totalOutputTokens = 0;
  let maxInputTokens = 0;

  // Greet turn
  let greet;
  try {
    greet = await provider.complete(messages, { temperature: 0.6, maxTokens: 200 });
  } catch (err) {
    return { error: err.message, status: err.status || err.code || null };
  }
  messages.push({ role: 'assistant', content: greet.content });
  totalLatency      += greet.latencyMs;
  totalInputTokens  += greet.usage.prompt || 0;
  totalOutputTokens += greet.usage.completion || 0;
  if ((greet.usage.prompt || 0) > maxInputTokens) maxInputTokens = greet.usage.prompt || 0;
  Object.assign(allSentinels, extractSentinels(greet.content));
  turnRecords.push({ user: '(greet)', assistant: greet.content, latency: greet.latencyMs, input: greet.usage.prompt, output: greet.usage.completion });

  for (const userText of scenario.user_turns) {
    messages.push({ role: 'user', content: userText });
    let r;
    try {
      r = await provider.complete(messages, { temperature: 0.6, maxTokens: 200 });
    } catch (err) {
      turnRecords.push({ user: userText, error: err.message, status: err.status || err.code || null });
      return {
        turnRecords, allSentinels, totalLatency, totalInputTokens, totalOutputTokens, maxInputTokens,
        error: err.message, status: err.status || err.code || null, abortedAtTurn: turnRecords.length
      };
    }
    messages.push({ role: 'assistant', content: r.content });
    totalLatency      += r.latencyMs;
    totalInputTokens  += r.usage.prompt || 0;
    totalOutputTokens += r.usage.completion || 0;
    if ((r.usage.prompt || 0) > maxInputTokens) maxInputTokens = r.usage.prompt || 0;
    Object.assign(allSentinels, extractSentinels(r.content));
    turnRecords.push({ user: userText, assistant: r.content, latency: r.latencyMs, input: r.usage.prompt, output: r.usage.completion });
    await new Promise(res => setTimeout(res, TURN_PAUSE_MS));
  }

  // ─── Analysis specific to this scenario ───────────────────────────────
  const allAssistant = turnRecords.map(t => t.assistant || '').join('\n');
  const checks = {};

  if (scenario.expected_phrase) {
    checks.exact_emergency_script = scenario.expected_phrase.test(allAssistant);
  }

  if (scenario.extra?.requires_devanagari_name_in_json) {
    // Find a BOOK_APPOINTMENT JSON
    const m = allAssistant.match(/BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/);
    const parsed = m ? tryParseJson(m[1]) : null;
    checks.book_appointment_json_parses = !!parsed;
    if (parsed) {
      checks.patient_name_field = parsed.patientName || null;
      checks.patient_name_has_devanagari = hasDevanagari(parsed.patientName || '');
      const bannedFound = findBannedScripts(parsed.patientName || '', scenario.extra.banned_script_ranges);
      checks.banned_scripts_in_name = bannedFound;
      checks.banned_scripts_clean = bannedFound.length === 0;
    }
  }

  const expected = scenario.expected_sentinels || [];
  const missing = expected.filter(s => !(s in allSentinels));

  return {
    turnRecords, allSentinels,
    sentinelsFound: Object.keys(allSentinels),
    sentinelsMissing: missing,
    totalLatency, totalInputTokens, totalOutputTokens, maxInputTokens,
    avgLatency: Math.round(totalLatency / turnRecords.length),
    checks
  };
}

async function main() {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) { console.error('GROQ_API_KEY not set.'); process.exit(1); }

  const providers = {};
  for (const name of MODELS) {
    providers[name] = getProvider(name);
    console.log(`${name.padEnd(14)} → ${providers[name].model}`);
  }
  console.log('');

  const results = {};
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    console.log(`▶ [${i+1}/${SCENARIOS.length}] ${scenario.label}`);
    results[scenario.id] = { label: scenario.label, expected_sentinels: scenario.expected_sentinels, byModel: {} };
    for (const name of MODELS) {
      process.stdout.write(`     • ${name.padEnd(14)} `);
      try {
        const r = await runScenarioOnModel(providers[name], scenario);
        results[scenario.id].byModel[name] = r;
        if (r.error) process.stdout.write(`ERROR (${r.status || '?'}: ${r.error.substring(0,80)})\n`);
        else process.stdout.write(`ok (${r.totalLatency}ms, max-input=${r.maxInputTokens})\n`);
      } catch (err) {
        results[scenario.id].byModel[name] = { error: err.message };
        process.stdout.write(`THROW (${err.message.substring(0,80)})\n`);
      }
    }
    if (i < SCENARIOS.length - 1) {
      const s = Math.round(SCENARIO_PAUSE_MS / 1000);
      console.log(`     ⏸  cooldown ${s}s`);
      await new Promise(res => setTimeout(res, SCENARIO_PAUSE_MS));
    }
  }

  // ─── Render summary ──────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════════════════════');
  console.log('QUAD COMPARISON — Llama 70B vs Scout vs Qwen3 vs GPT-OSS 120B');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  for (const [id, r] of Object.entries(results)) {
    console.log(`▼ ${r.label} (${id})`);
    console.log(`  expected: ${r.expected_sentinels.join(', ') || '—'}`);
    for (const name of MODELS) {
      const m = r.byModel[name];
      if (!m) { console.log(`  ${name.padEnd(14)} (not run)`); continue; }
      if (m.error) {
        console.log(`  ${name.padEnd(14)} ✗ ERROR (${m.status || '?'}): ${m.error.substring(0,100)}`);
        continue;
      }
      const pass = m.sentinelsMissing.length === 0;
      const status = pass ? '✓ pass' : `✗ missing ${m.sentinelsMissing.join(',')}`;
      let extras = [];
      if (m.checks?.exact_emergency_script !== undefined) {
        extras.push(`exact-script=${m.checks.exact_emergency_script ? 'Y' : 'N'}`);
      }
      if (m.checks?.book_appointment_json_parses !== undefined) {
        extras.push(`json-parses=${m.checks.book_appointment_json_parses ? 'Y' : 'N'}`);
        if (m.checks.patient_name_field !== undefined) {
          extras.push(`name=${JSON.stringify(m.checks.patient_name_field).substring(0,30)}`);
          extras.push(`dev=${m.checks.patient_name_has_devanagari ? 'Y' : 'N'}`);
          extras.push(`clean=${m.checks.banned_scripts_clean ? 'Y' : 'N'}`);
          if ((m.checks.banned_scripts_in_name || []).length > 0) {
            extras.push(`BANNED:${m.checks.banned_scripts_in_name.join(',')}`);
          }
        }
      }
      const extraStr = extras.length ? `  [${extras.join(' ')}]` : '';
      console.log(`  ${name.padEnd(14)} ${status}  total=${m.totalLatency}ms (avg ${m.avgLatency}ms)  max-input=${m.maxInputTokens}  in/out=${m.totalInputTokens}/${m.totalOutputTokens}${extraStr}`);
    }
    console.log('');
  }

  // Save raw transcripts for review
  const out = require('path').join(__dirname, 'test-quad-comparison.json');
  require('fs').writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`Full per-turn transcripts saved to ${out}`);
}

main().catch(err => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
