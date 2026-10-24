// ═══════════════════════════════════════════════════════════════════════════
// THE LEG WE HAVE NEVER MEASURED.
//
// Every latency number this project has is SERVER-SIDE ONLY. The dead-air figure
//     dead-air=1229ms (stt+debounce=342, llm+tool=555, tts-firstbyte=267)
// starts when WE detect end-of-speech and stops when WE hand the first audio
// frame to Exotel. The caller's actual experience also contains:
//
//     mouth → phone network → Exotel → our socket        (UPLINK, unmeasured)
//     our socket → Exotel → phone network → ear          (DOWNLINK, unmeasured)
//
// Industry figures put telephony at 300-500 ms round trip. If that holds here,
// the patient already hears ~1.7 s and shaving 200 ms off the LLM changes
// nothing they would notice — the right move would be the telephony provider,
// not the model. If it is 60 ms, the opposite. We have been optimising without
// knowing which, and "sub-1-second" is unanswerable until we do.
//
// TWO MEASUREMENTS, BOTH FROM SIGNALS ALREADY ARRIVING:
//
// 1. UPLINK DRIFT. Exotel's media frames are expected to carry a stream-relative
//    `timestamp` (ms since stream start), as Twilio's do. Comparing that to our
//    own wall clock gives the one-way delay plus clock offset. We do NOT read
//    that field today — index.js takes `data.media.payload` and discards the
//    rest of the frame unexamined. ASSUMED until a live call proves the field
//    exists: hence recordFrameShape(), which logs the frame's keys ONCE per call
//    so the next real call settles it instead of us guessing.
//
// 2. MARK ROUND TRIP. We send a `mark` after audio; Exotel echoes it when
//    playback finishes. echo − send − (audio duration) ≈ downlink + return. An
//    earlier attempt to read this from logs failed because the gap is dominated
//    by the audio itself; measured here with the duration known, the residual is
//    the network.
//
// COST: one integer compare per frame and a bounded array. Nothing blocking,
// nothing async, no allocation in the hot path. A measurement that slows the
// thing it measures is worse than no measurement.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// A frame is 20 ms of PCM16 @ 8 kHz = 320 bytes. Sampling 1-in-25 keeps ~2
// readings/second, which is plenty for a median and costs nothing.
const SAMPLE_EVERY = 25;
const MAX_SAMPLES = 400;

/**
 * WHERE DOES EXOTEL ACTUALLY DIAL US FROM?
 *
 * This settles a hosting decision worth ~60 ms per turn, and the two answers
 * point in OPPOSITE directions:
 *
 *   · If Exotel's media bridge sits in AWS ap-southeast-1, our Railway server
 *     (x-railway-edge: sin1) is ALREADY co-located with it, and moving to
 *     Mumbai would LENGTHEN both audio legs.
 *   · If it dials from an Indian address, Singapore costs us a round trip on
 *     the audio path and Mumbai is a straight win.
 *
 * Both are plausible. api.exotel.com resolves into ap-southeast-1, but that is
 * the REST control plane; a licensed Indian operator must interconnect in India,
 * while the WebSocket bridge in front of it is ordinary cloud software that can
 * live anywhere. Deciding a migration on a REST endpoint's DNS record would be
 * exactly the guess this project keeps getting burned by.
 *
 * Railway fronts us with its own edge, so remoteAddress may be their proxy
 * rather than Exotel. x-forwarded-for carries the original when set — log both,
 * unresolved, and let one real call answer it.
 */
function logPeer(request) {
  try {
    const xff = request && request.headers && request.headers['x-forwarded-for'];
    const direct = request && request.socket && request.socket.remoteAddress;
    // The LEFTMOST x-forwarded-for entry is the original client; everything
    // after it is proxies. Reported separately so a missing header is visible
    // as "none" rather than silently falling back and looking like an answer.
    const origin = xff ? String(xff).split(',')[0].trim() : null;
    console.log(
      `[TELEPHONY] peer origin=${origin || 'none (no x-forwarded-for)'} ` +
      `socket=${direct || 'unknown'}`
    );
  } catch (err) {
    // A diagnostic must never be able to drop a call.
    console.warn(`[TELEPHONY] peer capture failed: ${err.message}`);
  }
}

class TelephonyProbe {
  constructor(callSid) {
    this.callSid = callSid;
    this.startedAt = Date.now();
    this._frames = 0;
    this._shapeLogged = false;
    this.uplinkDrift = [];     // ms, arrival − stream timestamp
    this.markRoundTrip = [];   // ms, echo − send − audioDuration
    this._pendingMarks = new Map();
    // Counted, not silently dropped — see markEchoed().
    this._negativeResiduals = 0;
  }

  /**
   * Log the SHAPE of the first media frame — keys only, never the payload.
   * This is the honest way to find out whether Exotel sends a timestamp: ask a
   * real call rather than assume the protocol matches Twilio's.
   */
  recordFrameShape(media) {
    if (this._shapeLogged || !media || typeof media !== 'object') return;
    this._shapeLogged = true;
    const keys = Object.keys(media).filter((k) => k !== 'payload');
    const sample = {};
    for (const k of keys) {
      const v = media[k];
      if (typeof v === 'string' || typeof v === 'number') sample[k] = v;
    }
    console.log(`[TELEPHONY ${this.callSid}] media frame fields (payload omitted): ${JSON.stringify(sample)}`);
    if (!keys.some((k) => /time|stamp/i.test(k))) {
      console.log(`[TELEPHONY ${this.callSid}] no timestamp field — uplink cannot be measured this way; a handset loopback is required`);
    }
  }

  /** Called per inbound media frame. Must stay trivial. */
  onFrame(media) {
    this._frames++;
    if (this._frames === 1) this.recordFrameShape(media);
    if (this._frames % SAMPLE_EVERY !== 0) return;
    if (this.uplinkDrift.length >= MAX_SAMPLES) return;

    const ts = media && (media.timestamp ?? media.timeStamp ?? media.ts);
    const streamMs = Number(ts);
    if (!Number.isFinite(streamMs)) return;

    // Arrival relative to OUR start, minus where the stream says the audio sat.
    // This is one-way delay PLUS a fixed clock offset — so the ABSOLUTE value is
    // not the uplink. The value that matters is how it behaves: a constant
    // offset is clock skew, a RISING one is buffering, and the spread across a
    // call is jitter. Reported as median + spread for that reason, never as
    // "the uplink is N ms".
    this.uplinkDrift.push((Date.now() - this.startedAt) - streamMs);
  }

  /**
   * @param audioStartedAt when the FIRST byte of this stretch was written —
   *   not when the mark was sent. The mark goes out after the whole utterance
   *   has been pushed into the socket (~200ms for ~4s of audio), while Exotel
   *   echoes only once PLAYBACK completes. Measuring from the mark made every
   *   residual negative, and the guard below then discarded all of them: the
   *   first live call (2026-08-05) echoed eight marks and recorded zero.
   */
  markSent(name, audioDurationMs, audioStartedAt) {
    this._pendingMarks.set(name, {
      at: Number(audioStartedAt) || Date.now(),
      audioMs: Number(audioDurationMs) || 0,
    });
  }

  markEchoed(name) {
    const p = this._pendingMarks.get(name);
    if (!p) return;
    this._pendingMarks.delete(name);
    // echo − first-byte-out − the audio Exotel had to play = network + handling.
    const residual = (Date.now() - p.at) - p.audioMs;
    // Negatives are still dropped — they mean the duration estimate exceeded
    // reality, which is information about the estimate, not the network. But
    // they are now counted, because "everything was discarded" and "nothing
    // arrived" produced the same n=0 last time and cost a call to tell apart.
    if (residual < 0) { this._negativeResiduals++; return; }
    if (this.markRoundTrip.length < MAX_SAMPLES) this.markRoundTrip.push(residual);
  }

  static _median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  /** Compact summary for the call's diagnostics. Null when nothing was seen. */
  summary() {
    const d = this.uplinkDrift;
    const m = this.markRoundTrip;
    return {
      frames: this._frames,
      uplinkDriftMedianMs: TelephonyProbe._median(d),
      // Spread is the honest signal here — see the note in onFrame().
      uplinkDriftSpreadMs: d.length >= 2 ? Math.max(...d) - Math.min(...d) : null,
      uplinkSamples: d.length,
      markResidualMedianMs: TelephonyProbe._median(m),
      markSamples: m.length,
      // n=0 with negatives>0 means the estimate is wrong; n=0 with negatives=0
      // means no echo arrived. Last time those two looked identical.
      markNegativeResiduals: this._negativeResiduals,
    };
  }

  logSummary() {
    const s = this.summary();
    if (!s.frames) return;
    console.log(
      `[TELEPHONY ${this.callSid}] frames=${s.frames} ` +
      `uplinkDrift median=${s.uplinkDriftMedianMs ?? 'n/a'}ms spread=${s.uplinkDriftSpreadMs ?? 'n/a'}ms (n=${s.uplinkSamples}) ` +
      `markResidual median=${s.markResidualMedianMs ?? 'n/a'}ms (n=${s.markSamples}, ${s.markNegativeResiduals} negative)`
    );
  }
}

module.exports = { TelephonyProbe, logPeer };
