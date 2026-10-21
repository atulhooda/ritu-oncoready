#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LLM Provider Smoke Test — runs the four verification cases from the spec:
//   1) Both providers respond to a Hindi appointment-booking prompt
//   2) Both providers stream
//   3) Failover triggers when primary key is invalid → fallback picks up
//   4) Side-by-side latency / response comparison
//
// Run:   node test-llm-providers.js
// Needs: SAMBANOVA_API_KEY and GROQ_API_KEY both set in .env (real keys).
//        If only one is set, the corresponding cases are skipped with a note.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('dotenv').config();

const { GroqProvider, SambanovaProvider, getFailoverStats } = require('../llm');
const { completeWithFailover: rawCompleteWithFailover } = require('../llm/failover');

const TEST_PROMPT = 'Namaste, mujhe appointment chahiye';
const TEST_MESSAGES = [
  {
    role: 'system',
    content: 'You are Ritu, an AI receptionist at an Indian clinic. Reply in Hinglish in 1-2 short sentences. Be warm.'
  },
  { role: 'user', content: TEST_PROMPT }
];

const PALETTE = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m'
};
const c = (color, s) => `${PALETTE[color] || ''}${s}${PALETTE.reset}`;

function header(label) {
  console.log('\n' + c('bold', '━'.repeat(72)));
  console.log(c('bold', label));
  console.log(c('bold', '━'.repeat(72)));
}

function tryBuildProvider(name) {
  try {
    if (name === 'sambanova') {
      if (!process.env.SAMBANOVA_API_KEY) return { skip: true, reason: 'SAMBANOVA_API_KEY missing' };
      return { provider: new SambanovaProvider({ apiKey: process.env.SAMBANOVA_API_KEY }) };
    }
    if (name === 'groq') {
      if (!process.env.GROQ_API_KEY) return { skip: true, reason: 'GROQ_API_KEY missing' };
      return { provider: new GroqProvider({ apiKey: process.env.GROQ_API_KEY }) };
    }
    return { skip: true, reason: `unknown provider ${name}` };
  } catch (err) {
    return { skip: true, reason: err.message };
  }
}

// ─── Case 1: non-streaming complete() on both providers ────────────────────
async function caseComplete(provider) {
  const result = await provider.complete(TEST_MESSAGES, { temperature: 0.6, maxTokens: 80 });
  return result;
}

// ─── Case 2: streaming stream() on both providers ──────────────────────────
async function caseStream(provider) {
  const startedAt = Date.now();
  let firstChunkAt = null;
  let assembled = '';
  let chunkCount = 0;
  let final = null;
  for await (const chunk of provider.stream(TEST_MESSAGES, { temperature: 0.6, maxTokens: 80 })) {
    if (chunk.done) { final = chunk; break; }
    if (firstChunkAt === null) firstChunkAt = Date.now();
    assembled += chunk.content;
    chunkCount += 1;
  }
  return {
    content: assembled,
    ttftMs: firstChunkAt ? firstChunkAt - startedAt : null,
    totalLatencyMs: Date.now() - startedAt,
    chunkCount,
    provider: final?.provider || provider.name,
    model: final?.model || provider.model
  };
}

// ─── Case 3: failover ──────────────────────────────────────────────────────
// Force the primary to fail by giving it an invalid key. The failover wrapper
// should catch the resulting 401, decide auth errors don't warrant failover
// (since they'd fail the same way elsewhere), and propagate. That's the
// expected behavior — auth = configuration error, not transient.
//
// To exercise the "transient failure → failover succeeds" path, we point the
// primary at an unreachable host. Network error → failover eligible → Groq
// picks it up.
async function caseFailover() {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return { skip: true, reason: 'GROQ_API_KEY missing — cannot test failover destination' };

  // Build a primary that will fail with a network error (unreachable host).
  // We hand-construct the openai client via the SambanovaProvider with a
  // bogus baseURL by monkey-patching after construction. Easier: subclass
  // for the test.
  const OpenAI = require('openai');
  const broken = new SambanovaProvider({ apiKey: 'pk-broken' });
  broken.client = new OpenAI({
    apiKey: 'pk-broken',
    baseURL: 'https://this-host-does-not-resolve.sambanova.invalid/v1',
    timeout: 3000,
    maxRetries: 0
  });

  const fallback = new GroqProvider({ apiKey: groqKey });
  const result = await rawCompleteWithFailover(
    TEST_MESSAGES,
    { temperature: 0.6, maxTokens: 80 },
    { primary: broken, fallback }
  );
  return result;
}

// ─── Driver ────────────────────────────────────────────────────────────────
async function main() {
  console.log(c('bold', '🔎 LLM Provider Smoke Test'));
  console.log(c('dim', `Prompt: "${TEST_PROMPT}"`));

  const samba = tryBuildProvider('sambanova');
  const groq  = tryBuildProvider('groq');
  console.log(c('dim', `SambaNova: ${samba.skip ? 'SKIPPED — ' + samba.reason : 'ready'}`));
  console.log(c('dim', `Groq:      ${groq.skip ? 'SKIPPED — ' + groq.reason : 'ready'}`));

  const sideBySide = {};

  // ─── Case 1 ────────────────────────────────────────────────────────────
  header('Case 1 — Non-streaming complete()');
  for (const [label, built] of [['sambanova', samba], ['groq', groq]]) {
    if (built.skip) { console.log(c('yellow', `  ${label}: SKIP (${built.reason})`)); continue; }
    try {
      const result = await caseComplete(built.provider);
      sideBySide[label] = sideBySide[label] || {};
      sideBySide[label].complete = result;
      console.log(c('green', `  ✓ ${label}`));
      console.log(`    latency=${c('cyan', result.latencyMs + 'ms')}  ` +
        `tokens=${result.usage.prompt}/${result.usage.completion}/${result.usage.total}`);
      console.log(`    content: ${c('gray', JSON.stringify(result.content))}`);
    } catch (err) {
      console.log(c('red', `  ✗ ${label}: ${err.message}`));
    }
  }

  // ─── Case 2 ────────────────────────────────────────────────────────────
  header('Case 2 — Streaming stream()');
  for (const [label, built] of [['sambanova', samba], ['groq', groq]]) {
    if (built.skip) { console.log(c('yellow', `  ${label}: SKIP (${built.reason})`)); continue; }
    try {
      const result = await caseStream(built.provider);
      sideBySide[label] = sideBySide[label] || {};
      sideBySide[label].stream = result;
      console.log(c('green', `  ✓ ${label}`));
      console.log(`    ttft=${c('cyan', result.ttftMs + 'ms')}  ` +
        `total=${c('cyan', result.totalLatencyMs + 'ms')}  chunks=${result.chunkCount}`);
      console.log(`    content: ${c('gray', JSON.stringify(result.content))}`);
    } catch (err) {
      console.log(c('red', `  ✗ ${label}: ${err.message}`));
    }
  }

  // ─── Case 3 ────────────────────────────────────────────────────────────
  header('Case 3 — Failover (broken primary → working fallback)');
  try {
    const result = await caseFailover();
    if (result.skip) {
      console.log(c('yellow', `  SKIP (${result.reason})`));
    } else if (result.failover) {
      console.log(c('green', `  ✓ Failover triggered. Final provider: ${result.provider}`));
      console.log(`    latency=${c('cyan', result.latencyMs + 'ms')}  ` +
        `content: ${c('gray', JSON.stringify(result.content))}`);
    } else {
      console.log(c('red', `  ✗ Expected failover, but primary appeared to succeed (provider=${result.provider})`));
    }
  } catch (err) {
    console.log(c('red', `  ✗ Both providers failed: ${err.message}`));
  }

  // ─── Case 4: side-by-side comparison ───────────────────────────────────
  header('Case 4 — Side-by-side comparison');
  if (sideBySide.sambanova?.complete && sideBySide.groq?.complete) {
    const s = sideBySide.sambanova.complete;
    const g = sideBySide.groq.complete;
    console.log(`  ${'metric'.padEnd(14)} ${'sambanova'.padEnd(18)} ${'groq'.padEnd(18)} delta`);
    console.log(`  ${'─'.repeat(14)} ${'─'.repeat(18)} ${'─'.repeat(18)} ${'─'.repeat(10)}`);
    const fmt = (n, suffix='ms') => (n == null ? '?' : `${n}${suffix}`);
    console.log(`  ${'latency'.padEnd(14)} ${fmt(s.latencyMs).padEnd(18)} ${fmt(g.latencyMs).padEnd(18)} ${s.latencyMs - g.latencyMs >= 0 ? '+' : ''}${s.latencyMs - g.latencyMs}ms`);
    console.log(`  ${'input tok'.padEnd(14)} ${String(s.usage.prompt).padEnd(18)} ${String(g.usage.prompt).padEnd(18)} ${(s.usage.prompt || 0) - (g.usage.prompt || 0)}`);
    console.log(`  ${'output tok'.padEnd(14)} ${String(s.usage.completion).padEnd(18)} ${String(g.usage.completion).padEnd(18)} ${(s.usage.completion || 0) - (g.usage.completion || 0)}`);
    if (sideBySide.sambanova.stream && sideBySide.groq.stream) {
      const ss = sideBySide.sambanova.stream;
      const gs = sideBySide.groq.stream;
      console.log(`  ${'stream ttft'.padEnd(14)} ${fmt(ss.ttftMs).padEnd(18)} ${fmt(gs.ttftMs).padEnd(18)} ${(ss.ttftMs || 0) - (gs.ttftMs || 0)}ms`);
    }
    console.log('');
    console.log(c('bold', '  Responses (visual diff — same meaning ≈ provider parity):'));
    console.log(c('cyan', '  sambanova: ') + c('gray', JSON.stringify(s.content)));
    console.log(c('cyan', '  groq:      ') + c('gray', JSON.stringify(g.content)));
  } else {
    console.log(c('yellow', '  Not enough providers responded successfully to compare.'));
  }

  // ─── Failover stats ────────────────────────────────────────────────────
  header('Failover counters');
  const stats = getFailoverStats();
  console.log(`  totalCalls=${stats.totalCalls}  primarySuccess=${stats.primarySuccess}  ` +
    `failovers=${stats.failovers}  bothFailed=${stats.bothFailed}  rate=${stats.failoverRatePct}%`);

  console.log('\n' + c('bold', 'Done.\n'));
}

main().catch(err => {
  console.error('\n' + c('red', 'FATAL: ' + (err.stack || err.message)));
  process.exit(1);
});
