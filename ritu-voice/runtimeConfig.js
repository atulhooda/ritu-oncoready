// ═══════════════════════════════════════════════════════════════════════════
// THE EFFECTIVE RUNTIME CONFIGURATION — what this call actually ran with.
//
// WHY THIS EXISTS. Three separate investigations on 2026-08-06/07 stopped at
// the same wall: nobody could say what production was configured to do.
//
//   · ENABLE_ROSTER_SLICE — a real abandoned call had Ritu recite 24 doctor
//     names. The fix already existed and was flag-gated off. Finding that out
//     took reading source, because no call recorded it.
//   · ENABLE_SPECULATIVE_LLM / ENABLE_TTS_PREWARM / ENABLE_SHORT_HOLD — three
//     built latency features, all defaulting OFF. The LLM leg is ~548ms of a
//     ~1.1s turn, and whether speculation was masking any of it was unknowable,
//     which makes every latency number quoted so far uninterpretable.
//   · GARBLE_GUARD — a caller was told "I can't hear you" and then, one turn
//     later, "your voice is perfectly clear". Whether the first line came from
//     the deterministic guard or the model improvising is still unresolved,
//     because the flag's production value is not recorded anywhere.
//
// The eval harness already learned this lesson and wrote it in its own header:
// it once ran pinned/transcribe/slice-off against a production that was
// auto-detect/codemix/slice-on, and reported a knob as "production's biggest
// untapped lever" on the strength of it being ABSENT FROM A FILE PRODUCTION
// DOES NOT READ. A local .env is not production. A flag set in a dashboard is
// a claim about production. Only the call can say what the call did.
//
// ONE SOURCE, TWO CONSUMERS: the boot log (so it is answerable in seconds from
// Railway) and per-call diagnostics (so it is answerable months later from the
// database, for a call nobody was watching). They cannot drift, because they
// read the same function.
//
// Values only — never secrets. This is written to a database and printed to a
// log aggregator; an API key must never reach either.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// The scheduled-job gates. Not re-derived here: scheduler.js gates on the same
// function, so recording a value this file computed independently would be the
// drift this file exists to prevent.
const { jobStates, reminderLeadMinutes } = require('./jobFlags');

const on = (v) => v === 'true';

/**
 * The flags that change what a call DOES. Not every env var — the ones whose
 * value you would need to know to interpret a transcript or a latency number.
 */
function runtimeConfig() {
  const e = process.env;
  return {
    // ── latency: each of these can move dead air, and all three default OFF ──
    speculativeLlm: on(e.ENABLE_SPECULATIVE_LLM),
    ttsPrewarm: on(e.ENABLE_TTS_PREWARM),
    shortHold: on(e.ENABLE_SHORT_HOLD),
    softHold: on(e.ENABLE_SOFT_HOLD),
    leanStreaming: on(e.ENABLE_LEAN_STREAMING),
    llmStreaming: on(e.ENABLE_LLM_STREAMING),
    toolStreaming: on(e.ENABLE_TOOL_STREAMING),
    fastEndpoint: on(e.ENABLE_FAST_ENDPOINT),
    thinkingFiller: on(e.ENABLE_THINKING_FILLER),
    terminalFastpath: on(e.ENABLE_TERMINAL_FASTPATH),

    // ── what she says and how she chooses ──────────────────────────────────
    rosterSlice: on(e.ENABLE_ROSTER_SLICE),
    multilingual: on(e.ENABLE_MULTILINGUAL),
    // GARBLE_GUARD is the odd one out: 'on', not 'true'. Recording the RESOLVED
    // boolean rather than the raw string is the point — a call that reads
    // GARBLE_GUARD=true would be silently OFF, and the diagnostic must show
    // what the code concluded, not what someone typed.
    garbleGuard: e.GARBLE_GUARD === 'on',
    reportIntake: on(e.ENABLE_REPORT_INTAKE),
    // Whether inbound WhatsApp is authenticated at all. Recorded because
    // "we verify signatures" must be checkable, not assumed.
    waSignature: !!e.META_APP_SECRET,
    // Same rule for the VOICE door. index.js gates the /media-stream upgrade on
    // MEDIA_STREAM_SECRET, but only when it is set — unset means the hard gate
    // is simply absent and the only thing standing between a stranger and a
    // live call is the account_sid check inside the `start` event. That check
    // is real and fails closed, but account_sid is not a secret in the way a
    // secret is, and nothing in the boot log said which of the two was in
    // force. A clinic being onboarded gets a WSS URL; whether that URL is
    // guarded should not require reading index.js to find out.
    //
    // Named wsGate, not wsSecret: this is a BOOLEAN about whether the door is
    // locked, and tests/test-runtime-config.js rejects any field whose NAME
    // looks like it could hold a credential. That guard is right — this object
    // is written to the calls table and shipped to a log aggregator.
    wsGate: !!e.MEDIA_STREAM_SECRET,
    inputLimiter: on(e.ENABLE_INPUT_LIMITER),
    toolCalling: on(e.ENABLE_TOOL_CALLING),

    // ── the speech and safety planes ───────────────────────────────────────
    // Decides WHICH BRAIN runs, and therefore whether a booking persists at
    // all. Defaults to 'full', which writes no appointments row.
    clinicMode: (e.CLINIC_MODE || 'full').toLowerCase(),
    sttMode: e.STT_MODE || null,
    emergencyV2: e.EMERGENCY_V2_ENFORCE || null,
    llmPrimary: e.LLM_PRIMARY_PROVIDER || null,
    // WHICH MODEL, not just which vendor. llmPrimary says "gemini" whether the
    // call ran gemini-3.1-flash-lite or gemini-3.5-flash-lite — so a model
    // canary produced calls that were INDISTINGUISHABLE from the control in the
    // database, and any A/B on them was uninterpretable.
    //
    // Found while switching models: the advice "llmPrimary is recorded, so the
    // arms are separable" was wrong. This file's own header says a flag set in a
    // dashboard is a claim about production and only the call can say what the
    // call did — that applies to the model as much as to the provider.
    //
    // Defaults are mirrored from config.js, so an unset env still records the
    // model that actually ran rather than null.
    llmModel: e.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    groqModel: e.GROQ_MODEL || null,
    forceLang: e.FORCE_LANG || null,
    greetingLang: e.GREETING_LANG || null,

    // ── which cron jobs were armed for this call's clinic ──────────────────
    // The no-show job marked 52 of 59 demo appointments no_show and messaged
    // the patients, because appointments.confirmed has no production writer.
    // Whether it was armed is now a recorded fact about the call, not a claim
    // about a dashboard — the same reason every flag above is here.
    jobs: jobStates(),
    // How far ahead a reminder goes out. Was a hardcoded 23–25 hour window; a
    // clinic asking for two hours' notice and silently getting 24 is the kind
    // of thing only the call record can settle.
    reminderLeadMin: reminderLeadMinutes(),

    // ── the two knobs that change what a caller HEARS ─────────────────────
    // Lazily required: config.js reaches back into this module to print the
    // boot line, so a top-level require here would be a load-order question
    // nobody should have to think about. require() is cached; this costs
    // nothing after the first call.
    //
    // Neither is re-derived from env. A clinic that reserved cancellation for
    // its staff, or that announces recording, is a fact about the call, and a
    // second parse of the same variable is how a recorded value stops matching
    // the one the code acted on.
    agentMayCancel: require('./config').agentMayCancel,
    previsitIntake: require('./config').previsitIntake,
    googleCalendar: require('./config').google.enabled,
    sheet: !!e.GOOGLE_SHEET_ID,
    recordingNotice: require('./config').recordingNotice,
  };
}

/** One line per group, for the boot log. Never printed per call. */
function describeRuntimeConfig() {
  const c = runtimeConfig();
  const flags = (keys) => keys.map((k) => `${k}=${c[k] ? 'ON' : 'off'}`).join(' ');
  return [
    `[CONFIG] latency: ${flags(['speculativeLlm', 'ttsPrewarm', 'shortHold', 'softHold', 'leanStreaming', 'llmStreaming', 'toolStreaming', 'fastEndpoint', 'thinkingFiller', 'terminalFastpath'])}`,
    `[CONFIG] behaviour: ${flags(['rosterSlice', 'multilingual', 'garbleGuard', 'reportIntake', 'previsitIntake', 'googleCalendar', 'sheet', 'inputLimiter', 'toolCalling', 'waSignature', 'wsGate'])}`,
    `[CONFIG] jobs: ${Object.entries(c.jobs).map(([k, v]) => `${k}=${v ? 'ON' : 'off'}`).join(' ')} reminderLeadMin=${c.reminderLeadMin} agentMayCancel=${c.agentMayCancel ? 'ON' : 'off'} recordingNotice=${c.recordingNotice ? 'ON' : 'off'}`,
    `[CONFIG] planes: clinicMode=${c.clinicMode} sttMode=${c.sttMode || 'unset'} emergencyV2=${c.emergencyV2 || 'unset'} llmPrimary=${c.llmPrimary || 'unset'} llmModel=${c.llmModel} groqModel=${c.groqModel || 'unset'} forceLang=${c.forceLang || 'unset'} greetingLang=${c.greetingLang || 'unset'}`,
  ];
}

module.exports = { runtimeConfig, describeRuntimeConfig };
