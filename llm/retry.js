// ─── RETRY HELPER ────────────────────────────────────────────────────────────
// Tight exponential-backoff retry for transient LLM provider errors. Designed
// for voice-call latency budgets: total retry time stays under ~2s so the
// failover wrapper can give up and switch providers before the patient hears
// dead air.

const DEFAULT_DELAYS_MS = [500, 1500]; // 2 retries, total budget < 2s

function isRateLimit(err) {
  return err && (err.status === 429 || err.statusCode === 429);
}

function isAuthError(err) {
  if (!err) return false;
  const code = err.status || err.statusCode;
  return code === 401 || code === 403;
}

function isBadRequest(err) {
  if (!err) return false;
  const code = err.status || err.statusCode;
  return code === 400;
}

function isServerError(err) {
  if (!err) return false;
  const code = err.status || err.statusCode;
  return code >= 500 && code < 600;
}

function isNetworkError(err) {
  if (!err) return false;
  const code = err.code || '';
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

// Retryable in-place: nothing. A 429 used to retry in-place (~2s of backoff),
// but in a voice pipeline with a failover chain + circuit breaker that's the
// wrong trade: a daily-token 429 won't clear in 2s, so we'd just add dead air
// before failing over anyway (and the clinic is nowhere near the per-minute
// limit). We now fail over IMMEDIATELY on 429 — the failover layer trips the
// circuit breaker so subsequent calls skip the capped provider entirely.
function isRetryableInPlace(/* err */) {
  return false;
}

// Retryable via failover: server errors and network errors.
function isFailoverEligible(err) {
  return isServerError(err) || isNetworkError(err) || isRateLimit(err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run `fn` with up to N retries on retryable errors. Backoff delays are
// fixed (not multiplicative beyond the array) to keep total budget bounded.
async function withRetry(fn, { delays = DEFAULT_DELAYS_MS, label = 'llm' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableInPlace(err) || attempt === delays.length) throw err;
      const delay = delays[attempt];
      console.warn(`[LLM] ${label}: retryable error (${err.status || err.code || err.message}). Retry ${attempt + 1}/${delays.length} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = {
  withRetry,
  isAuthError,
  isBadRequest,
  isFailoverEligible,
  isRateLimit,
  isServerError,
  isNetworkError,
  DEFAULT_DELAYS_MS
};
