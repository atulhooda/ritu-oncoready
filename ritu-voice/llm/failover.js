// ─── FAILOVER WRAPPER ────────────────────────────────────────────────────────
// completeWithFailover(messages, options) tries the primary provider; on
// retryable failure (timeout, 5xx, network error, post-retry 429) it
// walks an ordered list of fallback providers, trying each in turn.
// Same semantics for streamWithFailover (failover only before first chunk).
//
// Tracks a per-process failover-frequency counter so we can see in logs how
// often the primary is failing in production. If failover rate > 20%, that's
// a signal that the chosen primary is undersized for actual call volume.
//
// API:
//   completeWithFailover(messages, options, { primary, fallbacks: [a, b, c] })
//   completeWithFailover(messages, options, { primary, fallback: a })  // legacy single fallback
//
// The chain is tried in order; the first provider to return a result wins.
// Auth (401/403) and bad-request (400) errors short-circuit the chain —
// they would fail the same way on any provider, so don't burn extra calls.

const { isAuthError, isBadRequest, isFailoverEligible, isRateLimit } = require('./retry');
const breaker = require('./circuitBreaker');
const config = require('../config');

// Race the FIRST streamed chunk against a deadline. Healthy first-token is
// ~0.3–1s; if a provider emits nothing within firstChunkTimeoutMs it's hung, so
// we throw ETIMEDOUT (failover-eligible) and switch providers immediately rather
// than waiting out the full per-request SDK timeout (~8s of dead air). Only the
// first chunk is timed — once tokens flow, a long reply is never cut off.
function firstChunkWithDeadline(iterNextPromise, ms, providerName) {
  if (!ms || ms <= 0) return iterNextPromise;
  // Swallow a late rejection on the stream we're abandoning so it can't surface
  // as an unhandledRejection after we've already failed over.
  iterNextPromise.catch(() => {});
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${providerName}: no first token within ${ms}ms`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([iterNextPromise, deadline]).finally(() => clearTimeout(timer));
}

// Module-level counters.
const stats = {
  totalCalls: 0,
  primarySuccess: 0,
  failovers: 0,        // number of calls where at least one failover happened
  allFailed: 0,        // every provider in the chain failed
  startedAt: Date.now()
};

function recordCall()           { stats.totalCalls += 1; }
function recordPrimarySuccess() { stats.primarySuccess += 1; }
function recordFailover()       { stats.failovers += 1; }
function recordAllFailed()      { stats.allFailed += 1; }

function getFailoverStats() {
  const rate = stats.totalCalls === 0 ? 0 : stats.failovers / stats.totalCalls;
  return {
    ...stats,
    failoverRatePct: Math.round(rate * 1000) / 10,
    uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
    openCircuits: breaker.snapshot()   // { providerName: secondsRemaining }
  };
}

// Drop providers whose circuit is open (recently quota-limited) so we skip them
// entirely instead of eating a 429 on every call. Never returns empty — if ALL
// are open, try the full chain anyway (better to attempt a maybe-capped provider
// than to fail the call outright).
function activeChain(fullChain) {
  if (!breaker.enabled() || fullChain.length <= 1) return fullChain;
  const active = fullChain.filter(p => !breaker.isOpen(p.name));
  if (active.length === 0) return fullChain;
  if (active.length < fullChain.length) {
    const skipped = fullChain.filter(p => breaker.isOpen(p.name))
      .map(p => `${p.name}(~${Math.round(breaker.msRemaining(p.name) / 1000)}s)`).join(', ');
    console.log(`[LLM] circuit open — skipping ${skipped}; routing to ${active[0].name}`);
  }
  return active;
}

function logLine({ provider, model, usage, latencyMs, ttftMs, failover }) {
  const u = usage || {};
  console.log(
    `[LLM] provider=${provider} model=${model} ` +
    `input=${u.prompt ?? '?'} output=${u.completion ?? '?'} ` +
    // cached= is absent when the provider does not report it at all, and 0 when
    // it reports that nothing was cached. Those two mean different things, so
    // they must print differently.
    (u.cached === null || u.cached === undefined ? '' : `cached=${u.cached} `) +
    `latency=${latencyMs}ms ttft=${ttftMs ?? '-'} failover=${failover}`
  );
}

function shouldFailoverFor(err) {
  if (isAuthError(err)) return false;
  if (isBadRequest(err)) return false;
  if (isFailoverEligible(err)) return true;
  // Unknown errors: try the next fallback. Failing safe.
  return true;
}

// Normalize { primary, fallback, fallbacks } into an ordered [primary, ...fallbacks] list.
function buildChain({ primary, fallback, fallbacks } = {}) {
  if (!primary) throw new Error('failover: primary provider missing');
  const chain = [primary];
  if (Array.isArray(fallbacks)) {
    for (const f of fallbacks) if (f) chain.push(f);
  } else if (fallback) {
    chain.push(fallback);
  }
  return chain;
}

async function completeWithFailover(messages, options, chainOpts = {}) {
  const fullChain = buildChain(chainOpts);
  const configuredPrimary = fullChain[0];
  const chain = activeChain(fullChain);
  recordCall();

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    // "failover" = we didn't serve from the configured primary (it errored OR
    // its circuit was open and we skipped it). Accurate for the stats signal.
    const failover = provider !== configuredPrimary;
    try {
      const result = await provider.complete(messages, options);
      breaker.reset(provider.name); // healthy → close any open circuit
      if (failover) recordFailover();
      else recordPrimarySuccess();
      logLine({ ...result, failover });
      return { ...result, failover, tier: i };
    } catch (err) {
      lastErr = err;
      if (isRateLimit(err)) {
        const cd = breaker.trip(provider.name, err); // open circuit → next calls skip it
        console.warn(`[LLM] ${provider.name} quota/rate-limited (429) — circuit open ${Math.round(cd / 1000)}s.`);
      }
      const isLast = i === chain.length - 1;
      if (!shouldFailoverFor(err)) {
        // Non-failoverable error class (auth/bad-request). Don't try more.
        console.error(`[LLM] ${provider.name} failed (non-failoverable): ${err.message}`);
        throw err;
      }
      if (isLast) {
        recordAllFailed();
        console.error(`[LLM] All providers in chain exhausted. Last error from ${provider.name}: ${err.message}`);
        throw err;
      }
      const next = chain[i + 1];
      console.warn(`[LLM] ${provider.name} failed: ${err.message}. Failing over to ${next.name} (tier ${i + 1}).`);
    }
  }
  // Defensive — loop should always return or throw above.
  throw lastErr || new Error('failover: empty chain');
}

// Same chain semantics for streaming. Failover only happens before the
// first chunk arrives — once we've started yielding tokens we don't
// switch providers mid-stream (that would garble the output).
async function* streamWithFailover(messages, options, chainOpts = {}) {
  const fullChain = buildChain(chainOpts);
  const configuredPrimary = fullChain[0];
  const chain = activeChain(fullChain);
  recordCall();

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const failover = provider !== configuredPrimary;
    try {
      const iter = provider.stream(messages, options);
      // Force first chunk so a setup failure (or a hang) surfaces here, before
      // we commit to this provider. Bounded by firstChunkTimeoutMs.
      const first = await firstChunkWithDeadline(iter.next(), config.llm.firstChunkTimeoutMs, provider.name);
      breaker.reset(provider.name); // healthy → close any open circuit
      if (failover) { recordFailover(); console.warn(`[LLM] stream via ${provider.name} (failover, tier ${i})`); }
      else recordPrimarySuccess();
      if (!first.done) yield { ...first.value, tier: i, failover };
      // ─── THE STREAMED PATH LOGGED NOTHING ────────────────────────────────
      // completeWithFailover logs every call at :134. This function never did,
      // and production runs the streaming path — so the [LLM] line, the only
      // per-turn record of tokens spent, was absent on essentially every real
      // turn. Its absence was later read as evidence about caching. It was
      // evidence about logging.
      //
      // Logged from the TERMINAL chunk, which is the only one carrying usage
      // and the final latency.
      for await (const chunk of iter) {
        if (chunk && chunk.done) {
          logLine({ provider: provider.name, model: chunk.model, usage: chunk.usage,
                    latencyMs: chunk.latencyMs, ttftMs: chunk.ttftMs, failover });
        }
        yield { ...chunk, tier: i, failover };
      }
      return;
    } catch (err) {
      lastErr = err;
      if (isRateLimit(err)) breaker.trip(provider.name, err);
      const isLast = i === chain.length - 1;
      if (!shouldFailoverFor(err)) throw err;
      if (isLast) {
        recordAllFailed();
        throw err;
      }
      const next = chain[i + 1];
      console.warn(`[LLM] stream ${provider.name} failed: ${err.message}. Failing over to ${next.name} (tier ${i + 1}).`);
    }
  }
  throw lastErr || new Error('streamWithFailover: empty chain');
}

module.exports = {
  completeWithFailover,
  streamWithFailover,
  getFailoverStats
};
