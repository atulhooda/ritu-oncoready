// ═══════════════════════════════════════════════════════════════════════════
// THE /media-stream SHARED-SECRET GATE — one decision, one diagnostic line.
//
// WHY THIS FILE EXISTS. On 2026-09-13 13:21 IST the Skin Essence service logged
// "[EXOTEL] /media-stream upgrade rejected: bad/missing secret" 102 times in 49
// seconds — Exotel retrying the stream for the whole length of one call while
// the caller heard nothing — and the line said neither WHAT was wrong (no
// secret at all? a different one?) nor WHO was knocking. The service's own
// MEDIA_STREAM_SECRET was set correctly; the Exotel Voicebot applet URL was not
// carrying it. Nothing in the log could tell those two apart.
//
// checkSecret() decides; logRejection() says which case it is, where it came
// from, and what the applet URL must look like — once, then a count. The
// secret's VALUE is never logged, only lengths.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

/**
 * @param {{required?: string, provided?: unknown}} a
 * @returns {{ok: boolean, reason: 'ungated'|'ok'|'no_secret'|'wrong_secret', providedLength?: number, requiredLength?: number}}
 */
function checkSecret({ required, provided }) {
  // Trim the configured value: a pasted trailing newline or tab must not turn
  // every call away (two Railway variables arrived with a leading TAB before).
  const req = typeof required === 'string' ? required.trim() : '';
  if (!req) return { ok: true, reason: 'ungated' };
  const got = provided == null ? '' : String(Array.isArray(provided) ? provided[0] : provided).trim();
  if (!got) return { ok: false, reason: 'no_secret', providedLength: 0, requiredLength: req.length };
  if (got !== req) return { ok: false, reason: 'wrong_secret', providedLength: got.length, requiredLength: req.length };
  return { ok: true, reason: 'ok' };
}

/**
 * At the WebSocket upgrade. MEASURED 2026-09-13 on the Skin Essence service:
 * Exotel opens /media-stream with NO query string even when the Voicebot applet
 * URL carries ?secret=… — the applet's query parameters arrive inside the first
 * `start` message as custom_parameters (the same place From/To/CallSid come
 * from). So an upgrade without a secret is not a refusal: it is DEFERRED to
 * gateAtStart. An upgrade that does carry a wrong secret is refused at once.
 */
function gateAtUpgrade({ required, query }) {
  const req = typeof required === 'string' ? required.trim() : '';
  if (!req) return { ok: true, verified: false, reason: 'ungated' };
  const provided = query && query.secret;
  if (provided == null || String(Array.isArray(provided) ? provided[0] : provided).trim() === '') {
    return { ok: true, verified: false, reason: 'deferred' };
  }
  const v = checkSecret({ required, provided });
  return v.ok ? { ok: true, verified: true, reason: 'ok' } : { ...v, verified: false };
}

/**
 * At Exotel's `start` message. If the upgrade already verified the secret this
 * is a no-op; otherwise the secret must be in start.custom_parameters. Missing
 * or wrong → the caller closes the socket before any audio is processed.
 */
function gateAtStart({ required, verifiedAtUpgrade, customParams }) {
  const req = typeof required === 'string' ? required.trim() : '';
  if (!req) return { ok: true, reason: 'ungated' };
  if (verifiedAtUpgrade) return { ok: true, reason: 'ok' };
  const cp = customParams || {};
  return checkSecret({ required, provided: cp.secret != null ? cp.secret : cp.Secret });
}

function hint(domain) {
  return `the Exotel Voicebot applet URL must be wss://${domain || '<this service domain>'}/media-stream?secret=<MEDIA_STREAM_SECRET exactly as set on this service>`;
}

/**
 * A throttled logger: the first rejection in a window gets the full diagnostic;
 * the rest are counted and summarised when the window rolls over. Injectable
 * clock and sink so a test can drive it.
 */
function makeRejectionLogger({ windowMs = 10_000, log = console.warn, now = Date.now } = {}) {
  let windowStart = 0;
  let suppressed = 0;
  let lastIp = null;
  return function logRejection({ reason, providedLength, requiredLength, ip, xff, domain, where }) {
    const t = now();
    const who = xff ? String(xff).split(',')[0].trim() : ip || 'unknown';
    if (windowStart && t - windowStart < windowMs) {
      suppressed++;
      lastIp = who;
      return;
    }
    if (suppressed > 0) {
      log(`[EXOTEL] /media-stream: …and ${suppressed} more rejection(s) in the last ${Math.round((t - windowStart) / 1000)}s (last from ${lastIp})`);
    }
    windowStart = t;
    suppressed = 0;
    const atStart = where === 'start';
    const what = reason === 'no_secret'
      ? (atStart ? 'no secret in the URL query nor in start.custom_parameters' : 'no ?secret= in the URL')
      : `wrong secret (got ${providedLength} chars, expected ${requiredLength})${atStart ? ' in start.custom_parameters' : ''}`;
    log(`[EXOTEL] /media-stream upgrade rejected: ${what}, from ${who} — ${hint(domain)}`);
  };
}

module.exports = { checkSecret, gateAtUpgrade, gateAtStart, makeRejectionLogger, hint };
