require('dotenv').config();

// ─── REQUIRED ENVIRONMENT VARIABLES ───────────────────────────────────────────
// Hard-fail on missing Exotel + core AI/data vars. Meta vars are optional for
// voice-only testing — WhatsApp warnings fire at startup if they're missing.
// GROQ_API_KEY removed from hard-required: at least one of SAMBANOVA_API_KEY
// or GROQ_API_KEY must be set, validated below in validate().
const REQUIRED_VARS = [
  'EXOTEL_SID',
  'EXOTEL_API_KEY',
  'EXOTEL_API_TOKEN',
  'EXOTEL_SUBDOMAIN',
  'SARVAM_API_KEY',
  // GOOGLE_SERVICE_ACCOUNT_JSON and CALENDAR_ID are required only by what uses
  // them — the calendar mirror (ENABLE_GOOGLE_CALENDAR=true) and the Sheet
  // (GOOGLE_SHEET_ID). validate() checks them conditionally below. A clinic that
  // works off the desk alone (Skin Essence) boots with no Google at all.
  'DATABASE_URL'
];

const META_REQUIRED_FOR_WA = [
  'META_PHONE_NUMBER_ID',
  'META_ACCESS_TOKEN',
  'META_WEBHOOK_VERIFY_TOKEN'
];

// Parse SPEAKER_BY_LANG='mr-IN:ritu,hi-IN:suhani' → { 'mr-IN': 'ritu', ... }.
// Returns null when unset/empty so the in-code default map is used instead.
// The reschedule rule, pure: on/off wins; unset follows AGENT_MAY_CANCEL.
function agentMayRescheduleFrom(env) {
  const v = String(env.AGENT_MAY_RESCHEDULE || '').trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return String(env.AGENT_MAY_CANCEL || 'on').trim().toLowerCase() !== 'off';
}

function parseSpeakerMap(raw) {
  if (!raw || !raw.trim()) return null;
  const map = {};
  for (const pair of raw.split(',')) {
    const [lang, speaker] = pair.split(':').map(s => (s || '').trim());
    if (lang && speaker) map[lang] = speaker;
  }
  return Object.keys(map).length ? map : null;
}

// STT output mode for the saaras:v3 streaming socket. 'transcribe' (default —
// current prod behavior, everything in native script) or 'codemix' (keeps
// English/Latin words in Latin inside Indic text — the only mode that preserves
// entities like "Augmentin" as-typed; measured 94% vs 0% Latin-entity survival).
// Any other value falls back to transcribe with a warning.
function parseSttMode(raw) {
  const mode = (raw || 'transcribe').trim().toLowerCase();
  if (mode === 'transcribe' || mode === 'codemix') return mode;
  console.warn(`[CONFIG] STT_MODE='${raw}' is not valid (allowed: transcribe, codemix) — falling back to 'transcribe'`);
  return 'transcribe';
}

// ─── CONFIG OBJECT ────────────────────────────────────────────────────────────
const config = {
  port: process.env.PORT || 3000,

  exotel: {
    sid: process.env.EXOTEL_SID,
    apiKey: process.env.EXOTEL_API_KEY,
    apiToken: process.env.EXOTEL_API_TOKEN,
    subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
    phoneNumber: process.env.EXOTEL_PHONE_NUMBER,
    appId: process.env.EXOTEL_APP_ID,
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY,
    // saaras:v3 streaming STT output mode: 'transcribe' (default) | 'codemix'.
    sttMode: parseSttMode(process.env.STT_MODE),
    // Global default speaker (used for any language not in speakerByLang).
    speaker: process.env.SPEAKER || 'ritu',
    pace: parseFloat(process.env.PACE || '1.2'), // >1 = faster; bumped from 1.05 (Ritu sounded slow)
    // Per-language pace override, e.g. PACE_BY_LANG="kn-IN:1.3,ta-IN:1.25".
    // Native-speaker feedback 2026-07-09: Kannada at the global pace read slow.
    paceByLang: parseSpeakerMap(process.env.PACE_BY_LANG) || {},
    // DOC:https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert —
    // bulbul:v3 `temperature`, 0.01–2.0, default 0.6: "lower values produce
    // more stable and consistent output, higher values sound more expressive
    // but may introduce artifacts". pitch/loudness are NOT supported on v3, so
    // with pace this is the whole tuning surface. Unset → omitted from the
    // request and Sarvam's default applies (no behaviour change until set).
    // TTS_TEMPERATURE=0.5 globally; TTS_TEMPERATURE_BY_LANG="gu-IN:0.45,…" per language.
    temperature: (() => { const v = parseFloat(process.env.TTS_TEMPERATURE || ''); return Number.isFinite(v) ? v : undefined; })(),
    temperatureByLang: parseSpeakerMap(process.env.TTS_TEMPERATURE_BY_LANG) || {},
    sampleRate: parseInt(process.env.SAMPLE_RATE || '22050'),
    // ── Per-language TTS voice ────────────────────────────────────────────────
    // Sarvam's bulbul:v3 has voices that sound markedly better in some languages
    // than others (e.g. "ritu" is strong in Marathi, "suhani" in Hindi). Because
    // every sentence already makes its own Sarvam call AND we already detect the
    // language per sentence (detectLanguageCode), switching the voice is just
    // picking a different `speaker` string per request — zero added latency, no
    // model load. speakerForLang() returns the best voice for a detected
    // language code, falling back to `speaker` above when unmapped.
    // Voice is locked PER CALL (not per sentence) to avoid mid-call voice
    // changes: the default `speaker` above (Suhani) handles Hindi/Hinglish; if
    // Marathi appears anywhere in the call, callHandler switches to the Marathi
    // voice below and stays there for the rest of the call. speakerForLang()
    // resolves the per-language voice; the call-level stickiness lives in
    // callHandler. Extend/override via SPEAKER_BY_LANG='mr-IN:ritu,...'.
    // Both voices are pinned here so the choice does NOT depend on the SPEAKER
    // env var: Hindi/Hinglish calls use Suhani, Marathi calls use Ritu.
    // env override MERGES over the curated defaults — replacing wholesale meant
    // setting one language silently dropped the other 10 recommended voices.
    speakerByLang: { ...{
      // Per-language picks follow Sarvam's recommended-speakers list (verified
      // Jul 2026): suhani is on-list for Hindi/Punjabi/Bengali, ritu for
      // Marathi/Gujarati/Tamil/Odia; NEITHER is recommended for Kannada/Telugu
      // (neha is). Malayalam has no published pick — neha is best-effort.
      // Override any of these via SPEAKER_BY_LANG='kn-IN:ishita,...'.
      'hi-IN': 'suhani', // Hindi/Hinglish (the default voice)
      'mr-IN': 'ritu',   // Marathi calls (Marathi + their Hindi) → Ritu
      'en-IN': 'suhani',
      'pa-IN': 'suhani',
      'bn-IN': 'suhani',
      'gu-IN': 'ritu',
      'ta-IN': 'ritu',
      'od-IN': 'ritu',
      // kn was neha (Sarvam's on-list pick) but real listeners said it sounds
      // synthetic — suhani won the ear test (2026-07-20). Bonus: kn/hi/en now
      // share ONE voice, so mid-call language switches sound like the same
      // person. Revert per-deploy via SPEAKER_BY_LANG='kn-IN:neha' if needed.
      'kn-IN': 'suhani',
      'te-IN': 'neha',
      'ml-IN': 'neha',
    }, ...(parseSpeakerMap(process.env.SPEAKER_BY_LANG) || {}) },
  },

  // The 11 languages Ritu can hold a FULL conversation in — the intersection of
  // saaras:v3 STT (23 langs) and bulbul:v3 TTS (11 langs). STT-only languages
  // (Assamese, Urdu, Nepali, …) are understood via auto-detect but replied to
  // in Hindi. These keys are also the allow-list for the auto-detect pin.
  languageNames: {
    'hi-IN': 'Hindi',
    'mr-IN': 'Marathi',
    'en-IN': 'English',
    'kn-IN': 'Kannada',
    'pa-IN': 'Punjabi',
    'ta-IN': 'Tamil',
    'te-IN': 'Telugu',
    'bn-IN': 'Bengali',
    'gu-IN': 'Gujarati',
    'ml-IN': 'Malayalam',
    'od-IN': 'Odia',
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
  },

  // ── LLM provider abstraction ────────────────────────────────────────────────
  // Architecture lock (rationale in BEHAVIOR_SPEC.md §12):
  //   primary    = groq-scout   Llama 4 Scout — 5× Groq daily TPD, fastest
  //                              latency, best Devanagari-name preservation.
  //   fallback 1 = groq         llama-3.3-70b-versatile — GA-stable, catches
  //                              Scout's intermittent sentinel-miss on the
  //                              sentinel path AND any Scout rate-limit/outage.
  //   fallback 2 = deepinfra    unlimited paid quota — last resort when both
  //                              Groq endpoints are unavailable.
  //
  // NOTE: on the sentinel path Scout silently drops BOOK_APPOINTMENT ~1-in-3
  // on confirm (see test-scout-validation.js). The tool-calling refactor
  // (schema-enforced booking) removes this risk — which is the direction
  // we're committing to. Until tool calling is live, the 70B fallback is the
  // backstop for missed bookings.
  //
  // Chain: groq-scout (fast, free) → groq 70B → gemini. Gemini is the uncapped,
  // India-payable overflow: when Groq's free daily TPD is spent it returns 429
  // and the chain falls through to Gemini, which has no daily cap. deepinfra was
  // dropped from the default (1.7-5.7s live — too slow for voice).
  //
  // Env override:
  //   LLM_FALLBACK_PROVIDERS=groq,gemini      (comma-separated, ordered)
  //   LLM_FALLBACK_PROVIDER=groq              (legacy single — 1-element chain)
  llm: {
    // Lean mode (small-clinic/demo) defaults to gemini — scout's garbage/role-token
    // failure modes are a demo-killer. Read CLINIC_MODE from env directly (the config
    // object isn't built yet here, so this.clinicMode is undefined). If gemini ends up
    // primary without GEMINI_API_KEY, validate() fails LOUD at boot (better than live).
    primaryProvider:   process.env.LLM_PRIMARY_PROVIDER  ||
                       ((process.env.CLINIC_MODE || '').toLowerCase() === 'lean' ? 'gemini' : 'groq-scout'),
    fallbackProvider:  process.env.LLM_FALLBACK_PROVIDER || null,
    fallbackProviders: (process.env.LLM_FALLBACK_PROVIDERS || 'groq,gemini')
      .split(',').map(s => s.trim()).filter(Boolean),
    sambanovaApiKey:   process.env.SAMBANOVA_API_KEY,
    deepinfraApiKey:  process.env.DEEPINFRA_API_KEY,
    // Google Gemini — no daily token cap, India-payable (INR), ~0.7s reply
    // latency on our prompt. Selected via LLM_PRIMARY_PROVIDER=gemini or in the
    // fallback chain. Key works on the OpenAI-compat endpoint (AIza… or AQ.…).
    // Model is gemini-3.1-flash-lite: unlike 2.5-flash-lite it returns a normal
    // spoken reply after a tool result on tool_choice:'auto' (2.5's OpenAI-compat
    // shim returns an EMPTY message there — the live "staying silent" bug).
    geminiApiKey:     process.env.GEMINI_API_KEY,
    geminiModel:      process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    // FP8-quantized Turbo variant is the fast one (~300ms TTFT claim).
    // Override to meta-llama/Llama-3.3-70B-Instruct for the standard FP16.
    deepinfraModel:   process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    // Groq Llama 4 Scout (17B active params, MoE). Groq's free-tier TPD is
    // 500K vs llama-3.3-70b-versatile's 100K — 5× daily capacity. Groq labels
    // Scout as "preview, not for production" — evaluate vs 70B before flipping.
    // Same GROQ_API_KEY; selected via LLM_PRIMARY_PROVIDER=groq-scout.
    groqScoutModel:   process.env.GROQ_SCOUT_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
    // Groq Qwen3 32B. 500K TPD (same as Scout) but 60 RPM (vs Scout's 1K).
    // For our 50-call/day pilot, RPM isn't the bottleneck — TPD is — so
    // Qwen's effective capacity matches Scout. Same GROQ_API_KEY; selected
    // via LLM_PRIMARY_PROVIDER=groq-qwen.
    groqQwenModel:    process.env.GROQ_QWEN_MODEL || 'qwen/qwen3-32b',
    // Groq OpenAI GPT-OSS 120B. 200K TPD on free tier (2× the 70B, 0.4× Scout/Qwen).
    // Same GROQ_API_KEY; selected via LLM_PRIMARY_PROVIDER=groq-gpt-oss.
    groqGptOssModel:  process.env.GROQ_GPT_OSS_MODEL || 'openai/gpt-oss-120b',
    // 8s is the backstop for a whole completion (a long reply can legitimately
    // take a few seconds). It's NOT the failover trigger for the voice path —
    // that's firstChunkTimeoutMs below.
    timeoutMs:        parseInt(process.env.LLM_TIMEOUT_MS || '8000', 10),
    // First-token deadline on the STREAMING path. If a provider doesn't emit its
    // first chunk within this window we treat it as hung and fail over to the
    // next provider immediately — instead of waiting out the full 8s timeout.
    // Healthy first-token is ~0.3–1s, so 2.5s is generous headroom; it only
    // bites a genuine stall. Long replies are unaffected (only the FIRST chunk
    // is timed). Set 0 to disable.
    firstChunkTimeoutMs: parseInt(process.env.LLM_FIRST_CHUNK_TIMEOUT_MS || '2500', 10),
    // Feature flag for the LLM→TTS streaming refactor (feature/llm-streaming
    // branch). Default OFF — when false every code path falls through to the
    // proven non-streaming pipeline. Flip to true only after harness
    // validation passes. See BEHAVIOR_SPEC.md for what must NOT change.
    enableStreaming:  process.env.ENABLE_LLM_STREAMING === 'true',
    // Lean-mode streaming (stream gemini + TTS-on-sentence-1). Default OFF — opt-in
    // per demo deployment to A/B. Booking-confirm turns are pre-routed to the
    // verified non-streaming path, so a "booked" is never spoken before the DB write.
    enableLeanStreaming: process.env.ENABLE_LEAN_STREAMING === 'true',
    // Feature flag for tool-calling (Phase 4). Default OFF — sentinel path
    // stays live. Can only be turned ON after the multi-doctor schema is
    // migrated + seeded on the DB (the tools query clinics/doctors/etc.).
    // See brain-tools.js.
    enableToolCalling: process.env.ENABLE_TOOL_CALLING === 'true',
    // Stream the tool-calling reply to TTS sentence-by-sentence (cuts ~0.5-0.7s
    // of dead air per tool turn). Default OFF — enable only after a live test
    // call confirms booking/confirmation ordering holds. Requires
    // enableToolCalling. See brain-tools.streamResponseToolCalling.
    enableToolStreaming: process.env.ENABLE_TOOL_STREAMING === 'true',
    // Play a short pre-cached "thinking" filler the instant a tool fires, so
    // the patient hears Ritu in ~1s instead of waiting out the silent tool+LLM
    // round. Default OFF — enable after a test call. See callHandler._playFiller.
    enableThinkingFiller: process.env.ENABLE_THINKING_FILLER === 'true',
    // Downward soft-clip limiter on inbound caller audio before STT. Tames loud
    // near-clipping peaks (a contributor to loud-speaker mid-sentence cutoffs)
    // WITHOUT any upward/makeup gain, so it can never pump up noise or touch
    // quiet/normal callers. Default OFF — A/B on staging against real transcripts
    // before trusting it (clipping is often already baked in upstream by the
    // carrier, so the win is unproven). See callHandler.softLimitPcm16.
    enableInputLimiter: process.env.ENABLE_INPUT_LIMITER === 'true',
  },

  // Single-clinic identifier for the tool-calling path (Sai Shradha pilot).
  // Set after running the seed; the tools need a clinic_id in context.
  clinicId: process.env.CLINIC_ID_UUID || null,

  // 'full' (default) = hospital tool-calling path (find_doctor + book_appointment).
  // 'lean' = small-clinic/demo path: preloaded roster, single LLM call, no tools.
  // Pair lean with LLM_PRIMARY_PROVIDER=gemini for a reliable demo-grade model.
  clinicMode: (process.env.CLINIC_MODE || 'full').toLowerCase(),

  // Spoken clinic name in the greeting + lean prompt. Override per deployment
  // (e.g. a dental-clinic demo) via CLINIC_GREETING_NAME; default = the hospital.
  greetingClinicName: process.env.CLINIC_GREETING_NAME || 'साई श्रद्धा हेल्थ केअर सेंटर',
  // Street address spoken on request + appended to the WhatsApp confirmation.
  // UNSET = Ritu explicitly says she doesn't have the address handy — live
  // 2026-07-24 she invented "123 Health Street" because the prompt had
  // nothing; a fabricated address is worse than an honest "I don't know".
  clinicAddress: (process.env.CLINIC_ADDRESS || '').trim(),

  // How long an appointment occupies, in minutes. Used ONLY to decide the last
  // time worth OFFERING — the accept side is unchanged and still books any
  // minute strictly inside the window (tools/utils/availability.js `< end`).
  //
  // WHY THIS EXISTS: doctor_schedules stores a window (17:00–20:00) and the
  // booking check is `minutes >= start && minutes < end`, so 20:00 is NOT
  // bookable. Nothing told the OFFER side that. On 2026-08-13 Ritu said
  // "आज रात 8:00 बजे तक उपलब्ध हैं" about a 17:00–20:00 shift, the caller
  // assented, the model booked 20:00, availability.js correctly refused it, and
  // the canned failure line contradicted Ritu's own claim two turns earlier:
  //   "उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?"
  // The caller heard the clinic change its mind about a time it had just
  // offered. The proposal and the acceptance disagreed about where the window
  // ends, and only one of them was ever right.
  appointmentSlotMinutes: parseInt(process.env.APPOINTMENT_SLOT_MINUTES || '30', 10),

  // MAY RITU CANCEL OR RESCHEDULE AN EXISTING APPOINTMENT?
  // Skin Essence's setup form says no (Q52): staff do it, and Ritu takes the
  // request. Defaults ON so clinics already running keep a feature that works —
  // the same asymmetry the scheduler gates use. AGENT_MAY_CANCEL=off to disable.
  //
  // This does NOT touch the same-call correction (prompt rule 7a): a caller
  // changing the time of a booking Ritu made thirty seconds ago is a different
  // act from reaching into an appointment made last week, and it runs through
  // BOOK_APPOINTMENT's same-day upsert, not the cancel path.
  agentMayCancel: String(process.env.AGENT_MAY_CANCEL || 'on').trim().toLowerCase() !== 'off',
  // MAY RITU MOVE AN EXISTING APPOINTMENT? Split from the cancel switch on
  // 2026-09-15 (clinic-basics module 6): a clinic can let a patient change
  // their own time on a call or on WhatsApp while keeping cancellation for
  // staff. Unset → follows AGENT_MAY_CANCEL, so nothing changes for a clinic
  // that never set it. AGENT_MAY_RESCHEDULE=on|off.
  agentMayReschedule: agentMayRescheduleFrom(process.env),
  // NUMBERS THAT ARE US, NOT PATIENTS. The ten scripted Gujarati test calls
  // would be the first rows on the clinic's desk and would sit in its "why
  // calls didn't book" numbers forever. db.logCallToDb stamps calls.is_test
  // (migration 019) when the caller is in this list; the desk excludes those
  // rows from Insights and marks them in the log. Comma-separated, any format —
  // compared after normalizePhone so "+91 98765 43210" and "9876543210" agree.
  testCallerPhones: String(process.env.TEST_CALLER_PHONES || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // The deterministic pre-visit intake (since when? medicines/allergies? the
  // drug read-back) on BOTH channels, and the model-side version of the same
  // questions in the prompt. Default on (the demo clinic's live behaviour);
  // ENABLE_PREVISIT_INTAKE=off for a booking-only clinic (Skin Essence, D-2026-09-04).
  previsitIntake: String(process.env.ENABLE_PREVISIT_INTAKE || 'on').trim().toLowerCase() !== 'off',

  // Does Ritu announce that the call is recorded? Skin Essence asked for it
  // (Q72); clinics already running never agreed to a disclosure and a greeting
  // is the one line every caller hears, so it is opt-in. Parsed HERE rather than
  // in callHandler because runtimeConfig records it on every call, and a second
  // parse is how those two would drift — the same reason the reminder lead
  // moved into jobFlags.js.
  recordingNotice: String(process.env.RECORDING_NOTICE || '').trim().toLowerCase() === 'on',
  // How many times the boot pre-cache renders the greeting before keeping the
  // briskest take (1 = the old single draw). MEASURED 2026-09-14, see
  // greetingTakes.js: one draw is a tempo lottery (8.8–12.3 s for one line).
  greetingTakes: parseInt(process.env.GREETING_TAKES || '3', 10),

  google: {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    calendarId: process.env.CALENDAR_ID,
    // The clinic works off the DB (Ritu Desk), not Google Calendar. Default OFF:
    // skip the synchronous freebusy+insert on every booking (~2.3s saved) and
    // avoid stale-calendar false "slot taken" rejections. Set ENABLE_GOOGLE_CALENDAR=true
    // to restore the calendar mirror. Tools read process.env directly.
    enabled: process.env.ENABLE_GOOGLE_CALENDAR === 'true',
  },

  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL || '',
  },

  databaseUrl: process.env.DATABASE_URL,

  whatsapp: {
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    accessToken: process.env.META_ACCESS_TOKEN,
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN,
    // Signs inbound webhooks. Distinct from verifyToken, which only guards the
    // one-time GET subscription handshake and proves nothing about a POST.
    appSecret: process.env.META_APP_SECRET,
    businessAccountId: process.env.META_BUSINESS_ACCOUNT_ID,
    apiVersion: process.env.META_API_VERSION || 'v18.0',
    defaultTemplateLanguage: process.env.META_TEMPLATE_LANGUAGE || 'hi',
    templates: {
      confirmation: process.env.META_TEMPLATE_CONFIRM || 'appointment_confirmation',
      reminder:     process.env.META_TEMPLATE_REMIND   || 'appointment_reminder',
      followup:     process.env.META_TEMPLATE_FOLLOWUP || 'appointment_followup',
      no_show:      process.env.META_TEMPLATE_NOSHOW   || 'no_show_recovery',
      missed_call:  process.env.META_TEMPLATE_MISSEDCALL || 'missed_call_recovery',
      // 2026-09-14 clinic-basics program: a doctor's day off tells that day's
      // patients (module 4), and a callback request reaches staff phones (2b).
      // Both are created by `npm run wa:templates` with the five above.
      leave:        process.env.META_TEMPLATE_LEAVE || 'doctor_leave_reschedule',
      staff_alert:  process.env.META_TEMPLATE_STAFF_ALERT || 'staff_callback_alert',
    }
  },

  // Best Sarvam voice for a detected language code; falls back to the global
  // default speaker for any language we haven't mapped. Pure lookup → ~0ms.
  paceForLang(langCode) {
    const v = parseFloat(this.sarvam.paceByLang[langCode]);
    return Number.isFinite(v) ? v : this.sarvam.pace;
  },
  /** bulbul:v3 temperature for a language, or undefined = leave it to Sarvam. */
  temperatureForLang(langCode) {
    const v = parseFloat((this.sarvam.temperatureByLang || {})[langCode]);
    if (Number.isFinite(v)) return v;
    return this.sarvam.temperature;
  },
  speakerForLang(langCode) {
    const map = this.sarvam.speakerByLang || {};
    return map[langCode] || this.sarvam.speaker;
  },

  // Language NAME (as stored in callData.languageDetected, e.g. "Kannada") →
  // ISO code ("kn-IN"). Case-insensitive; unknown → null so callers fall back
  // to their own default. Used to seed the WhatsApp conversation language.
  langCodeForName(name) {
    if (!name) return null;
    const n = String(name).trim().toLowerCase();
    for (const [code, label] of Object.entries(this.languageNames)) {
      if (String(label).toLowerCase() === n) return code;
    }
    return null;
  },

  // ── Startup validation ──────────────────────────────────────────────────────
  validate() {
    const missing = REQUIRED_VARS.filter(v => !process.env[v]);
    if (missing.length > 0) {
      console.error('═══════════════════════════════════════');
      console.error(' MISSING ENVIRONMENT VARIABLES:');
      missing.forEach(v => console.error(`   ✗ ${v}`));
      console.error('═══════════════════════════════════════');
      process.exit(1);
    }

    // ── Google, only where something uses it ──
    const googleNeeds = [];
    if (this.google.enabled) googleNeeds.push(['CALENDAR_ID', 'ENABLE_GOOGLE_CALENDAR=true'], ['GOOGLE_SERVICE_ACCOUNT_JSON', 'ENABLE_GOOGLE_CALENDAR=true']);
    if (process.env.GOOGLE_SHEET_ID) googleNeeds.push(['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID is set']);
    const googleMissing = googleNeeds.filter(([v]) => !process.env[v]);
    if (googleMissing.length) {
      console.error('═══════════════════════════════════════');
      console.error(' MISSING GOOGLE CREDENTIALS for a feature that is ON:');
      googleMissing.forEach(([v, why]) => console.error(`   ✗ ${v} — needed because ${why}`));
      console.error('   Either set it, or turn the feature off (unset ENABLE_GOOGLE_CALENDAR / GOOGLE_SHEET_ID).');
      console.error('═══════════════════════════════════════');
      process.exit(1);
    }
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try { JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
      catch (e) { console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message); process.exit(1); }
    }
    if (!this.google.enabled && !process.env.GOOGLE_SHEET_ID) {
      console.log('[CONFIG] Google: calendar mirror OFF, Sheet OFF — no Google credentials needed; the desk (database) is the calendar');
    }

    const missingMeta = META_REQUIRED_FOR_WA.filter(v => !process.env[v]);
    if (missingMeta.length > 0) {
      console.warn('⚠ Meta WhatsApp Cloud API vars missing — WhatsApp sends will fail:');
      missingMeta.forEach(v => console.warn(`   ⚠ ${v}`));
    }

    if (!process.env.N8N_WEBHOOK_URL) {
      console.warn('⚠ N8N_WEBHOOK_URL not set — CRM logging will be skipped.');
    }
    if (!process.env.EXOTEL_PHONE_NUMBER) {
      console.warn('⚠ EXOTEL_PHONE_NUMBER not set — outbound calls will fail.');
    }

    // ── LLM provider validation ──────────────────────────────────────────────
    // At least one provider must have a key. Then verify the configured
    // primary/fallback have their keys; warn (don't fail) if fallback missing
    // — running without failover is degraded but workable for dev.
    const providerHasKey = {
      sambanova:   !!this.llm.sambanovaApiKey,
      groq:        !!this.groq.apiKey,
      'groq-scout':  !!this.groq.apiKey, // shares the same Groq key
      'groq-qwen':   !!this.groq.apiKey, // shares the same Groq key
      'groq-gpt-oss':!!this.groq.apiKey, // shares the same Groq key
      deepinfra:     !!this.llm.deepinfraApiKey,
      gemini:        !!this.llm.geminiApiKey
    };
    if (!providerHasKey.sambanova && !providerHasKey.groq && !providerHasKey.deepinfra && !providerHasKey.gemini) {
      console.error('═══════════════════════════════════════');
      console.error(' NO LLM PROVIDER KEYS CONFIGURED:');
      console.error('   ✗ SAMBANOVA_API_KEY, GROQ_API_KEY, DEEPINFRA_API_KEY, and GEMINI_API_KEY all missing');
      console.error('   Set at least one to run the voice agent.');
      console.error('═══════════════════════════════════════');
      process.exit(1);
    }

    // Primary must be a known provider with a key.
    const primaryKeyPresent = providerHasKey[this.llm.primaryProvider];
    if (primaryKeyPresent === undefined) {
      console.error(`✗ LLM_PRIMARY_PROVIDER="${this.llm.primaryProvider}" is not a known provider. Supported: sambanova, groq, groq-scout, groq-qwen, groq-gpt-oss, deepinfra, gemini.`);
      process.exit(1);
    }
    if (!primaryKeyPresent) {
      console.error(`✗ LLM_PRIMARY_PROVIDER="${this.llm.primaryProvider}" but its API key is missing.`);
      process.exit(1);
    }
    // Demo foot-gun guard: lean mode on scout risks the '## Step 1:' / role-token garbage.
    if (this.clinicMode === 'lean' && /^groq-scout/.test(this.llm.primaryProvider)) {
      console.warn(`⚠ CLINIC_MODE=lean is running on "${this.llm.primaryProvider}" — scout can emit garbage/role-token leaks. Set LLM_PRIMARY_PROVIDER=gemini for demo-grade reliability.`);
    }

    // Resolve the configured chain (plural list wins; singular is legacy
    // 1-element). Filter to providers whose keys are actually present,
    // dropping unknown names and same-as-primary with a warning.
    const wantedFallbacks = this.llm.fallbackProviders.length
      ? this.llm.fallbackProviders
      : (this.llm.fallbackProvider ? [this.llm.fallbackProvider] : []);

    const effectiveFallbacks = [];
    const seen = new Set([this.llm.primaryProvider]);
    for (const name of wantedFallbacks) {
      if (providerHasKey[name] === undefined) {
        console.warn(`⚠ Fallback "${name}" is not a known provider — skipping.`);
        continue;
      }
      if (seen.has(name)) {
        console.warn(`⚠ Fallback "${name}" duplicates earlier entry in chain — skipping.`);
        continue;
      }
      seen.add(name);
      if (!providerHasKey[name]) {
        console.warn(`⚠ Fallback "${name}" has no API key — skipping.`);
        continue;
      }
      effectiveFallbacks.push(name);
    }
    // Persist the resolved chain so llm/index.js doesn't redo this work.
    this.llm.effectiveFallbacks = effectiveFallbacks;

    if (effectiveFallbacks.length === 0) {
      console.warn(`⚠ No usable fallback providers. Running primary-only — outages won't be caught.`);
    }
    console.log(`[CONFIG] LLM chain: ${this.llm.primaryProvider} → ${effectiveFallbacks.length ? effectiveFallbacks.join(' → ') : 'none'} (timeout=${this.llm.timeoutMs}ms, streaming=${this.llm.enableStreaming ? 'ON' : 'off'}, toolCalling=${this.llm.enableToolCalling ? 'ON' : 'off'})`);
    // ─── EMERGENCY ESCALATION, STATED AT BOOT ────────────────────────────────
    // The single highest-consequence setting in this system, and until now the
    // only way to know its value was to read the Railway dashboard. v1 — live —
    // catches 62 of 96 red-flag utterances, missing 11 of 12 self-harm and 10 of
    // 12 stroke. v2 catches 96 but over-triggers on bleeding and cardiac, so
    // enforcement is per-category.
    //
    // A safety switch you cannot confirm from the logs is a safety switch you do
    // not know the state of. This project has already spent a day discovering
    // guards that were never reached.
    const v2All = process.env.EMERGENCY_V2 === 'on';
    const v2Cats = String(process.env.EMERGENCY_V2_ENFORCE || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (v2All) {
      console.warn('[CONFIG] emergency v2: ENFORCING ALL CATEGORIES — the repo\'s own FP hunt says BLOCK for this; bleeding/cardiac over-trigger');
    } else if (v2Cats.length) {
      console.log(`[CONFIG] emergency v2: enforcing [${v2Cats.join(', ')}] — other categories stay on v1 (shadow only)`);
    } else {
      console.warn('[CONFIG] emergency v2: OFF — v1 only, which misses 34 of 96 red flags (11/12 self-harm, 10/12 stroke). Set EMERGENCY_V2_ENFORCE=selfharm,stroke,poisoning');
    }

    const breakerOn = process.env.ENABLE_LLM_CIRCUIT_BREAKER !== 'false';
    console.log(`[CONFIG] LLM circuit breaker: ${breakerOn ? `ON (skip a provider for ~${Math.round(parseInt(process.env.LLM_BREAKER_COOLDOWN_MS || '300000', 10) / 1000)}s after a 429)` : 'off'}`);
    const probeOn = process.env.ENABLE_LLM_HEALTH_PROBE !== 'false';
    console.log(`[CONFIG] LLM health-probe: ${probeOn ? `ON (re-check capped providers off the call path every ~${Math.round(parseInt(process.env.LLM_PROBE_INTERVAL_MS || '60000', 10) / 1000)}s)` : 'off'}; first-chunk failover at ${this.llm.firstChunkTimeoutMs}ms`);
    console.log(`[CONFIG] TTS voice: ${this.speakerForLang('hi-IN')} for Hindi/Hinglish; locks to ${this.speakerForLang('mr-IN')} for the whole call once Marathi appears (no mid-call switching)`);
    console.log(`[CONFIG] Google Calendar: ${this.google.enabled ? 'ON (synchronous freebusy+insert per booking)' : 'OFF — DB is source of truth, ~2.3s/booking saved'}`);
    if (this.llm.enableToolCalling && !this.clinicId) {
      console.warn('⚠ ENABLE_TOOL_CALLING=true but CLINIC_ID_UUID is not set — tool calls have no clinic context. Set CLINIC_ID_UUID after seeding.');
    }

    // The flags that decide what a call DOES, printed at boot so the question
    // "what is production running?" is answerable in seconds rather than by
    // reading source. Three investigations stalled on that question today.
    for (const line of require('./runtimeConfig').describeRuntimeConfig()) console.log(line);
    console.log(`[CONFIG] TEST_MODE=${process.env.TEST_MODE === 'true' ? 'ON (WhatsApp sends will be skipped)' : 'OFF'}`);
    console.log('✓ Config validated successfully');
  }
};

module.exports = config;
module.exports._agentMayRescheduleFrom = agentMayRescheduleFrom;
