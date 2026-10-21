// ─── LLM PROVIDER FACTORY + ENTRY POINT ─────────────────────────────────────
// Single import surface for the rest of the codebase. brain.js calls
// completeWithFailover() and streamWithFailover() exported from here; the
// factory wires the primary/fallback providers from env vars.
//
// Add a new OpenAI-compatible provider by writing a new <Name>Provider.js
// extending BaseLLMProvider and adding a case to buildProvider() below.

const config = require('../config');
const { GroqProvider } = require('./groqProvider');
const { SambanovaProvider } = require('./sambanovaProvider');
const { DeepinfraProvider } = require('./deepinfraProvider');
const { GeminiProvider } = require('./geminiProvider');
const {
  completeWithFailover: _completeWithFailover,
  streamWithFailover: _streamWithFailover,
  getFailoverStats
} = require('./failover');

// Lazy-built singletons. Don't construct on require — only when first used.
// Keeps `require('./llm')` cheap and avoids forcing API keys to exist at
// load time (useful for unit tests that mock the providers).
const providerCache = new Map();

function buildProvider(name) {
  switch (name) {
    case 'sambanova': {
      const apiKey = config.llm.sambanovaApiKey;
      if (!apiKey) throw new Error('LLM provider "sambanova" requested but SAMBANOVA_API_KEY is not set');
      return new SambanovaProvider({ apiKey, timeoutMs: config.llm.timeoutMs });
    }
    case 'groq': {
      const apiKey = config.groq.apiKey;
      if (!apiKey) throw new Error('LLM provider "groq" requested but GROQ_API_KEY is not set');
      return new GroqProvider({ apiKey, timeoutMs: config.llm.timeoutMs });
    }
    case 'groq-scout': {
      // Same Groq endpoint, different model. Llama 4 Scout — 5× the daily
      // token budget on Groq free tier. Distinct name so log lines and
      // failover-stats can tell Scout vs 70B apart.
      const apiKey = config.groq.apiKey;
      if (!apiKey) throw new Error('LLM provider "groq-scout" requested but GROQ_API_KEY is not set');
      return new GroqProvider({
        apiKey,
        model: config.llm.groqScoutModel,
        timeoutMs: config.llm.timeoutMs,
        name: 'groq-scout'
      });
    }
    case 'groq-qwen': {
      // Qwen3 32B on Groq — 60 RPM / 500K TPD free tier.
      const apiKey = config.groq.apiKey;
      if (!apiKey) throw new Error('LLM provider "groq-qwen" requested but GROQ_API_KEY is not set');
      return new GroqProvider({
        apiKey,
        model: config.llm.groqQwenModel,
        timeoutMs: config.llm.timeoutMs,
        name: 'groq-qwen'
      });
    }
    case 'groq-gpt-oss': {
      // OpenAI gpt-oss-120b on Groq — 30 RPM / 200K TPD free tier.
      const apiKey = config.groq.apiKey;
      if (!apiKey) throw new Error('LLM provider "groq-gpt-oss" requested but GROQ_API_KEY is not set');
      return new GroqProvider({
        apiKey,
        model: config.llm.groqGptOssModel,
        timeoutMs: config.llm.timeoutMs,
        name: 'groq-gpt-oss'
      });
    }
    case 'deepinfra': {
      const apiKey = config.llm.deepinfraApiKey;
      if (!apiKey) throw new Error('LLM provider "deepinfra" requested but DEEPINFRA_API_KEY is not set');
      return new DeepinfraProvider({
        apiKey,
        model: config.llm.deepinfraModel,
        timeoutMs: config.llm.timeoutMs
      });
    }
    case 'gemini': {
      // Google Gemini 2.5 Flash-Lite — no daily cap, India-payable, ~1.0s TTFT.
      // The right uncapped overflow once Groq's free daily quota is spent.
      const apiKey = config.llm.geminiApiKey;
      if (!apiKey) throw new Error('LLM provider "gemini" requested but GEMINI_API_KEY is not set');
      return new GeminiProvider({
        apiKey,
        model: config.llm.geminiModel,
        timeoutMs: config.llm.timeoutMs
      });
    }
    default:
      throw new Error(`Unknown LLM provider: "${name}". Supported: sambanova, groq, groq-scout, groq-qwen, groq-gpt-oss, deepinfra, gemini.`);
  }
}

function getProvider(name) {
  if (!providerCache.has(name)) providerCache.set(name, buildProvider(name));
  return providerCache.get(name);
}

// Resolve the configured primary + ordered fallback chain into provider
// instances. The chain ignores duplicates and providers whose keys aren't
// configured (logs a warning rather than failing — dev environments often
// only have one or two keys set).
function resolveChain() {
  const primaryName = config.llm.primaryProvider;
  const primary = getProvider(primaryName);

  // Prefer the validate()-resolved chain if present (filtered for key
  // presence and dedup). Otherwise fall back to raw env config so the
  // factory still works when validate() hasn't run yet (e.g. unit tests).
  const wanted = (Array.isArray(config.llm.effectiveFallbacks) && config.llm.effectiveFallbacks.length)
    ? config.llm.effectiveFallbacks
    : ((Array.isArray(config.llm.fallbackProviders) && config.llm.fallbackProviders.length)
        ? config.llm.fallbackProviders
        : (config.llm.fallbackProvider ? [config.llm.fallbackProvider] : []));

  const seen = new Set([primaryName]);
  const fallbacks = [];
  for (const name of wanted) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      fallbacks.push(getProvider(name));
    } catch (err) {
      console.warn(`[LLM] Fallback "${name}" unavailable: ${err.message} — skipping.`);
    }
  }
  return { primary, fallbacks };
}

// Public API: brain.js (and anything else needing the LLM) calls these.
async function completeWithFailover(messages, options) {
  return _completeWithFailover(messages, options, resolveChain());
}

async function* streamWithFailover(messages, options) {
  yield* _streamWithFailover(messages, options, resolveChain());
}

// Start the background health-probe (re-checks capped providers off the call
// path). Call once at server boot — NOT auto-started on require, so CLI scripts
// that just need provider schemas don't spin a timer or make probe calls.
const healthProbe = require('./healthProbe');
function startHealthProbe() { healthProbe.start(resolveChain); }

// Fire-and-forget: warm the keep-alive socket to the PRIMARY provider so the
// caller's FIRST real turn doesn't pay a cold India→US TLS handshake. Called at
// call start, hidden inside the cached greeting's ~5s dead window. Hits the
// provider DIRECTLY (not completeWithFailover), so it can never trip the circuit
// breaker or pollute failover stats; sends a 1-token throwaway completion and
// swallows every error. Pairs with httpAgent.js — the warmed socket sits in the
// keep-alive free pool (60s) and the first real turn reuses it. LLM_PREWARM=false
// disables it.
function prewarmPrimary() {
  if (process.env.LLM_PREWARM === 'false') return;
  let provider;
  try {
    provider = getProvider(config.llm.primaryProvider);
  } catch (_) {
    return; // primary not configured (missing key) — nothing to warm
  }
  Promise.resolve()
    .then(() => provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 1, temperature: 0 }))
    .then(() => console.log('[LLM] prewarm: primary socket warm'))
    .catch((err) => console.log(`[LLM] prewarm skipped (${err.code || err.status || err.message})`));
}

module.exports = {
  // Primary entry points
  completeWithFailover,
  streamWithFailover,
  // Background health-probe (call at server boot)
  startHealthProbe,
  // Fire-and-forget socket warm-up (call at call start)
  prewarmPrimary,
  // Diagnostics / tests
  getProvider,
  getFailoverStats,
  // Re-exports for tests
  GroqProvider,
  SambanovaProvider,
  DeepinfraProvider,
  GeminiProvider
};
