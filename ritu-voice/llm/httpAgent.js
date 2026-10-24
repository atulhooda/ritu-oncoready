// ─── SHARED KEEP-ALIVE HTTPS AGENT (LLM clients) ─────────────────────────────
// All four OpenAI-compatible providers (groq, gemini, deepinfra, sambanova)
// build `new OpenAI({...})` with no httpAgent, so they inherit the SDK's default
// agentkeepalive agent whose freeSocketTimeout is 4000ms — an idle keep-alive
// socket to the provider (US-hosted for Groq/Gemini) is closed just 4s after the
// last byte. A caller speaks / listens / thinks far longer than 4s between turns,
// so without this EVERY turn's first LLM call re-pays a cold India→US TLS1.3
// handshake (~250-450ms) directly on the path to first audio.
//
// One shared agent with freeSocketTimeout=60s keeps the socket warm across the
// gaps between conversational turns, reclaiming that handshake on turns 2+. 60s
// sits comfortably under typical provider server-side idle-close windows, so a
// stale-socket reset (which fails OVER rather than reconnecting in place — see
// retry.js / failover.js) stays rare. Env-tunable so it can be tightened from logs.
const Agent = require('agentkeepalive');
const HttpsAgent = Agent.HttpsAgent;

// Per-clinic silo: MAX_CONCURRENT_CALLS defaults to 10 and LLM calls are roughly
// serial within a single call, so a small socket pool is plenty — the keep-alive
// warmth is the point, not the pool size.
const FREE_SOCKET_TIMEOUT_MS = parseInt(process.env.LLM_KEEPALIVE_MS || '60000', 10);

const llmHttpsAgent = new HttpsAgent({
  keepAlive: true,
  freeSocketTimeout: FREE_SOCKET_TIMEOUT_MS, // hold an idle socket vs the SDK's 4s default
  timeout: 300000,        // active-socket timeout; >= the SDK's own bump so it can't be lowered
  maxSockets: 20,
  maxFreeSockets: 10,
});

module.exports = { llmHttpsAgent };
