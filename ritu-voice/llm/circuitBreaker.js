// ─── LLM CIRCUIT BREAKER ─────────────────────────────────────────────────────
// Stops the failover chain from hammering a provider that's already out of
// quota. When a provider returns 429 (rate/daily-token limit), we "open" its
// circuit for a cooldown window — subsequent calls SKIP it entirely and go
// straight to the next provider, instead of eating retries + a 429 on every
// single call until the quota resets.
//
// Self-healing: after the cooldown, the provider is eligible again; one probe
// call re-tries it. Success closes the circuit (provider recovered); another
// 429 re-opens it. No token-counting, no guessing the cap — the 429 is ground
// truth. State is in-memory: a restart just re-probes, which is harmless.
//
// Cooldown: honor the 429's Retry-After header when present (clamped), else a
// configurable default. A momentary per-minute limit (Retry-After ~seconds)
// recovers fast; a daily-token exhaustion (no/large header) re-probes on the
// default interval.

const DEFAULT_COOLDOWN_MS = parseInt(process.env.LLM_BREAKER_COOLDOWN_MS || '300000', 10); // 5 min
const MIN_COOLDOWN_MS = 1000;            // 1s floor
const MAX_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min ceiling (clamp huge daily Retry-After)
const ENABLED = process.env.ENABLE_LLM_CIRCUIT_BREAKER !== 'false'; // default ON

// providerName -> epoch ms until which the circuit is open.
const openUntil = new Map();

function enabled() { return ENABLED; }

function isOpen(name, now = Date.now()) {
  const until = openUntil.get(name);
  if (until == null) return false;
  if (until <= now) { openUntil.delete(name); return false; } // expired → auto-close
  return true;
}

function msRemaining(name, now = Date.now()) {
  const until = openUntil.get(name);
  return until && until > now ? until - now : 0;
}

// Pull Retry-After (seconds) from an OpenAI-SDK-style error, if present.
function retryAfterMs(err) {
  if (!err) return null;
  const h = err.headers || (err.response && err.response.headers);
  if (!h) return null;
  const raw = typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] || h['Retry-After']);
  if (raw == null) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

// Open the circuit for `name`. Returns the cooldown applied (ms).
function trip(name, err, now = Date.now()) {
  const ra = retryAfterMs(err);
  const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ra != null ? ra : DEFAULT_COOLDOWN_MS));
  openUntil.set(name, now + cooldown);
  return cooldown;
}

// Close the circuit (provider succeeded → it's healthy again).
function reset(name) { openUntil.delete(name); }

// { providerName: secondsRemaining } for diagnostics/stats.
function snapshot(now = Date.now()) {
  const out = {};
  for (const [name, until] of openUntil) {
    if (until > now) out[name] = Math.round((until - now) / 1000);
  }
  return out;
}

module.exports = { enabled, isOpen, msRemaining, trip, reset, snapshot };
