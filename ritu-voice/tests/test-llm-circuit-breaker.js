#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for the LLM circuit breaker + failover routing.
//
// Proves the behaviour the pilot needs: once a provider hits its quota (429),
// the chain routes AROUND it on every subsequent call (no per-call 2s retry),
// and re-probes + recovers automatically after the cooldown.
//
// Run: node tests/test-llm-circuit-breaker.js
// ═══════════════════════════════════════════════════════════════════════════

// Short cooldown so the recovery test doesn't take minutes. Must be set BEFORE
// requiring the breaker (it reads the env at load). Kept above the breaker's
// 1s anti-flap floor (MIN_COOLDOWN_MS) so it isn't clamped.
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
process.env.LLM_BREAKER_COOLDOWN_MS = '1100';
process.env.ENABLE_LLM_CIRCUIT_BREAKER = 'true';

const { completeWithFailover } = require('../llm/failover');
const breaker = require('../llm/circuitBreaker');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (provider) => ({ content: 'ok', toolCalls: null, usage: {}, latencyMs: 1, provider, model: provider });
function err(status) { const e = new Error(`status ${status}`); e.status = status; return e; }

// Mock providers whose behaviour we flip per-test.
let scoutCalls = 0, geminiCalls = 0, scoutMode = 'cap';
const scout = { name: 'groq-scout', async complete() {
  scoutCalls++;
  if (scoutMode === 'cap') throw err(429);
  if (scoutMode === 'err500') throw err(500);
  return ok('groq-scout');
}, async *stream() { if (scoutMode !== 'ok') throw err(scoutMode === 'cap' ? 429 : 500); yield { content: 'ok', done: false }; yield { content: '', done: true, provider: 'groq-scout' }; } };
const gemini = { name: 'gemini', async complete() { geminiCalls++; return ok('gemini'); } };
const chain = { primary: scout, fallbacks: [gemini] };

async function main() {
  console.log('\n[1] First 429 → trips breaker, served by fallback');
  scoutMode = 'cap'; scoutCalls = 0; geminiCalls = 0; breaker.reset('groq-scout');
  const r1 = await completeWithFailover([], {}, chain);
  assert('served by gemini',          r1.provider === 'gemini');
  assert('tried scout exactly once',  scoutCalls === 1, `got ${scoutCalls}`);
  assert('scout circuit now OPEN',    breaker.isOpen('groq-scout'));
  assert('result flagged failover',   r1.failover === true);

  console.log('\n[2] Next call → scout SKIPPED entirely (no wasted 429)');
  const before = scoutCalls;
  const r2 = await completeWithFailover([], {}, chain);
  assert('served by gemini',          r2.provider === 'gemini');
  assert('scout NOT called again',    scoutCalls === before, `scout calls went ${before}→${scoutCalls}`);
  assert('still failover',            r2.failover === true);

  console.log('\n[3] After cooldown → scout re-probed, recovers, breaker closes');
  await sleep(1200);                   // cooldown is 1100ms
  scoutMode = 'ok';
  const probeBefore = scoutCalls;
  const r3 = await completeWithFailover([], {}, chain);
  assert('scout was re-probed',       scoutCalls === probeBefore + 1, `got ${scoutCalls}`);
  assert('served by scout (recovered)', r3.provider === 'groq-scout');
  assert('circuit CLOSED again',      !breaker.isOpen('groq-scout'));
  assert('not flagged failover',      r3.failover === false);

  console.log('\n[4] Non-429 error fails over but does NOT trip the breaker');
  scoutMode = 'err500'; breaker.reset('groq-scout');
  const r4 = await completeWithFailover([], {}, chain);
  assert('served by gemini',          r4.provider === 'gemini');
  assert('scout circuit still CLOSED', !breaker.isOpen('groq-scout'), 'a 5xx should not open the circuit');

  console.log('\n[5] All circuits open → still attempts the chain (never fails the call)');
  scoutMode = 'ok'; breaker.trip('groq-scout', err(429)); breaker.trip('gemini', err(429));
  assert('both circuits open',        breaker.isOpen('groq-scout') && breaker.isOpen('gemini'));
  const r5 = await completeWithFailover([], {}, chain);
  assert('call still served (scout)', r5.provider === 'groq-scout', `got ${r5.provider}`);
  breaker.reset('groq-scout'); breaker.reset('gemini');

  console.log('\n[6] Retry-After header sets the cooldown');
  const e = err(429); e.headers = { 'retry-after': '7' };
  const cd = breaker.trip('groq-scout', e);
  assert('cooldown honors Retry-After (7s)', cd === 7000, `got ${cd}ms`);
  breaker.reset('groq-scout');

  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail) { console.log('✗ FAILURES'); process.exit(1); }
  console.log('✓ All circuit-breaker tests passing.');
  process.exit(0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
