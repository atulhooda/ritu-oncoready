// ─── LLM HEALTH PROBE ────────────────────────────────────────────────────────
// Companion to the circuit breaker. When a provider's circuit is OPEN (it
// recently 429'd / hit its daily-token cap), this background timer re-checks it
// OFF the call path with a tiny throwaway completion. A real patient call
// therefore never pays the "discovery 429" — by the time a call arrives, the
// breaker has already either re-closed the circuit (provider recovered) or kept
// it open (still capped), so the failover switch is ~0ms every time.
//
// Why a real (tiny) completion and not healthCheck(): healthCheck() lists models
// on a different endpoint and does NOT 429 on a tokens-per-DAY cap, so it can't
// tell us the quota has reset. A 1-token completion is ground truth — it 429s
// while still capped (no tokens consumed) and succeeds the moment quota resets.
//
// Self-limiting: only probes circuits that are currently open. If nothing is
// capped, every tick is a no-op (one Map read). The timer is unref'd so it
// never keeps the process alive.

const breaker = require('./circuitBreaker');

const INTERVAL_MS = parseInt(process.env.LLM_PROBE_INTERVAL_MS || '60000', 10); // 60s
const ENABLED = process.env.ENABLE_LLM_HEALTH_PROBE !== 'false';                // default ON

let timer = null;
let resolveChainFn = null;

function isRateLimit(err) {
  return err && (err.status === 429 || err.statusCode === 429);
}

// One sweep: probe every provider whose circuit is open right now.
async function tick() {
  if (!resolveChainFn) return;
  const open = breaker.snapshot();           // { name: secondsRemaining }
  const names = Object.keys(open);
  if (names.length === 0) return;            // nothing capped → no-op

  let chain;
  try { chain = resolveChainFn(); } catch { return; }
  const providers = [chain.primary, ...(chain.fallbacks || [])].filter(Boolean);

  for (const name of names) {
    const provider = providers.find(p => p && p.name === name);
    if (!provider) continue;
    try {
      // Tiny, tool-less, 1-token probe.
      await provider.complete([{ role: 'user', content: 'ping' }], { maxTokens: 1, temperature: 0 });
      breaker.reset(name);
      console.log(`[LLM] health-probe: ${name} recovered — circuit closed (real calls resume on it).`);
    } catch (err) {
      if (isRateLimit(err)) {
        // Still capped — keep the circuit open and refresh its window so it
        // doesn't auto-expire and let a real call re-discover the 429.
        breaker.trip(name, err);
      }
      // Any other error: leave the circuit as-is; next tick re-checks.
    }
  }
}

// resolveChain: () => ({ primary, fallbacks }) — supplied by llm/index.js so we
// can reach the live provider instances without a circular require.
function start(resolveChain) {
  resolveChainFn = resolveChain;
  if (!ENABLED || timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[LLM] health-probe ON — re-checking capped providers every ${Math.round(INTERVAL_MS / 1000)}s, off the call path.`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick };
