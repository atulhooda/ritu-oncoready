// ═══════════════════════════════════════════════════════════════════════════
// THE AUDIO OF A REAL CALL, KEPT AUTOMATICALLY
//
// EVERY ACCURACY NUMBER THIS PROJECT HAS EVER PRODUCED CAME FROM
// calls.transcript, AND THE TRANSCRIPT IS THE STT'S OUTPUT. So "the STT lost
// it" has been structurally invisible: we can see what Sarvam wrote, never what
// the caller said. capture-gap.js reports 46.2% of stated facts reaching the
// record, and that denominator only counts facts the STT already transcribed —
// it cannot see a drug or a name that never became text at all.
//
// MEASURED 2026-08-16: recording_url was populated on 28 of 155 calls, and
// NONE of them by the server. Every one was fetched by hand, by a person
// running tools/fetch-recording.js after something looked wrong. The five most
// recent calls — including the Kannada caller whose name was recorded as
// ರಾಜಮ್ಮ after she said it was not — have no audio kept at all. The evidence
// that would settle those cases expires on Exotel's retention clock.
//
// WHY THIS LIVES IN THE SERVER AND NOT IN THE TOOL. Exotel's API is
// IP-whitelisted to the deployment: running the tool from a laptop returns 401.
// The server is the process on the whitelisted address, so the server is the
// only thing that can reliably do this — which is also why doing it by hand was
// never going to scale past the days somebody remembered.
//
// AND WHY IT RETRIES. The recording does not exist at the instant the call ends;
// Exotel finishes writing it afterwards. A single fetch at hangup returns null
// and looks like "no recording" rather than "not yet".
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const config = require('./config');

// ONE construction of this URL. It was being built in three places already —
// tools/fetch-recording.js, tools/transcribe-truth.js and config.js each had
// their own host default — and a fourth copy here is how the next divergence
// starts. Both tools now import this.
const HOST = () => process.env.EXOTEL_HOST || (config.exotel && config.exotel.subdomain) || 'api.exotel.com';
const ACCOUNT = () => process.env.EXOTEL_ACCOUNT_SID || (config.exotel && config.exotel.accountSid) || '';
const AUTH = () => 'Basic ' + Buffer.from(
  `${process.env.EXOTEL_API_KEY || ''}:${process.env.EXOTEL_API_TOKEN || ''}`
).toString('base64');

/**
 * Ask Exotel for a call's recording URL.
 * → { url } on success (url may be null: the call has no recording)
 * → { err } when the API could not answer
 */
async function recordingUrlFor(callSid) {
  if (!callSid) return { err: 'no callSid' };
  const url = `https://${HOST()}/v1/Accounts/${encodeURIComponent(ACCOUNT())}/Calls/${encodeURIComponent(callSid)}.json`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: AUTH() } });
  } catch (e) {
    return { err: `network: ${e.message}` };
  }
  if (res.status === 401) {
    // Worth saying in full: this is the error a developer sees on their laptop
    // and misreads as bad credentials, then goes looking in the wrong place.
    return { err: 'HTTP 401 — the Exotel API is IP-whitelisted to the deployment; this only works from the server' };
  }
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const j = await res.json().catch(() => null);
  const rec = j && j.Call && j.Call.RecordingUrl;
  return { url: typeof rec === 'string' && rec ? rec : null };
}

// Exotel finishes writing the recording after the call ends, so the first
// attempt is expected to miss on a short call. Spread out rather than tight:
// three tries over ~4 minutes costs nothing and covers the observed lag.
const ATTEMPT_DELAYS_MS = [20_000, 60_000, 180_000];

/**
 * Fetch and store a call's recording URL, in the background, with retries.
 *
 * NEVER THROWS AND NEVER BLOCKS. This runs behind a finished call; a telephony
 * API being slow must not affect anything the caller experienced, and must not
 * fail the call log. Timers are unref'd so they cannot hold a test process open.
 */
function captureRecordingUrl(pool, callSid, opts = {}) {
  const delays = opts.delays || ATTEMPT_DELAYS_MS;
  if (!pool || !callSid) return;

  let attempt = 0;
  const tryOnce = async () => {
    attempt++;
    const { url, err } = await recordingUrlFor(callSid);
    if (url) {
      try {
        await pool.query(`UPDATE calls SET recording_url = $1 WHERE exotel_call_sid = $2`, [url, callSid]);
        console.log(`[${callSid}] 🎙 recording_url stored (attempt ${attempt})`);
      } catch (e) {
        console.error(`[${callSid}] recording_url stored fetch OK but write failed: ${e.message}`);
      }
      return;
    }
    if (attempt >= delays.length) {
      // Say WHICH of the two it was. "No recording" and "we never asked
      // successfully" are different problems and the log is the only place the
      // difference survives.
      console.warn(`[${callSid}] 🎙 no recording_url after ${attempt} attempts — ${err || 'Exotel reports no recording for this call'}`);
      return;
    }
    schedule();
  };

  const schedule = () => {
    const t = setTimeout(() => { tryOnce().catch((e) => console.error(`[${callSid}] recording capture: ${e.message}`)); }, delays[attempt]);
    if (typeof t.unref === 'function') t.unref();
  };

  schedule();
}

module.exports = { recordingUrlFor, captureRecordingUrl, ATTEMPT_DELAYS_MS };
