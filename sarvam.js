const axios = require('axios');
const https = require('https');
const WebSocket = require('ws');
const config = require('./config');
// redact has no imports of its own — safe here, no cycle reachable.
const { speech } = require('./redact');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TTS_MAX_RETRIES = 1;
const STT_MAX_RECONNECT_ATTEMPTS = 3;
const STT_RECONNECT_BASE_DELAY_MS = 1000;

// At 8kHz PCM16: 2 bytes/sample × 8000 samples/sec = 16 bytes/ms.
// 100ms = 1600 bytes. STT batches 100ms of audio before flushing.
const STT_BATCH_BYTES = 1600;

// ─── HTTP KEEP-ALIVE AGENT ───────────────────────────────────────────────────
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10
});

// ─── LANGUAGE DETECTION ──────────────────────────────────────────────────────
// Maps the dominant Indic script in the text to a Sarvam language code so TTS
// renders naturally. The brain prompt now enforces ONE script per reply
// (Devanagari Hindi OR English — never romanized Hindi), so:
//   - Any Indic script present → that language's code (Hindi reads cleanly).
//   - Pure Latin (no Indic) → en-IN, because a Latin-only reply is now
//     genuine English (the prompt forbids romanized Hindi). The English
//     voice reads English far better than the Hindi voice did.
const SCRIPT_RANGES = [
  { code: 'hi-IN', re: /[ऀ-ॿ]/g, name: 'devanagari' }, // Hindi/Marathi
  { code: 'pa-IN', re: /[਀-੿]/g, name: 'gurmukhi'   }, // Punjabi
  { code: 'bn-IN', re: /[ঀ-৿]/g, name: 'bengali'    },
  { code: 'gu-IN', re: /[઀-૿]/g, name: 'gujarati'   },
  { code: 'od-IN', re: /[଀-୿]/g, name: 'odia'       },
  { code: 'ta-IN', re: /[஀-௿]/g, name: 'tamil'      },
  { code: 'te-IN', re: /[ఀ-౿]/g, name: 'telugu'     },
  { code: 'kn-IN', re: /[ಀ-೿]/g, name: 'kannada'    },
  { code: 'ml-IN', re: /[ഀ-ൿ]/g, name: 'malayalam'  }
];

// Marathi and Hindi BOTH use Devanagari, so script alone can't tell them
// apart. These tokens are high-precision Marathi markers — extremely common
// in Marathi, effectively absent in Hindi — so their presence in Devanagari
// text means route to the Marathi voice (mr-IN) instead of Hindi (hi-IN).
// (JS \b is ASCII-only, so we rely on these being distinctive whole words;
// false-positive risk on Hindi text is negligible.)
const MARATHI_MARKERS = /(दुखत|दुखतंय|दुखतोय|दुखते|उद्या|परवा|येऊ|येईल|येतो|येते|येणार|जाऊ|जाईल|कधी|किती|पाहिजे|हवं|हवे|होतंय|होतोय|आहात|आहेस|बरं|चालेल|जमेल|भेटायच|दाखवायच|बुक करायच|करायच|सांगा|सांगू|द्या|आहे|आहेत|नाही|नाहीत|वाजता|सकाळी|दुपारी|संध्याकाळी|किंवा|केली|केला|केले|तुम्ही|तुला|मला|माझ|तुमच|आपल|काय|कुठे|कुठली|कधी|कसं|कसे|आणि|हवं|हवी|हवे|निरोप|तक्रार|बरं|पाहिजे|करायच)/;

// HINDI markers — extremely common in Hindi, effectively absent in Marathi
// (Marathi uses आहे/नाही/काय/मला, never क्या/नहीं/मुझे). Split by strength
// because a SINGLE weak token can be fabricated by garbled STT — we saw a
// Marathi caller's noisy transcript "सर सर दोस्तों है।" flip the whole call to
// the Hindi voice off one stray "है". So a lone weak marker is NOT enough.
//
// STRONG = clear Hindi content/intent words a Marathi sentence wouldn't carry
// and STT noise rarely fabricates. WEAK = short, common, easily mis-heard.
// Deliberately excludes bare "आप" (collides with Marathi आपण/आपल्या).
// मेरे/मेरा/मेरी (Marathi uses माझ*) and the रहा/रही/रहे progressive (Marathi's
// राहा is spelled रा-हा, so the substring never collides) are unambiguous Hindi.
// Added after a live call opened "यार मेरे दांत में दर्द हो रहा था" and matched
// NOTHING here — Ritu answered a Hindi opener in Marathi for a full turn.
const HINDI_STRONG = /(नहीं|नही|क्या|क्यों|मुझे|मुझको|मेरे|मेरा|मेरी|मैं|मैंने|हूँ|हूं|चाहिए|कीजिए|दीजिए|कैसे|कहाँ|कहां|कितना|कितने|आपको|आपका|आपसे|हिंदी|करूँ|करूंगा|करूँगा|होगा|होगी|रहा|रही|रहे)/;
const HINDI_ANY = /(है|हैं|नहीं|नही|क्या|क्यों|मुझे|मुझको|मेरे|मेरा|मेरी|हूँ|हूं|मैं|मैंने|और|कहाँ|कहां|हाँ|हां|चाहिए|कीजिए|दीजिए|कैसे|कितना|कितने|आपको|आपका|आपसे|हिंदी|करूँ|करूंगा|करूँगा|होगा|होगी|रहा|रही|रहे|यार|था|थी)/g;

// GRAMMAR, not vocabulary — the markers above are pronouns, question words and
// copulas, and a terse clinic sentence carries none of them. "शुगर के लिए दिखाना
// है" and "खांसी के लिए अपॉइंटमेंट" scored 0-1 and failed the ≥2 rule, so
// _langCode() fell back to GREETING_LANG (mr-IN) and a Hindi caller was answered
// in MARATHI. Not just by the LLM — everything that does not come from the model
// reads _langCode(): both pre-visit history questions, the medicine read-back,
// silence prompts, the garble re-ask, the persisted medication row's language
// field, and the 108 / self-harm emergency script. A Hindi caller whose emergency
// opener is short heard the 108 instruction in Marathi.
//
// The reply-side flip cannot rescue those turns, because the replies in question
// are CANNED MARATHI — looksLikeHindi() on Ritu's own text is false, so there is
// nothing to sync to.
//
// DELIMITED, because HINDI_ANY is bare substring alternation. Un-delimited "से"
// matches inside कैसे/जैसे/ऐसे and "को" inside Marathi कोणत्या — which would flip
// Marathi callers to Hindi, the exact oscillation the design forbids. JS \b is
// ASCII-only and never matches beside Devanagari (this project has been bitten by
// that three times), so the guard is an explicit delimiter class.
//
// Postpositions chosen for languages that do NOT share them: Marathi uses
// पासून/कडून for से, मध्ये for में, ला/स for को, पर्यंत for तक. Deliberately
// omitted: पर (means "on" in Marathi too).
const HINDI_POSTPOS = /(?:^|[\s,।!?"'()])(से|में|को|तक)(?=[\s,।!?"'()]|$)/g;
// Hindi infinitive/habitual forms. Marathi's equivalents are करायचं/करायची,
// दाखवायचं, घेतो/घेते — no overlap in the WORD, but there is one in the
// SUBSTRING: un-delimited "करना" matches inside करनाल (Karnal, the city), which
// occurs 22 times in the 5,959-line Marathi corpus — "करनाल वरून पानीपत जाण्या
// करीता मला रेल्वे दाखवा". Measured, not assumed, and the reason this list is
// delimited like the postpositions rather than left as plain alternation.
const HINDI_VERBFORM = /(?:^|[\s,।!?"'()])(करना|करनी|करने|करवाना|करवानी|लेता|लेती|लेना|होता|होती)(?=[\s,।!?"'()]|$)/g;
const HINDI_PURPOSE = /के\s*लिए/g;

// PROMOTED TO STRONG — one occurrence is enough to call the turn Hindi, because
// Marathi expresses these differently and, measured over 5,959 real Marathi lines
// (4,675 MUCS references + 1,284 real Sarvam 8kHz hypotheses), each appears
// EXACTLY ZERO times:
//   के लिए   — Marathi suffixes -साठी
//   दिखाना   — Marathi दाखवणे
//   कितनी    — plain omission; कितना and कितने were already STRONG
// This is what actually rescues the terse clinic opener. Without it "खांसी के लिए
// अपॉइंटमेंट" carries exactly one marker and dies on the ≥2 rule — the marker
// list was never the binding constraint, the threshold was.
// Plus the Hindi INFINITIVE morphology, delimited. Marathi forms the same idea as
// करायची/करायचं/करायला — the -नी/-ना/-ने ending is Hindi, and this is what carries
// "अपॉइंटमेंट करनी", the terse opener the product is judged by. Also zero
// occurrences across the same 5,959 Marathi lines when delimited (un-delimited
// करना hits 22, all inside करनाल — see HINDI_VERBFORM).
//
// NOT promoted, deliberately: दर्द. It too scores zero on that corpus, but the
// corpus is read speech about trains and weather — its silence on a pain word
// reflects topic coverage, not grammar, and दर्द is a plausible loanword in
// spoken Marathi. Zero occurrences is only evidence when the corpus could have
// contained the word.
const HINDI_STRONG_PHRASE = /(के\s*लिए|दिखाना|दिखाने|कितनी)|(?:^|[\s,।!?"'()])(करनी|करना|करने|करवानी|करवाना)(?=[\s,।!?"'()]|$)/;

// True when text looks like DELIBERATE Hindi. Requires (a) NO Marathi marker
// (so a Marathi sentence mixing one Hindi word never flips), AND (b) either a
// STRONG Hindi word, or ≥2 Hindi markers total. One lone weak token (the STT-
// noise case) is intentionally not enough.
function looksLikeHindi(text) {
  if (!text) return false;
  if (MARATHI_MARKERS.test(text)) return false;
  if (HINDI_STRONG.test(text)) return true;
  if (HINDI_STRONG_PHRASE.test(text)) return true;
  const count = (re) => (text.match(re) || []).length;
  // The Marathi veto above is what makes it safe to pool these: a sentence has
  // to be Marathi-marker-free BEFORE any of this counts.
  return (count(HINDI_ANY) + count(HINDI_POSTPOS)
          + count(HINDI_VERBFORM) + count(HINDI_PURPOSE)) >= 2;
}

// ─── THE DEVANAGARI PAIR: WHICH ONE IS THE PATIENT SPEAKING, THIS TURN ──────
// Hindi and Marathi share a script and, in production, one STT session. That
// session is pinned by Sarvam's language tag on the first "strong" utterance —
// and its own comment admits that tag is wrong on 50–80% of short fragments.
// Live call 82a3d38c (2026-08-29): a Marathi speaker, four Marathi turns, tagged
// hi-IN on fragments, pinned, and answered in Hindi for eight minutes — including
// "जी बिल्कुल!" to "मराठीत बोलू शकता?". Nothing could flip it back, because the
// only thing that ever set _hindiInCall was the tag, the model's own reply, or a
// one-way patient-side check that flipped TO Hindi and never FROM it.
//
// Replayed through looksLikeHindi, that call's first four patient turns vote
// Marathi, and its first Hindi-looking turn is the patient accommodating Ritu
// after she had already switched. The text was right the whole time; the tag
// was what was listened to.
//
// So for the pair the REPLY language follows the PATIENT'S TEXT, every turn,
// in both directions. looksLikeHindi already vetoes on Marathi markers, so a
// Marathi sentence that borrows one Hindi word stays Marathi; looksLikeMarathi
// is its mirror, with a token floor so a lone mis-heard "नाही" cannot flip a
// Hindi caller. No evidence either way → hold the current language.
function looksLikeMarathi(text) {
  if (!text) return false;
  const toks = String(text).trim().split(/\s+/).filter(Boolean).length;
  return toks >= 3 && MARATHI_MARKERS.test(text);
}
// The decision is made on the TURN (the coalesced fragments), and both
// directions need a sentence: a lone strong token — "हाँ", "ठीक" — is not a
// language choice. The Marathi side always had the floor (looksLikeMarathi);
// the Hindi side flipped a Marathi call off a single fragment (82a3d38c).
const PAIR_MIN_TOKENS = 3;
function pairLanguage(text, current) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (tokens >= PAIR_MIN_TOKENS && looksLikeHindi(text)) return 'hi-IN';
  if (looksLikeMarathi(text)) return 'mr-IN';
  return current;
}

function detectLanguageCode(text) {
  if (!text) return 'hi-IN';
  let best = { code: null, count: 0, name: 'none' };
  for (const s of SCRIPT_RANGES) {
    const count = (text.match(s.re) || []).length;
    if (count > best.count) best = { code: s.code, count, name: s.name };
  }
  // No Indic script at all → genuine English reply → English voice.
  if (best.count === 0) return 'en-IN';
  // Devanagari is shared by Hindi + Marathi — disambiguate via Marathi markers.
  if (best.code === 'hi-IN' && MARATHI_MARKERS.test(text)) return 'mr-IN';
  return best.code;
}

// ─── LEGACY μ-LAW HELPERS (kept for reference, not called on Exotel path) ────
// Exotel sends PCM16 natively, so no mulaw decoding is needed in the audio
// path. These helpers stay so any future μ-law capable path can use them.

const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xFF;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function mulawToPcm16(mulawBuffer) {
  const pcm = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulawBuffer[i]], i * 2);
  }
  return pcm;
}

// addWavHeader() DELETED 2026-07-27. It had exactly one caller — _sendPcm —
// and there it was corrupting every chunk of every call (see the note there).
// It is not kept "in case someone needs it": a helper named addWavHeader
// sitting one screen above a streaming sender is precisely how a per-FILE
// operation got applied per-CHUNK in the first place. If a genuine WAV file
// ever needs writing, take it from git history and put it next to the code
// that writes files.

function resamplePcm16(pcmBuffer, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuffer;
  const ratio = fromRate / toRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s1 = pcmBuffer.readInt16LE(srcIndex * 2);
    const s2 = (srcIndex + 1 < inputSamples) ? pcmBuffer.readInt16LE((srcIndex + 1) * 2) : s1;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s1 + (s2 - s1) * frac))), i * 2);
  }
  return output;
}

function parseWav(wavBuffer) {
  const sampleRate = wavBuffer.readUInt32LE(24);
  let offset = 12;
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return { pcmData: wavBuffer.subarray(offset + 8, offset + 8 + chunkSize), sampleRate };
    }
    offset += 8 + chunkSize;
  }
  return { pcmData: wavBuffer.subarray(44), sampleRate };
}

// ─── TTS PRE-CONNECT (Phase C latency, flag ENABLE_TTS_PREWARM) ──────────────
// Every sentence used to pay the full TLS+WS handshake + config round-trip to
// Sarvam (~300-500ms of the ~520-800ms observed first-chunk time) INSIDE the
// turn's dead-air. The prewarm pool opens ONE socket and sends its config while
// the LLM is still generating (callHandler triggers it at speculation-start and
// at dispatch), so when sentence 1 lands only text+flush+synthesis remain.
// One slot, keyed by (speaker, languageCode): a claim must match exactly and be
// fresh, else streamTTS dials fresh exactly as before — a dead, stale or
// mismatched prewarm can never break a turn, it is only ever a saved handshake.
const ENABLE_TTS_PREWARM = process.env.ENABLE_TTS_PREWARM === 'true';
const TTS_PREWARM_MAX_AGE_MS = parseInt(process.env.TTS_PREWARM_MAX_AGE_MS || '8000', 10);
// ASSUMED — send_completion_event is not in any Sarvam parameter table we have
// read; the behaviour (a terminal event after the last audio chunk) is inferred
// from our own stream-close handling working. Hard-coded, never env-tunable, so
// a wrong guess here cannot be dialled up in production the way the endpointing
// knob was. Upgrade to DOC: when the TTS websocket reference is checked.
const TTS_WS_URL = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`;

let _ttsPrewarmSlot = null; // { ws, speaker, languageCode, createdAt }

// DOC:https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert —
// bulbul:v3 accepts `temperature` (0.01–2.0, default 0.6). Sent only when the
// clinic set one (config.temperatureForLang), so an unset knob changes nothing.
function _ttsTemperature(languageCode) {
  const t = config.temperatureForLang(languageCode);
  return t === undefined ? {} : { temperature: t };
}

// Per-session style (pace / temperature) overrides the deploy's defaults. Only
// OncoReady browser sessions pass one today; every phone call passes nothing.
function _ttsStyleFields(languageCode, style = {}) {
  return {
    pace: style.pace !== undefined ? style.pace : config.paceForLang(languageCode),
    ...(style.temperature !== undefined ? { temperature: style.temperature } : _ttsTemperature(languageCode)),
  };
}

function _ttsConfigMessage(languageCode, speaker, style) {
  return JSON.stringify({
    type: 'config',
    data: {
      target_language_code: languageCode,
      speaker,
      ..._ttsStyleFields(languageCode, style),
      speech_sample_rate: 8000,
      enable_preprocessing: true,
      output_audio_codec: 'linear16'
    }
  });
}

function prewarmTTS(opts = {}) {
  if (!ENABLE_TTS_PREWARM) return;
  const speaker = opts.speaker || config.sarvam.speaker;
  const languageCode = opts.languageCode || 'hi-IN';
  const s = _ttsPrewarmSlot;
  // A fresh, matching slot (open or still dialing) is already doing the job.
  if (s && s.speaker === speaker && s.languageCode === languageCode &&
      Date.now() - s.createdAt < TTS_PREWARM_MAX_AGE_MS &&
      (s.ws.readyState === WebSocket.CONNECTING || s.ws.readyState === WebSocket.OPEN)) {
    return;
  }
  discardTTSPrewarm();
  let ws;
  try {
    ws = new WebSocket(TTS_WS_URL, [`api-subscription-key.${config.sarvam.apiKey}`]);
  } catch (e) {
    return; // prewarm is best-effort; streamTTS dials fresh
  }
  const slot = { ws, speaker, languageCode, createdAt: Date.now() };
  _ttsPrewarmSlot = slot;
  ws.on('open', () => {
    try { ws.send(_ttsConfigMessage(languageCode, speaker)); } catch (e) { /* claim falls back */ }
  });
  const clear = () => { if (_ttsPrewarmSlot === slot) _ttsPrewarmSlot = null; };
  ws.on('error', (err) => { console.warn(`[SARVAM] TTS prewarm socket error: ${err.message}`); clear(); });
  ws.on('close', clear);
}

function discardTTSPrewarm() {
  const slot = _ttsPrewarmSlot;
  _ttsPrewarmSlot = null;
  if (slot) { try { slot.ws.close(); } catch (e) {} }
}

function claimTTSPrewarm(speaker, languageCode) {
  const slot = _ttsPrewarmSlot;
  if (!slot) return null;
  if (slot.speaker !== speaker || slot.languageCode !== languageCode ||
      Date.now() - slot.createdAt >= TTS_PREWARM_MAX_AGE_MS ||
      (slot.ws.readyState !== WebSocket.CONNECTING && slot.ws.readyState !== WebSocket.OPEN)) {
    discardTTSPrewarm(); // mismatched or stale — drop it, don't let it linger
    return null;
  }
  _ttsPrewarmSlot = null; // claimed — caller takes sole ownership
  return slot;
}

// ─── STREAMING TTS via WebSocket ─────────────────────────────────────────────
// Opens WebSocket, sends text, receives PCM16 audio CHUNKS progressively.
// First chunk arrives in ~200-400ms. Each chunk is forwarded to Exotel immediately.
//
// Exotel Voice Streaming expects Linear PCM16 at 8kHz, so we request
// `output_audio_codec: 'linear16'` from Sarvam's bulbul:v3 TTS.

function streamTTS(text, onAudioChunk, opts = {}) {
  let ws = null;
  let aborted = false;

  // A pinned multilingual call forces its language via opts.languageCode — else
  // a Latin-only fragment ("Dr.", "OK!") detects as en-IN mid-Kannada reply and
  // breaks the (speaker, lang)-keyed prewarm chain. Legacy hi/mr calls pass
  // nothing and keep per-sentence detection.
  const languageCode = opts.languageCode || detectLanguageCode(text);
  // Voice is decided per-CALL by the caller (locked once, no mid-call switching)
  // and passed in. target_language_code still follows each sentence for correct
  // pronunciation; only the speaker identity is held steady.
  const speaker = opts.speaker || config.sarvam.speaker;
  const style = { pace: opts.pace, temperature: opts.temperature };
  const styled = style.pace !== undefined || style.temperature !== undefined;

  // Prewarmed socket for this exact (speaker, lang)? Its handshake+config are
  // already done (or in flight) — only text+flush+synthesis remain. A styled
  // request never claims one: the prewarm was configured with the defaults.
  const warm = styled ? null : claimTTSPrewarm(speaker, languageCode);
  if (warm) {
    ws = warm.ws;
  } else {
    ws = new WebSocket(TTS_WS_URL, [`api-subscription-key.${config.sarvam.apiKey}`]);
  }
  // ─── COLD DIAL OR WARM CLAIM? THE NUMBER THAT DECIDES A PROJECT ──────────
  // Per-call socket reuse has been proposed to save the handshake. It saves no
  // MONEY at all — Sarvam bills characters, not connections — so its only
  // justification is latency, and prewarmTTS already hides the handshake on the
  // common turn. Whether reuse is worth building therefore rests on ONE
  // unmeasured quantity: how often a sentence dials cold anyway.
  //
  // Recorded on the handle so callHandler can count it per call. If cold dials
  // per call turn out to be ~1 (one reply = one sentence, and prewarm covered
  // it), the reuse project buys close to nothing and should not be built.
  const acquiredWarm = !!warm;

  const promise = new Promise((resolve, reject) => {
    const ttsStart = Date.now();
    let firstChunkTime = 0;
    let totalBytes = 0;
    let chunkCount = 0;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.error(`[SARVAM] TTS STREAM timeout after 15s (${chunkCount} chunks received)`);
        try { ws.close(); } catch(e) {}
        if (chunkCount === 0) reject(new Error('Streaming TTS timeout, no audio'));
        else resolve();
      }
    }, 15000);

    const firstChunkTimeout = setTimeout(() => {
      if (chunkCount === 0 && !resolved) {
        resolved = true;
        console.error('[SARVAM] TTS STREAM: no audio chunk in 5s, falling back to HTTP');
        clearTimeout(timeout);
        try { ws.close(); } catch(e) {}
        reject(new Error('No audio chunks within 5s'));
      }
    }, 5000);

    const sendTextAndFlush = () => {
      ws.send(JSON.stringify({
        type: 'text',
        data: { text }
      }));
      ws.send(JSON.stringify({ type: 'flush' }));
      console.log(`[SARVAM] TTS STREAM text sent (${text.length} chars${warm ? `, prewarmed socket age=${Date.now() - warm.createdAt}ms` : ''}), waiting for audio...`);
    };

    if (warm) {
      // Config was sent by prewarmTTS's own open-handler. If the socket is
      // still dialing, our open-listener runs AFTER prewarm's (attach order),
      // so config always precedes text.
      if (ws.readyState === WebSocket.OPEN) sendTextAndFlush();
      else ws.on('open', sendTextAndFlush);
    } else {
      ws.on('open', () => {
        console.log(`[SARVAM] TTS STREAM connected, sending config (codec=linear16 8kHz, lang=${languageCode}, speaker=${speaker})...`);
        ws.send(_ttsConfigMessage(languageCode, speaker, style));
        sendTextAndFlush();
      });
    }

    ws.on('message', (rawData) => {
      // Drop everything once the stream is aborted — barge-in fired and we
      // do NOT want to forward more audio chunks to Exotel.
      if (aborted) return;
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === 'audio') {
          const audioBase64 = msg.data?.audio || msg.data;
          let pcmBuffer = Buffer.from(audioBase64, 'base64');

          chunkCount++;

          if (chunkCount === 1) {
            // If Sarvam prefixes a WAV header, strip it — Exotel expects
            // raw PCM samples, not a RIFF container.
            if (pcmBuffer.length >= 44 && pcmBuffer.toString('utf8', 0, 4) === 'RIFF') {
              console.log('[SARVAM] TTS STREAM: stripped 44-byte WAV header from first chunk');
              pcmBuffer = pcmBuffer.slice(44);
            }

            clearTimeout(firstChunkTimeout);
            firstChunkTime = Date.now() - ttsStart;
            console.log(`[SARVAM] TTS STREAM first chunk in ${firstChunkTime}ms (${pcmBuffer.length} bytes PCM16)`);
          }

          totalBytes += pcmBuffer.length;
          onAudioChunk(pcmBuffer);

        } else if (msg.type === 'event' && msg.data?.event_type === 'final') {
          const totalTime = Date.now() - ttsStart;
          console.log(`[SARVAM] TTS STREAM ${totalTime}ms total, ${chunkCount} chunks, ${totalBytes} bytes, first=${firstChunkTime}ms (${text.length} chars)`);
          clearTimeout(timeout);
          clearTimeout(firstChunkTimeout);
          if (!resolved) {
            resolved = true;
            try { ws.close(); } catch(e) {}
            if (chunkCount === 0) reject(new Error('Completion received but 0 audio chunks'));
            else resolve();
          }

        } else if (msg.type === 'error') {
          // A vendor error response can echo the input back, and our TTS input
          // is Ritu's reply — which carries the caller's name. Rare path, which
          // is exactly where nobody looks. Keep the diagnosis, drop any echoed
          // text.
          const e = { ...msg };
          for (const k of ['text', 'input', 'transcript', 'inputs']) {
            if (k in e) e[k] = speech(e[k]);
          }
          console.error('[SARVAM] TTS STREAM server error:', JSON.stringify(e));
          clearTimeout(timeout);
          clearTimeout(firstChunkTimeout);
          if (!resolved) {
            resolved = true;
            try { ws.close(); } catch(e) {}
            reject(new Error(`TTS stream server error: ${msg.message || JSON.stringify(msg)}`));
          }
        }
      } catch (e) {
        console.error('[SARVAM] TTS stream parse error:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      clearTimeout(firstChunkTimeout);
      // ws emits 'error' BEFORE 'close' when close() lands on a CONNECTING
      // socket (a barge-in during the handshake). That is our own abort, not a
      // failure: resolve, exactly as the close handler does — otherwise the
      // caller's HTTP fallback speaks the interrupted sentence over the
      // patient (audit 2026-09-18, driven).
      if (aborted) { if (!resolved) { resolved = true; resolve(); } return; }
      console.error('[SARVAM] TTS STREAM WS error:', err.message);
      if (!resolved) { resolved = true; reject(err); }
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(firstChunkTimeout);
      console.log(`[SARVAM] TTS STREAM closed with code ${code}, ${chunkCount} chunks sent${aborted ? ' (aborted)' : ''}`);
      if (!resolved) {
        resolved = true;
        // Aborted close is an expected outcome — resolve so the caller's
        // `await` continues normally instead of throwing.
        if (aborted) resolve();
        else if (chunkCount === 0) reject(new Error(`TTS stream closed (code ${code}), no audio`));
        else resolve();
      }
    });
  });

  // Visible to the caller for the per-call socket census. Set before abort so
  // an aborted utterance still reports how its socket was acquired.
  promise.acquiredWarm = acquiredWarm;
  promise.abort = () => {
    if (aborted) return;
    aborted = true;
    try { if (ws) ws.close(); } catch (e) {}
  };

  return promise;
}

// ─── HTTP TTS FALLBACK (used on stream failure + greeting pre-warm) ──────────
// Returns raw PCM16 @ 8kHz (ready to send directly to Exotel).

async function textToSpeech(text, retryCount = 0, opts = {}) {
  try {
    const ttsStart = Date.now();
    const languageCode = opts.languageCode || detectLanguageCode(text); // pinned-call override; see streamTTS
    const speaker = opts.speaker || config.sarvam.speaker; // per-call voice (locked); see streamTTS

    const response = await axios.post(
      'https://api.sarvam.ai/text-to-speech',
      {
        text,
        target_language_code: languageCode,
        speaker,
        ..._ttsStyleFields(languageCode, { pace: opts.pace, temperature: opts.temperature }),
        speech_sample_rate: 8000,
        enable_preprocessing: false,
        model: 'bulbul:v3'
      },
      {
        headers: {
          'api-subscription-key': config.sarvam.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        httpsAgent
      }
    );

    const apiTime = Date.now() - ttsStart;
    const wavBuffer = Buffer.from(response.data.audios[0], 'base64');
    const { pcmData, sampleRate } = parseWav(wavBuffer);
    const pcm8k = (sampleRate !== 8000) ? resamplePcm16(pcmData, sampleRate, 8000) : pcmData;
    const totalTime = Date.now() - ttsStart;

    console.log(`[SARVAM] TTS HTTP: ${apiTime}ms API + ${totalTime - apiTime}ms convert = ${totalTime}ms (${text.length} chars, ${pcm8k.length} bytes PCM16, lang=${languageCode})`);
    return pcm8k;
  } catch (error) {
    console.error(`[SARVAM] TTS HTTP error (attempt ${retryCount + 1}):`, error.response?.data || error.message);
    if (retryCount < TTS_MAX_RETRIES) {
      return textToSpeech(text, retryCount + 1, opts);
    }
    throw error;
  }
}

// ─── STREAMING STT ──────────────────────────────────────────────────────────
// Input: PCM16 @ 8kHz (direct from Exotel, no mulaw conversion needed).

function createStreamingSTT(onTranscript, onSpeechStart, onSpeechEnd, opts = {}) {
  // Default hi-IN handles Hindi + Hinglish + most English code-switching
  // cleanly on Indian phone lines. opts.languageCode overrides — including
  // 'unknown' for saaras:v3 auto-detect (VALIDATED 2026-07-08 via TTS→STT
  // loopback: kn/pa/hi/mr all detected correctly incl. short confirms; the
  // OLD v2-era "achha"→Tamil misfire does NOT reproduce on v3). The intended
  // flow is: open in 'unknown', then repin() to the detected language after
  // the first substantive utterance so short confirmations stay reliable.
  // ── ENDPOINT KNOB — CORRECTED 2026-07-26 after reading Sarvam's actual spec ──
  // DOC:https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws
  //
  // WHAT WE BELIEVED (and the old comment here asserted): negative_frames_count is
  // N frames of CONTIGUOUS TRAILING silence, so 8 × 64ms ≈ 512ms of quiet ends the
  // turn, and "it changes ONLY the silence-close decision, NOT transcription — so
  // no ghost/accuracy risk".
  //
  // WHAT THE DOCS ACTUALLY SAY: "Number of negative (silence) frames needed WITHIN
  // THE WINDOW to end a speech segment", paired with negative_frames_window
  // (default 24). "One frame is 512 audio samples — 32ms at 16kHz, 64ms at 8kHz."
  // It is an N-of-M rule, not a trailing-silence timer. We were sending count and
  // never the window, so count=8 meant "8 silent frames ANYWHERE inside the last
  // 24 frames (1536ms)" — a window that can still contain a full second of speech.
  // Ordinary hesitant speech satisfies that constantly.
  //
  // AND IT DOES AFFECT TRANSCRIPTION. END_SPEECH finalizes the audio segment, so
  // the decoder never sees what came after. Live 2026-07-26: a caller saying
  // "Dolo 650" was cut mid-number and the two halves decoded independently as
  // "Dolo 600" and "50 और वो". Downstream coalescing cannot repair that — joining
  // the strings gives "Dolo 600 50", never "Dolo 650". The old "no accuracy risk"
  // claim was the most costly wrong belief in this file.
  //
  // THE FIX: send the WINDOW too, close to the count, which makes the rule
  // near-contiguous. Sarvam's own high_vad_sensitivity preset uses count=2 with
  // window=2, so count≈window is intended usage. When a count is configured and no
  // window is, we derive window = count + 2: at most 2 speech frames (128ms) may
  // sit inside the window, so the trigger is ~the trailing silence we always
  // thought we were setting.
  const VAD_NEG_FRAMES = process.env.STT_NEGATIVE_FRAMES_COUNT;
  const VAD_NEG_WINDOW = process.env.STT_NEGATIVE_FRAMES_WINDOW
    || (VAD_NEG_FRAMES ? String(Number(VAD_NEG_FRAMES) + 2) : '');
  let langCode = opts.languageCode || 'hi-IN';
  // ── THE MODEL, AS A KNOB ────────────────────────────────────────────────────
  // Default is saaras:v3 and production sets nothing, so this is a no-op there.
  // It exists because the model was hardcoded here, which meant the ONLY way to
  // A/B saaras:v4 was Sarvam's REST endpoint — and REST has no `mode` parameter
  // at all. So every v4 number we have was measured without mode=codemix, i.e.
  // in a different output SCRIPT (Devanagari vs Latin for English-origin words)
  // than production receives. That is precisely the axis the drug-recall finding
  // turned on. A knob here lets the A/B run down the same socket the caller does.
  // ASSUMED: 'saaras:v4' is accepted by the streaming endpoint — the docs list
  // models for REST; the socket's enum is not documented. The probe below fails
  // loudly rather than silently falling back (same failure `transliterate` had).
  const STT_MODEL = process.env.STT_MODEL || 'saaras:v3';
  const wsUrl = () => [
    'wss://api.sarvam.ai/speech-to-text/ws',
    `?language-code=${encodeURIComponent(langCode)}`,
    `&model=${encodeURIComponent(STT_MODEL)}`,
    // DOC:https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws — mode enum is transcribe | translate | verbatim | translit |
    // codemix. Verified 2026-07-25 when tools/secondPass.js was found sending
    // the non-existent value 'transliterate' and silently falling back.
    `&mode=${encodeURIComponent(config.sarvam.sttMode)}`,
    '&input_audio_codec=pcm_s16le',
    '&sample_rate=8000',
    // DOC:https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws — high_vad_sensitivity is a PRESET that overwrites the fine VAD
    // params; kept false so our explicit values below are the ones that apply.
    '&high_vad_sensitivity=false',
    // DOC:https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws — vad_signals: "Enable VAD signals in response" (START_SPEECH /
    // END_SPEECH), which the whole turn machine depends on.
    '&vad_signals=true',
    // ASSUMED — not in the parameter table we read; behaviour inferred from our
    // own flush() working. Not env-tunable, so a wrong guess cannot be dialled.
    '&flush_signal=true',
    VAD_NEG_FRAMES ? `&negative_frames_count=${encodeURIComponent(VAD_NEG_FRAMES)}` : '',
    VAD_NEG_WINDOW ? `&negative_frames_window=${encodeURIComponent(VAD_NEG_WINDOW)}` : ''
  ].join('');
  if (VAD_NEG_FRAMES) {
    const slackMs = Math.max(0, Number(VAD_NEG_WINDOW) - Number(VAD_NEG_FRAMES)) * 64;
    console.log(`[SARVAM] STT endpoint: ${VAD_NEG_FRAMES} silence frames within a ${VAD_NEG_WINDOW}-frame window ` +
      `(~${Math.round(VAD_NEG_FRAMES * 64)}ms silence, ≤${slackMs}ms speech allowed inside it; stock is 18-of-24)`);
  }
  if (langCode !== 'hi-IN') console.log(`[SARVAM] STT opening with language-code=${langCode}`);

  let ws = null;
  let isOpen = false;
  let audioQueue = [];
  let reconnectAttempts = 0;
  let intentionalClose = false;
  let batchBuffer = Buffer.alloc(0);
  // Socket generation: repin() opens a replacement socket and bumps this so
  // the SUPERSEDED socket's open/close bookkeeping is ignored (its close must
  // not trigger the backoff-reconnect — the replacement is already up).
  let sttGen = 0;

  // Log the full shape of the first STT data message so we can see if
  // Sarvam returns a confidence field (informs the P1 confidence filter).
  let firstDataLogged = false;

  function connect() {
    const myGen = ++sttGen;
    ws = new WebSocket(wsUrl(), {
      headers: { 'api-subscription-key': config.sarvam.apiKey }
    });

    ws.on('open', () => {
      if (myGen !== sttGen) return; // superseded by a repin — ignore
      // mode is logged per socket-connect so every call's transcripts are
      // attributable to an STT mode in the logs (the shadow-comparison hook).
      console.log(`[SARVAM] ${STT_MODEL} STT connected ✓ (mode=${config.sarvam.sttMode}${langCode !== 'hi-IN' ? `, ${langCode}` : ''})`);
      isOpen = true;
      reconnectAttempts = 0;
      for (const pcm of audioQueue) _sendPcm(pcm);
      audioQueue = [];
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'events') {
          if (msg.data?.signal_type === 'START_SPEECH') {
            if (onSpeechStart) onSpeechStart();
          } else if (msg.data?.signal_type === 'END_SPEECH') {
            if (onSpeechEnd) onSpeechEnd();
          }
        } else if (msg.type === 'data') {
          if (!firstDataLogged) {
            firstDataLogged = true;
            // FIELD NAMES AND METRICS ONLY. This line exists to discover the
            // shape of Sarvam's response, and it was dumping the whole object —
            // including the raw transcript, which a live call on 2026-08-05
            // proved by putting a patient's symptom into the platform log
            // stream three hours after the redaction shipped. The shape is what
            // we wanted; the words were never the point.
            const shape = { ...msg.data };
            if ('transcript' in shape) shape.transcript = speech(shape.transcript);
            if ('diarized_transcript' in shape) shape.diarized_transcript = shape.diarized_transcript ? '‹present›' : null;
            console.log('[SARVAM] STT first data msg structure:', JSON.stringify(shape));
          }
          const text = (msg.data?.transcript || '').trim();
          if (text) {
            console.log('[SARVAM] STT result:', speech(text));
            // language_code rides along for the auto-detect pin flow — it is
            // Sarvam's own per-utterance detection (echoes the pinned code on
            // pinned sessions, carries the DETECTED code in 'unknown' mode).
            if (onTranscript) onTranscript(text, {
              languageCode: msg.data?.language_code || null,
              // Sarvam's own confidence + duration — the garble guard's live signal.
              languageProbability: (typeof msg.data?.language_probability === 'number') ? msg.data.language_probability : undefined,
              audioDuration: msg.data?.metrics?.audio_duration,
            });
          }
        }
      } catch (e) {
        console.error('[SARVAM] STT parse error:', e.message);
      }
    });

    ws.on('error', (err) => console.error('[SARVAM] STT WS error:', err.message));

    ws.on('close', (code) => {
      if (myGen !== sttGen) return; // superseded by a repin — replacement already up
      isOpen = false;
      if (!intentionalClose && reconnectAttempts < STT_MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = reconnectAttempts * STT_RECONNECT_BASE_DELAY_MS;
        console.log(`[SARVAM] Reconnecting STT in ${delay}ms (attempt ${reconnectAttempts}/${STT_MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(connect, delay);
      } else if (!intentionalClose) {
        console.error('[SARVAM] STT reconnect attempts exhausted.');
      }
    });
  }

  // RAW PCM, NO HEADER — and this one line was costing us most of the transcript.
  //
  // THE BUG (found 2026-07-27). The connect URL above declares
  // `input_audio_codec=pcm_s16le`, and this function then shipped
  // addWavHeader(pcmBuffer) inside EVERY 100 ms batch. Under pcm_s16le a
  // decoder does not look for a RIFF container — those 44 bytes are simply
  // SAMPLES. Decoded as PCM16 they are 22 samples at RMS 12,957 / peak 28,006
  // against a full scale of 32,767: a near-rail click, injected ten times a
  // second, for the entire call, forever. 2.75% of everything we ever sent
  // Sarvam was a click train we generated ourselves.
  //
  // MEASURED:ritu-evals scratchpad stream-ab — 45 drug-bearing rows / 172 gold
  // mentions, decoded to 8 kHz PCM16 and replayed through the REAL streaming
  // WebSocket at real-time pacing, scored with our own findDrugMention:
  //     header present (this code)   18.1% resolved,  71 chars/row, 2.62 seg/turn, 3 empty
  //     header removed (this fix)    45.8% resolved, 193 chars/row, 1.44 seg/turn, 0 empty
  //     paired McNemar p ≈ 4.6e-23 (both 35, only-prod 4, only-fixed 93)
  // The discriminator that proves the mechanism: keeping the header but sending
  // it 10x less often recovers 14.5% → 47.7%. Damage scales with INJECTION
  // RATE, not chunk size — which is why a bug this size hid for months behind
  // transcripts that still looked like sentences.
  //
  // DOC:https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws
  // — raw PCM is a first-class input codec, and the docs' examples header a
  // FILE, not a chunk. `encoding` is a label the server does not use to pick a
  // container, so it stays 'audio/wav' exactly as Pipecat's Sarvam client sends
  // it alongside header-less PCM. Only the data changed; one variable, which is
  // the same single variable the A/B above isolated.
  //
  // Fragmentation is the second, compounding cost: 2.62 → 1.44 segments per
  // turn means drug names were arriving as short fragments, straight into
  // GHOST_RMS_FLOOR and the backchannel filters. Re-test the VAD
  // negative_frames window AFTER this lands — the "Dolo 650" → "Dolo 600" +
  // "50 और वो" split was blamed entirely on endpointing, and a corrupted
  // stream endpoints early too.
  function _sendPcm(pcmBuffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        audio: { data: pcmBuffer.toString('base64'), encoding: 'audio/wav', sample_rate: 8000 }
      }));
    }
  }

  // Exotel delivers PCM16 chunks directly — no codec conversion needed.
  function sendAudio(pcmChunk) {
    batchBuffer = Buffer.concat([batchBuffer, pcmChunk]);
    if (batchBuffer.length >= STT_BATCH_BYTES) {
      const pcm = batchBuffer;
      batchBuffer = Buffer.alloc(0);
      if (isOpen) _sendPcm(pcm);
      else audioQueue.push(pcm);
    }
  }

  function flush() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'flush' }));
    }
  }

  // Re-pin the session to a specific language (the auto-detect flow: open with
  // 'unknown', then pin once the first substantive utterance reveals the
  // language, so short confirmations transcribe reliably for the rest of the
  // call). Opens the replacement socket FIRST (bumping sttGen so the old
  // socket's close is ignored — no backoff double-reconnect), then closes the
  // old one. Audio arriving during the swap queues via isOpen=false → flushed
  // on the new socket's open. In-flight finals from the old socket still
  // deliver (message handler is not gen-gated) so no transcript is lost.
  function repin(newLangCode) {
    if (!newLangCode || newLangCode === langCode) return;
    const old = ws;
    langCode = newLangCode;
    isOpen = false;
    console.log(`[SARVAM] STT re-pinning session → ${langCode}`);
    connect(); // bumps sttGen — old socket's open/close bookkeeping now ignored
    try { if (old && old.readyState !== WebSocket.CLOSED) old.close(); } catch (_) {}
  }

  function close() {
    intentionalClose = true;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  connect();
  return { sendAudio, flush, close, repin };
}

// ─── STARTUP CODEC LOG ──────────────────────────────────────────────────────
console.log('[SARVAM] Codec config: TTS=linear16 8kHz, STT=pcm_s16le 8kHz (Exotel native PCM16)');

module.exports = { textToSpeech, streamTTS, createStreamingSTT, mulawToPcm16, detectLanguageCode, looksLikeHindi, looksLikeMarathi, pairLanguage, prewarmTTS, discardTTSPrewarm, _ttsConfigMessage };
