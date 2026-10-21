// ─── THE TEST PROCESS MUST BE THE PRODUCTION PROCESS ────────────────────────
// Every test in this directory has, until now, run a machine that production
// does not run. Not by a little: by the whole brain.
//
//   CLINIC_MODE unset -> 'full'. Production is 'lean'. That single default
//   sends processIntent down a different path (callHandler.js:2401), and
//   _maybeHistoryQuestion (callHandler.js:3374) returns null on its FIRST line
//   outside lean — so the entire pre-visit history machine is absent. The first
//   version of tests/test-history-denial.js hit exactly this and reported a
//   LIVE, still-broken defect as already fixed. Its line 28-32 comment is the
//   scar tissue.
//
//   READBACK unset -> 'off' (callHandler.js:65). Production is 'on', with a
//   patient_medications row written 2026-08-08 to prove it. With 'off' nothing
//   is ever queued, _readbackPending is never set, and every assertion about it
//   passes VACUOUSLY. Commit 241c2e6's body records this in the first person:
//   "MY FIRST TEST RUN REPORTED THIS ALREADY FIXED."
//
//   STT_MODE unset -> 'transcribe'. Production is 'codemix'. Different
//   ALPHABET: codemix leaves "Augmentin" in Latin inside Devanagari, transcribe
//   returns everything in Devanagari. A drug-matcher test on the default is
//   feeding the matcher a script production never sends it.
//
//   ENABLE_ROSTER_SLICE, ENABLE_SPECULATIVE_LLM, ENABLE_TTS_PREWARM,
//   ENABLE_SHORT_HOLD, ENABLE_MULTILINGUAL, ENABLE_LEAN_STREAMING — all
//   default OFF, all ON in production (boot log 2026-07-30). Every latency
//   number this repo has ever quoted from a bare `node tests/foo.js` describes
//   a different system.
//
// This is the same mistake the eval harness already made and wrote up in
// runtimeConfig.js's header: it ran pinned/transcribe/slice-off against a
// production that was auto-detect/codemix/slice-on and reported a knob as
// "production's biggest untapped lever" on the strength of it being ABSENT
// FROM A FILE PRODUCTION DOES NOT READ. A local .env is not production.
//
// So: one file, required first, that makes `node tests/anything.js` run the
// switches production runs — and refuses to be quiet when it cannot.
//
// ─── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────
// It is NOT a second copy of config.js. It holds no defaults. It holds the
// PRODUCTION VALUE of switches whose production value is not in the repo (it
// lives in a Railway dashboard), each with the evidence that established it,
// and then it hands the resolving back to the code: every pin is read back
// through require('../config') and require('../runtimeConfig') — the same
// modules index.js loads — and a pin that does not survive that round trip is
// a hard failure. If config.js changes how a flag resolves, this file finds
// out from config.js, not from a duplicate rule kept in step by hope.
//
// ─── WHY MEASUREMENT, NOT ASSERTION, DECIDED THE ENFORCEMENT ────────────────
// The obvious design is to lock the pinned variables so a stray assignment
// throws. It cannot be done on this runtime. Measured on node v20.20.0:
//
//   Object.defineProperty(process.env, 'X', { get, set })
//     -> TypeError: 'process.env' does not accept an accessor(getter/setter)
//        descriptor                            [ERR_INVALID_OBJECT_DEFINE_PROPERTY]
//   Object.defineProperty(process.env, 'X', { value, writable: false })
//     -> TypeError: 'process.env' only accepts a configurable, writable, and
//        enumerable data descriptor             [ERR_INVALID_OBJECT_DEFINE_PROPERTY]
//
// process.env cannot be made read-only, so the enforcement is placed where the
// value is actually CONSUMED instead: a Module._load hook re-checks every pin
// at the moment any production file is required (which is when a module-level
// `const X = process.env.Y` freezes), and a process 'exit' hook catches drift
// that happened after the last require. Also measured: an 'exit' handler can
// still set process.exitCode, and it wins even over an explicit process.exit(0)
// (verified: handler set 75, shell saw 75). That is what makes a silent green
// impossible to keep silent.
//
// ─── FOUR PINS ARE DELIBERATELY *NOT* PRODUCTION ────────────────────────────
// See SAFETY below. TEST_MODE and DATABASE_URL are set to values production
// does not use, because production's values mean "send a real WhatsApp message
// on the live Meta credentials" and "write to the Railway Postgres". db.js runs
// initDb() at require time (db.js:34) and issues a real `SELECT 1` against
// whatever DATABASE_URL says — so merely requiring db.js from a test has been
// opening a connection to a live database. Those two are fidelity we trade for
// not being the reason the desk goes down again.
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const TESTS = __dirname;

// Production's own first line (index.js:1, config.js:1). Load it HERE, before
// the pins, so the pins are applied ON TOP of the local .env rather than under
// it: dotenv does not overwrite a variable that already exists (measured,
// dotenv 17.4.2 — a preset value survived a .env that set the same key). If the
// pins went first, the .env would be inert and this file would look right; if
// dotenv went first and the pins never ran, the .env would win. Order is the
// whole mechanism.
try { require('dotenv').config({ quiet: true }); } catch (_) { /* no .env is fine */ }

// ═══════════════════════════════════════════════════════════════════════════
// THE PRODUCTION SWITCHES
//
// value:    the string production sets, or null meaning "production does not
//           set this" — in which case the variable is DELETED, because a local
//           .env that sets it is itself a divergence.
// evidence: how the production value was established. "boot log 2026-07-30"
//           is the captured Railway boot of the live deploy. Anything without
//           evidence belongs in UNKNOWN_IN_PRODUCTION below, not here.
// changes:  what a test silently runs instead when this is left at its default.
// reads:    the production code path that RESOLVES this value, evaluated after
//           the pins land. This is the anti-duplication clause: the assertion
//           is against config.js / runtimeConfig.js, never against a rule
//           re-typed here. Omitted where the resolved value is a module-level
//           const that is never exported (READBACK, the STT frame counts) —
//           those are pinned as raw strings and that limit is stated in
//           CANNOT-CATCH rather than papered over.
// ═══════════════════════════════════════════════════════════════════════════
const PRODUCTION = {
  // ── which brain runs at all ──────────────────────────────────────────────
  CLINIC_MODE: {
    value: 'lean',
    evidence: 'boot log 2026-07-30: "✓ Lean mode ON"',
    changes: 'full mode routes to the tool-calling brain, writes NO appointments row (index.js:356), and kills _maybeHistoryQuestion outright',
    reads: (c) => c.config.clinicMode === 'lean' && c.rc.clinicMode === 'lean',
  },
  CLINIC_ID_UUID: {
    // The real UUID is a production secret-by-obscurity and is not readable
    // from here. Its PRESENCE is what changes behaviour — roster preload
    // scoping (index.js:347) and every tools/* query — so presence is what is
    // pinned, with a fixed, obviously-synthetic value so failures are legible.
    // NOTE: bare CLINIC_ID is read by NOTHING in production. The only
    // process.env.CLINIC_ID in the repo is tests/test-phone-identity.js:39,
    // i.e. a test configuring a variable no shipped line reads.
    value: '00000000-0000-4000-8000-00000000c11c',
    evidence: 'CONFIRMED-BY-ABSENCE — boot log 2026-07-30 shows toolCalling=ON without config.js:444\'s "CLINIC_ID_UUID is not set" warning',
    changes: 'clinicId=null makes every clinic-scoped query match nothing, silently',
    reads: (c) => !!c.config.clinicId,
  },
  READBACK: {
    value: 'on',
    evidence: 'commit 241c2e6 body + a live patient_medications row (unverified | dentist) written 2026-08-08',
    changes: "off means _readbackPending is NEVER set — every read-back assertion passes on an empty branch",
    // callHandler.js:65 freezes READBACK_MODE into a module-level const that is
    // not exported. Raw-string pin only; see CANNOT-CATCH.
  },

  // ── what the recogniser sends the rest of the system ─────────────────────
  STT_MODE: {
    value: 'codemix',
    evidence: 'boot log 2026-07-30: "[SARVAM] saaras:v3 STT connected ✓ (mode=codemix, unknown)"',
    changes: 'transcribe returns EVERYTHING in Devanagari — a different alphabet reaching the drug matcher than production sends it',
    reads: (c) => c.config.sarvam.sttMode === 'codemix' && c.rc.sttMode === 'codemix',
  },
  ENABLE_MULTILINGUAL: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "[SARVAM] STT opening with language-code=unknown" (auto-detect)',
    changes: 'off pins hi-IN from the first byte — a monolingual system, and language-flip tests then assert on a branch that cannot fire',
    reads: (c) => c.rc.multilingual === true,
  },
  STT_NEGATIVE_FRAMES_COUNT: {
    value: '10',
    evidence: 'boot log 2026-07-30: "10 silence frames within a 14-frame window (~640ms silence); stock is 18-of-24"',
    changes: 'unset omits the parameter from the socket URL entirely and Sarvam\'s stock 18-of-24 applies — a materially slower endpointing rule, and the exact knob a past eval called "production\'s biggest untapped lever" purely because it was missing from a local .env',
  },
  STT_NEGATIVE_FRAMES_WINDOW: {
    value: '14',
    evidence: 'same boot line — the window half of the same rule',
    changes: 'count without window is an N-of-anywhere rule: the failure that cut "Dolo 650" into "Dolo 600" + "50 और वो"',
  },

  // ── what she says, and how long it takes ─────────────────────────────────
  ENABLE_ROSTER_SLICE: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "[LEAN] Roster slice: Neurology+Gastroenterology → 2/25 doctors in detail"',
    changes: 'off puts all 25 doctors in the prompt — the 24-name recitation that lost a real call',
    reads: (c) => c.rc.rosterSlice === true,
  },
  ENABLE_SPECULATIVE_LLM: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "Speculation committed: 902ms head start, 2 sentence(s) buffered"',
    changes: 'off removes the whole cancel/commit state machine (callHandler.js:2040+) and changes turn timing — any latency number measured without it describes a different system',
    reads: (c) => c.rc.speculativeLlm === true,
  },
  ENABLE_LEAN_STREAMING: {
    value: 'true',
    evidence: 'INFERRED, high confidence — callHandler.js:2045 returns early unless lean && enableLeanStreaming, and the production log is full of "Speculative LLM started" lines that are unreachable otherwise',
    changes: 'off takes the non-streaming lean path: TTS waits for the whole completion',
    reads: (c) => c.rc.leanStreaming === true,
  },
  ENABLE_LLM_STREAMING: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "streaming=ON"',
    changes: 'the code DEFAULT is false — this matched production only by accident of a line in the local .env. Move the .env and every streaming test silently flips pipeline',
    reads: (c) => c.rc.llmStreaming === true,
  },
  ENABLE_TTS_PREWARM: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "TTS STREAM text sent (62 chars, prewarmed socket age=2061ms)"',
    changes: 'off skips the pre-opened Sarvam socket and never exercises the "WebSocket was closed before the connection was established" path that the same log shows happening',
    reads: (c) => c.rc.ttsPrewarm === true,
  },
  ENABLE_SHORT_HOLD: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "Short-burst hold (900ms) — loud short turn (peak 11929)"',
    changes: 'off dispatches the fragment immediately — a different turn-segmentation regime, so the brain and the matcher see different sentences',
    reads: (c) => c.rc.shortHold === true,
  },
  ENABLE_TOOL_CALLING: {
    value: 'true',
    evidence: 'boot log 2026-07-30: "toolCalling=ON"',
    changes: 'INERT on the voice path in production (callHandler.js:2407 needs !useLean and production is lean) but it still gates config.js:443\'s CLINIC_ID_UUID check and is live for any non-lean deploy',
    reads: (c) => c.rc.toolCalling === true,
  },
  LLM_PRIMARY_PROVIDER: {
    value: 'gemini',
    evidence: 'boot log 2026-07-30: "LLM chain: gemini → groq"',
    changes: 'the code default is CLINIC_MODE-dependent (config.js:167): without lean it is groq-scout, which this repo documents as dropping BOOK_APPOINTMENT ~1-in-3 on the sentinel path',
    reads: (c) => c.config.llm.primaryProvider === 'gemini' && c.rc.llmPrimary === 'gemini',
  },
  LLM_FALLBACK_PROVIDERS: {
    value: 'groq,gemini',
    evidence: 'boot log 2026-07-30 resolved the chain to "gemini → groq" with only the duplicate-entry warning and NO "deepinfra has no API key" warning',
    changes: 'the local .env adds a third hop (deepinfra, measured 1.7-5.7s) that production does not have',
    reads: (c) => c.config.llm.fallbackProviders.join(',') === 'groq,gemini',
  },
  CLINIC_GREETING_NAME: {
    // Production sets this per clinic ("स्माईल मल्टीस्पेशालिटी क्लिनिक" on the
    // captured deploy) while running the Sai Shradha roster, so the greeting
    // NAME and the roster are independent. The pin is a SYNTHETIC name on
    // purpose: any test that hard-codes config.js's built-in default is
    // asserting on a string production overrides, and should fail loudly and
    // then read config.greetingClinicName instead of typing it out. Same rule
    // tests/test-history-denial.js:44 already applies to the duration question
    // — derive it from the code, never guess at it.
    value: 'बूटस्ट्रैप टेस्ट क्लिनिक',
    evidence: 'live transcript in boot log 2026-07-30: "नमस्कार सिद्धार्थ जी! मी ऋतू, स्माईल मल्टीस्पेशालिटी क्लिनिक मधून"',
    changes: 'unset falls back to "साई श्रद्धा हेल्थ केअर सेंटर", a greeting the captured deploy never speaks',
    reads: (c) => c.config.greetingClinicName === 'बूटस्ट्रैप टेस्ट क्लिनिक',
  },

  // ── production does NOT set these; a local .env might ─────────────────────
  // null = delete. ENABLE_SOFT_HOLD / ENABLE_FAST_ENDPOINT /
  // ENABLE_TERMINAL_FASTPATH are the subtle ones: their readers use
  // `!== 'false'`, so UNSET means ON. Pinning them to 'true' would give the
  // same behaviour today but would hide the day someone changes a reader to
  // `=== 'true'` — under 'true' both spellings read ON, under unset they
  // disagree. Absent is both truer to production and the more sensitive test.
  ENABLE_SOFT_HOLD: {
    value: null,
    evidence: 'unset in production; boot log 2026-07-30 shows it ACTIVE anyway ("Soft-speaker hold (900ms) — quiet turn (peak 762)") because callHandler.js:396 reads !== \'false\'',
    changes: 'setting it to anything makes the default-ON reader untestable',
  },
  ENABLE_FAST_ENDPOINT: {
    value: null,
    evidence: 'unset in production; boot log 2026-07-30: "Fast endpoint (150ms, +155ms after END_SPEECH)" — active via the same !== \'false\' default',
    changes: 'as above',
  },
  ENABLE_TERMINAL_FASTPATH: {
    value: null,
    evidence: 'unset in production; default-ON at callHandler.js:589 via !== \'false\'',
    changes: 'as above',
  },
  FORCE_LANG: {
    value: null,
    evidence: 'boot log 2026-07-30 shows language-code=unknown, which FORCE_LANG would have overridden',
    changes: 'set, it overrides detection and every multilingual assertion becomes a tautology',
  },
  N8N_WEBHOOK_URL: {
    value: null,
    evidence: 'boot log 2026-07-30: "⚠ N8N_WEBHOOK_URL not set — CRM logging will be skipped"',
    changes: 'set, crm.js posts to a real webhook from a test run',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// DELIBERATELY NOT PRODUCTION.
// Each of these is a fidelity loss taken on purpose, because production's own
// value means "spend money" or "write to the live database". They are listed
// separately from PRODUCTION so nobody can mistake one for the other, and each
// appears again in the CANNOT-CATCH section.
// ═══════════════════════════════════════════════════════════════════════════
// Two switches the Skin Essence profile flips; pinned here at the demo's live
// value so a test can unpin them under EITHER profile.
PRODUCTION.ENABLE_PREVISIT_INTAKE = { value: 'on', evidence: 'code default (config.js previsitIntake) — the demo asks the pre-visit questions on every symptom call', changes: 'off: no duration/meds questions on voice or WhatsApp; the prompt tells the model not to ask', reads: (c) => c.config.previsitIntake === true && c.rc.previsitIntake === true };
PRODUCTION.AGENT_MAY_CANCEL = { value: 'on', evidence: 'code default (config.js:283) — the demo lets the agent cancel/reschedule', changes: 'off: the cancel/update sentinels are suppressed and staff handle changes', reads: (c) => c.config.agentMayCancel === true && c.rc.agentMayCancel === true };
PRODUCTION.APPOINTMENT_SLOT_MINUTES = { value: '30', evidence: 'code default (config.js:272) — the demo roster is on a 30-minute grid', changes: 'the slot grid every offer and every taken-slot check is built on', reads: (c) => c.config.appointmentSlotMinutes === 30 };

// ─── PROFILES: THE DEMO CLINIC IS NOT THE ONLY PRODUCTION ──────────────────
// Skin Essence (Ahmedabad, cutover Sept 2026) runs the SAME code with a
// different switch set — docs/SKIN_ESSENCE_SPEC.md "Env (voice)" plus the
// founder's 2026-09-04 decisions (no pre-visit questions, no report intake,
// WhatsApp inbound on). tools/run-tests.js runs the whole suite under every
// profile; BOOTSTRAP_PROFILE selects one. Each entry overrides PRODUCTION and
// is read back through config.js/runtimeConfig.js like every other pin.
const PROFILE = String(process.env.BOOTSTRAP_PROFILE || 'demo').trim();
const PROFILES = {
  demo: {},
  'skin-essence': {
    GREETING_LANG:          { value: 'gu-IN', evidence: 'SPEC D3 — greeting opens in Gujarati', changes: 'greeting, returning greeting and recording notice render Gujarati', reads: (c) => c.rc.greetingLang === 'gu-IN' },
    CLINIC_GREETING_NAME:   { value: 'સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટર', evidence: 'SPEC env block', changes: 'the clinic name in the greeting', reads: (c) => c.config.greetingClinicName === 'સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટર' },
    AGENT_MAY_CANCEL:       { value: 'off', evidence: 'SPEC D4 — changes are staff-only', changes: 'cancel/update sentinels suppressed, cancelPolicy spoken, rule 7 branches', reads: (c) => c.config.agentMayCancel === false && c.rc.agentMayCancel === false },
    ENABLE_PREVISIT_INTAKE: { value: 'off', evidence: 'founder decision 2026-09-04 — booking only', changes: 'no duration/meds questions on voice or WhatsApp; the prompt tells the model not to ask', reads: (c) => c.config.previsitIntake === false && c.rc.previsitIntake === false },
    ENABLE_REPORT_INTAKE:   { value: null, evidence: 'founder decision 2026-09-04 — no report taking', changes: 'reportAsk never spoken; the WhatsApp report branch is off', reads: (c) => c.rc.reportIntake === false },
    RECORDING_NOTICE:       { value: 'on', evidence: 'SPEC 1.1 — the recording line inside the greeting', changes: 'the greeting carries the recording sentence', reads: (c) => c.config.recordingNotice === true && c.rc.recordingNotice === true },
    APPOINTMENT_SLOT_MINUTES: { value: '10', evidence: 'SPEC env block', changes: 'the slot grid', reads: (c) => c.config.appointmentSlotMinutes === 10 },
    SLOT_SEARCH_DAYS:       { value: '2', evidence: 'SPEC env block (horizon 2)', changes: 'how far availability looks ahead', reads: () => process.env.SLOT_SEARCH_DAYS === '2' },
    EMERGENCY_V2_ENFORCE:   { value: 'selfharm,stroke,poisoning', evidence: 'SPEC env block', changes: 'which v2 categories escalate, both channels', reads: (c) => c.rc.emergencyV2 === 'selfharm,stroke,poisoning' },
    META_TEMPLATE_LANGUAGE: { value: 'gu', evidence: 'SPEC env block', changes: 'WhatsApp template language', reads: (c) => JSON.stringify(c.config).includes('"defaultTemplateLanguage":"gu"') },
    REMINDER_JOB:           { value: 'on', evidence: 'SPEC — reminders on', changes: 'the reminder cron runs', reads: (c) => !!(c.rc.jobs && c.rc.jobs.reminder === true) },
    FOLLOWUP_JOB:           { value: 'off', evidence: 'SPEC — every other job off (its code default is ON, so off must be explicit)', changes: 'no follow-up WhatsApp', reads: (c) => !!(c.rc.jobs && c.rc.jobs.followup === false) },
    MISSED_CALL_JOB:        { value: 'off', evidence: 'SPEC — every other job off', changes: 'no missed-call WhatsApp', reads: (c) => !!(c.rc.jobs && c.rc.jobs.missedCall === false) },
    NOSHOW_JOB:             { value: null, evidence: 'SPEC — off until the desk marks confirmations', changes: 'no no-show marking', reads: (c) => !!(c.rc.jobs && c.rc.jobs.noShow === false) },
    // No Google at all (founder, 2026-09-08): the desk is the calendar. These
    // are pinned ABSENT so the suite proves nothing on the call path needs them.
    ENABLE_GOOGLE_CALENDAR: { value: '', evidence: 'founder decision 2026-09-08 — the desk is the calendar', changes: 'no freebusy/insert per booking; google_calendar_event_id stays null', reads: (c) => c.config.google.enabled === false && c.rc.googleCalendar === false },
    CALENDAR_ID:            { value: '', evidence: 'same — nothing reads it with the mirror off', changes: 'nothing', reads: (c) => !c.config.google.calendarId },
    GOOGLE_SERVICE_ACCOUNT_JSON: { value: '', evidence: 'same — the only consumers are the mirror and the Sheet', changes: 'nothing', reads: (c) => !c.config.google.serviceAccountJson },
    GOOGLE_SHEET_ID:        { value: '', evidence: 'SPEC env block: "own or unset" — unset', changes: 'no Sheet row per call; the calls table is the record', reads: (c) => c.rc.sheet === false },
  },
};
if (!PROFILES[PROFILE]) throw new Error(`tests/_bootstrap.js: unknown BOOTSTRAP_PROFILE "${PROFILE}" (known: ${Object.keys(PROFILES).join(', ')})`);
Object.assign(PRODUCTION, PROFILES[PROFILE]);

const SAFETY = {
  DATABASE_URL: {
    // db.js:34 calls initDb() AT REQUIRE TIME and issues `SELECT 1`. Requiring
    // db.js from a bare `node tests/foo.js` has therefore been opening a
    // connection to whatever the local .env points at — and ARCHITECTURE.md
    // records that assuming the local URL was production's already took the
    // desk down once. Port 1 refuses instantly (ECONNREFUSED), so a test that
    // really does reach for the network fails in milliseconds and says why,
    // instead of hanging or, worse, succeeding.
    value: 'postgres://engageo_test:no-password@127.0.0.1:1/engageo_bootstrap_refuses_a_real_db',
    why: 'production points at the live Railway Postgres; a unit test must not be able to reach it',
  },
  TEST_MODE: {
    // whatsapp.js:130 short-circuits outbound sends ONLY when this is 'true'.
    // Production runs it OFF, and so does a bare test — which means any test
    // touching whatsapp.js has been attempting a REAL Meta send on the live
    // credentials sitting in the local .env.
    value: 'true',
    why: 'production is OFF, which means real WhatsApp messages on real credentials',
  },
};

// Placeholder credentials, filled ONLY where the variable is absent, so that
// config.validate() (config.js:317, which process.exit(1)s on a missing var)
// runs in a bare git worktree. This is not cosmetic: tests/test-runtime-config.js
// spawns `node -e "require('./config.js').validate()"` and FAILED in a fresh
// worktree for no reason but a gitignored .env — an environment artifact that
// cost an auditor a full extra baseline run to disentangle from a real defect.
// Fill-if-absent, never overwrite: a machine that has real keys keeps them, so
// the three deliberately-live provider tests still work.
const PLACEHOLDER_CREDENTIALS = {
  EXOTEL_SID: 'test-not-a-real-exotel-sid',
  EXOTEL_API_KEY: 'test-not-a-real-key',
  EXOTEL_API_TOKEN: 'test-not-a-real-token',
  EXOTEL_SUBDOMAIN: 'api.exotel.com',
  SARVAM_API_KEY: 'test-not-a-real-sarvam-key',
  CALENDAR_ID: 'test-not-a-real-calendar@group.calendar.google.com',
  GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account","project_id":"engageo-test","private_key":"","client_email":"test@engageo-test.iam.gserviceaccount.com"}',
  // config.validate() exits 1 if the pinned primary provider has no key.
  GEMINI_API_KEY: 'test-not-a-real-gemini-key',
  GROQ_API_KEY: 'test-not-a-real-groq-key',
};

// ═══════════════════════════════════════════════════════════════════════════
// UNKNOWN IN PRODUCTION — the honest column.
//
// These have no captured evidence either way, and guessing is what this file
// exists to stop. The boot line that would settle EMERGENCY_V2_ENFORCE was
// added 2026-08-05 (commit 2038392) and the runtimeConfig line that would
// settle GARBLE_GUARD and META_APP_SECRET was added 2026-08-08 — both AFTER
// the newest captured production boot. Absence from that log is not evidence
// of absence: GARBLE_GUARD only logs when it FIRES.
//
// So the bootstrap does NOT pin them. It leaves them unset (the code's own
// default) and PRINTS that it did, once per run, because an unexamined default
// is exactly how "we measure it" became "we cannot answer it". A test whose
// behaviour depends on one of these must say so with unpin().
// ═══════════════════════════════════════════════════════════════════════════
const UNKNOWN_IN_PRODUCTION = {
  EMERGENCY_V2_ENFORCE: 'unset -> v1 only, which this repo\'s own numbers say misses 34 of 96 red flags (11/12 self-harm, 10/12 stroke). Highest-consequence unknown in the configuration.',
  GARBLE_GUARD: 'unset -> off. On, it inserts a deterministic "please repeat" turn instead of feeding noise into booking and clinical capture.',
  META_APP_SECRET: 'unset -> inbound WhatsApp POSTs are NOT signature-verified. "We verify signatures" is currently an unchecked claim.',
  ENABLE_INPUT_LIMITER: 'unset -> off. On, it soft-clips caller audio BEFORE STT, so it changes the bytes the recogniser sees and therefore every transcript-level test.',
  ENABLE_REPORT_INTAKE: 'unset -> off. Gates the WhatsApp previous-reports intake branch entirely.',
  ENABLE_THINKING_FILLER: 'unset -> off. Needs the tool path, which lean bypasses, so probably inert.',
  ENABLE_TOOL_STREAMING: 'unset -> off. Only reachable when !useLean, so inert on production\'s lean path.',
};

// ─── STATE ──────────────────────────────────────────────────────────────────
const declared = new Map();   // name -> { value, why }  (explicit unpin)
const expected = new Map();   // name -> string | null   (what must hold now)
let sealed = false;           // first production require closes the door
let verifying = false;        // Module._load reentrancy guard
let sawPgMemSkip = false;     // setupDb printed a SKIP banner and exited 0
let sandbox = null;           // mutatesEnv(): enforcement off for this file

const EXIT_DECLARED_GAP = 75; // EX_TEMPFAIL — "not run", distinguishable from a pass

function fail(lines) {
  const bar = '═'.repeat(74);
  console.error(`\n${bar}\n TEST BOOTSTRAP — REFUSING TO RUN\n${bar}`);
  for (const l of lines) console.error(l);
  console.error(`${bar}\n`);
  // throw, not exit: the stack names the file that did it.
  throw new Error('tests/_bootstrap.js: ' + lines[0]);
}

// ─── 1. THE BOOTSTRAP MUST BE FIRST ─────────────────────────────────────────
// Every switch here is read into a module-level const the moment a production
// file is required — GARBLE_GUARD_ENABLED at callHandler.js:370, READBACK_MODE
// at :65, the whole config object at config.js load. Pinning after that point
// changes nothing and looks like it changed everything. So if any production
// module is already in require.cache when this file loads, the test required us
// on line 40 instead of line 1, and we say so instead of pretending.
{
  const early = Object.keys(require.cache).filter((f) => isProductionFile(f));
  if (early.length) {
    fail([
      'a production module was loaded BEFORE tests/_bootstrap.js.',
      '',
      '  already loaded:  ' + early.map((f) => path.relative(REPO, f)).join(', '),
      '',
      '  Module-level constants freeze env at require time (callHandler.js:65',
      '  READBACK_MODE, :370 GARBLE_GUARD_ENABLED, config.js\'s whole object), so a',
      '  pin applied now would be decorative. Move the bootstrap require to the',
      '  first executable line of the test file.',
    ]);
  }
}

// ─── 2. APPLY THE PINS ──────────────────────────────────────────────────────
for (const [name, spec] of Object.entries(PRODUCTION)) applyPin(name, spec.value);
for (const [name, spec] of Object.entries(SAFETY)) applyPin(name, spec.value);
for (const [name, value] of Object.entries(PLACEHOLDER_CREDENTIALS)) {
  if (PRODUCTION[name] && (PRODUCTION[name].value === null || PRODUCTION[name].value === '')) continue;   // a profile pinned it ABSENT on purpose ('' = present but empty: survives a .env that would refill a deleted name)
  if (!process.env[name]) process.env[name] = value;      // fill, never overwrite
}

// value null = delete; value '' = present but empty. Prefer '' for a name that
// config.js would otherwise refill from a local .env at require time — the code
// treats '' as unset (every check is truthiness), and dotenv never overrides a
// name that is already present.
function applyPin(name, value) {
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  expected.set(name, value);
}

// ─── 3. ENFORCEMENT ─────────────────────────────────────────────────────────
// process.env cannot be locked on this runtime (measured; see the header), so
// the check runs where the value is consumed and again at exit.
function drift() {
  const out = [];
  for (const [name, want] of expected) {
    const got = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : null;
    if (got !== want) out.push({ name, want, got });
  }
  return out;
}

function reportDrift(where, rows) {
  const bar = '═'.repeat(74);
  console.error(`\n${bar}\n TEST BOOTSTRAP — A PINNED SWITCH WAS CHANGED WITHOUT SAYING SO (${where})\n${bar}`);
  for (const r of rows) {
    const spec = PRODUCTION[r.name] || SAFETY[r.name] || {};
    console.error(`  ${r.name}`);
    console.error(`    production: ${r.want === null ? '(unset)' : r.want}`);
    console.error(`    this run:   ${r.got === null ? '(unset)' : r.got}`);
    if (spec.changes) console.error(`    that means: ${spec.changes}`);
    if (spec.why) console.error(`    pinned because: ${spec.why}`);
  }
  console.error('');
  console.error("  If the test NEEDS the non-production value, say so where a reader can see it:");
  console.error("      require('./_bootstrap').unpin('CLINIC_MODE', 'full', 'asserts the full-brain branch writes no appointments row (index.js:356)');");
  console.error('  as the SECOND line of the file, before any production require.');
  console.error('  If the SUBJECT of the file is env resolution itself, use');
  console.error("      require('./_bootstrap').mutatesEnv('<reason>');");
  console.error(`${bar}\n`);
}

// The chokepoint: every production require re-checks the pins, because a
// require is exactly when a module-level const freezes a value.
const origLoad = Module._load;
Module._load = function bootstrapGuardedLoad(request, parent, isMain) {
  if (!verifying && !sandbox) {
    let filename = null;
    try { filename = Module._resolveFilename(request, parent, isMain); } catch (_) { /* unresolvable: let node raise it */ }
    if (filename && isProductionFile(filename)) {
      const rows = drift();
      if (rows.length) {
        reportDrift(`loading ${path.relative(REPO, filename)}`, rows);
        throw new Error(`tests/_bootstrap.js: pinned switch changed before requiring ${path.relative(REPO, filename)}`);
      }
      if (!sealed) seal();
    }
  }
  const m = origLoad.apply(this, arguments);
  // Convert the pg-mem SKIP from an exit(0) — indistinguishable from a pass to
  // every CI gate and to this suite's own `if (fail > 0) process.exit(1)`
  // convention — into exit 75. Two files (test-tool-bookAppointment.js,
  // test-tool-bookReschedule.js) currently exit 0 having run ZERO assertions,
  // and one of them is the only guard on the book→change-time flip-flop. The
  // original banner is reused rather than reprinted, so its text stays one
  // source; only the exit STATUS is rewritten, at exit, by the hook below.
  if (m && typeof m.skipUnlessSupported === 'function' && !m.__bootstrapWrapped) {
    const inner = m.skipUnlessSupported;
    m.skipUnlessSupported = function (pool, capability, whatIsLost) {
      if (!(pool && pool.supports && pool.supports[capability])) sawPgMemSkip = true;
      return inner.apply(this, arguments);
    };
    m.__bootstrapWrapped = true;
  }
  return m;
};

// First production require closes the door on unpin() and READS THE PINS BACK
// THROUGH THE PRODUCTION MODULES. This is the clause that keeps this file from
// becoming a third source of truth: it never re-implements `on(v)` or a
// default, it asks config.js and runtimeConfig.js what they concluded.
function seal() {
  sealed = true;
  verifying = true;
  try {
    const ctx = { config: require('../config'), rc: require('../runtimeConfig').runtimeConfig() };
    const broken = [];
    for (const [name, spec] of Object.entries(PRODUCTION)) {
      if (typeof spec.reads !== 'function') continue;
      if (declared.has(name)) continue;                    // explicitly unpinned: skip
      let ok = false, err = null;
      try { ok = spec.reads(ctx) === true; } catch (e) { err = e; }
      if (!ok) broken.push(`  ${name}=${JSON.stringify(process.env[name])} did not survive the round trip through config.js/runtimeConfig.js${err ? ` (${err.message})` : ''}`);
    }
    if (broken.length) {
      fail([
        'a pinned switch did not resolve the way the production code resolves it.',
        '',
        ...broken,
        '',
        '  Either the pin is stale or the code changed how it reads the flag.',
        '  Fix it HERE, in tests/_bootstrap.js — do not re-type the rule in a test.',
      ]);
    }
  } finally {
    verifying = false;
  }
}

function isProductionFile(filename) {
  if (!filename || !filename.startsWith(REPO + path.sep)) return false;
  if (filename.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (filename.startsWith(TESTS + path.sep)) return false;
  return filename.endsWith('.js');
}

// Last line of defence: drift introduced AFTER the final require — a test that
// flips READBACK mid-file and then calls a method — is invisible to the load
// hook. It is not invisible here. Measured on node v20.20.0: an 'exit' handler
// can set process.exitCode and it wins even over an explicit process.exit(0).
process.on('exit', (code) => {
  const rows = sandbox ? [] : drift().filter((r) => !declared.has(r.name));
  if (rows.length) {
    reportDrift('at exit', rows);
    if (!code) process.exitCode = 1;
  }
  if (sawPgMemSkip && !process.exitCode) {
    console.error('\n  ⏭  → exit 75: the SKIP above ran ZERO assertions. Exit 0 would be');
    console.error('     indistinguishable from a pass. Give it a real Postgres via');
    console.error('     TEST_DATABASE_URL to restore the coverage it names.\n');
    process.exitCode = EXIT_DECLARED_GAP;
  }
});

// ─── 4. THE ESCAPE HATCH ────────────────────────────────────────────────────
// Deliberately ugly and deliberately greppable:
//     grep -rn "_bootstrap').unpin(" tests/
// gives the complete list of places this suite knowingly runs a switch
// production does not run, each with its reason in the same line. `why` is
// mandatory and length-checked because "needed for test" is not a reason.
function unpin(name, value, why) {
  if (sealed) {
    fail([
      `unpin('${name}') was called after a production module had already been required.`,
      '',
      '  Module-level constants have already frozen the old value, so this call',
      '  would change the record without changing the run. Move it above the',
      '  first require of any repo module.',
    ]);
  }
  if (!Object.prototype.hasOwnProperty.call(PRODUCTION, name) &&
      !Object.prototype.hasOwnProperty.call(SAFETY, name) &&
      !Object.prototype.hasOwnProperty.call(UNKNOWN_IN_PRODUCTION, name)) {
    fail([
      `unpin('${name}') names a variable this bootstrap does not pin.`,
      '',
      '  Either it needs no unpinning (just set it), or — more likely — it is a',
      '  production switch nobody has recorded yet, in which case add it to',
      '  PRODUCTION with its evidence rather than routing around the record.',
    ]);
  }
  if (typeof why !== 'string' || why.trim().length < 25) {
    fail([
      `unpin('${name}') needs a real reason (>=25 chars) as its third argument.`,
      '',
      '  It is printed on every run and read by whoever inherits this file.',
      '  Name the branch being tested and the line that implements it, e.g.',
      "  'asserts the full-brain branch writes no appointments row (index.js:356)'.",
    ]);
  }
  const was = expected.has(name) ? expected.get(name) : null;
  if (value === null || value === undefined) delete process.env[name];
  else process.env[name] = String(value);
  expected.set(name, value === null || value === undefined ? null : String(value));
  declared.set(name, { value, why });
  console.error(`⚑ UNPINNED ${name}=${value === null ? '(unset)' : value}  (production: ${was === null ? 'unset' : was})  — ${why}`);
  return api;
}

// ─── THE WIDER HATCH, FOR ONE KIND OF FILE ──────────────────────────────────
// A test whose SUBJECT is the env reader cannot also be pinned by it. There is
// exactly one such file today: tests/test-runtime-config.js, whose fresh()
// helper (lines 25-34) sweeps GARBLE_GUARD through 'on'/'true'/'' and each
// ENABLE_* through 'true'/'1'/'yes' to prove the code resolves strict-true —
// precisely the check that catches "GARBLE_GUARD=true is silently OFF". Pinning
// those values would delete the test.
//
// Note what that helper also does: `process.env = saved` (line 31) REPLACES
// process.env with a plain object rather than restoring keys, and it leaks —
// running that file under this bootstrap left ENABLE_SPECULATIVE_LLM='1' behind
// at exit, which is how this hatch was discovered rather than assumed.
//
// This suspends enforcement for the whole process, so it is the widest hole in
// the file and is listed as such in CANNOT-CATCH. Two consumers, one grep:
//     grep -rn "_bootstrap').mutatesEnv(" tests/
function mutatesEnv(why) {
  if (typeof why !== 'string' || why.trim().length < 25) {
    fail([
      'mutatesEnv() needs a real reason (>=25 chars).',
      '',
      '  It suspends every pin for the whole process. If the file only needs one',
      "  or two different values, use unpin(name, value, why) instead — that keeps",
      '  the rest of the configuration enforced.',
    ]);
  }
  sandbox = why;
  console.error(`⚑ PINS SUSPENDED for this file — ${why}`);
  return api;
}

// Not a design-around: a plain statement that some coverage is unavailable in
// this environment. The runner half of tests/test-migration-no-transaction.js
// asserts on BEGIN/COMMIT sequencing it reimplements itself, because
// db/migrate.js exports only { migrate } and applyMigration cannot be reached;
// proving the real runner skips the transaction needs a server that can be
// asked what it did — a real Postgres. pg-mem cannot answer it, and neither
// can this file. Calling this makes the gap a non-zero exit instead of a tick.
function needsRealPostgres(whatIsLost) {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  console.error('\n⏭  NOT RUN — this file needs a real Postgres, not a double.');
  console.error(`   NOT COVERED: ${whatIsLost}`);
  console.error('   pg-mem cannot answer "did the runner issue BEGIN?" — only a server can.');
  console.error('   Set TEST_DATABASE_URL to a scratch database to restore this coverage.');
  console.error(`   Exiting ${EXIT_DECLARED_GAP} (not 0) so this is never mistaken for a pass.\n`);
  process.exit(EXIT_DECLARED_GAP);
}

// For a test that wants to re-check at a chokepoint of its own choosing —
// after driving a code path that it suspects mutates env.
function assertPins() {
  const rows = drift().filter((r) => !declared.has(r.name));
  if (rows.length) {
    reportDrift('assertPins()', rows);
    throw new Error('tests/_bootstrap.js: pinned switch changed mid-test');
  }
  return true;
}

// One line, always, never suppressible: the switches nobody has established.
// Silence about an unknown is how a flag stays unknown for three investigations.
{
  const names = Object.keys(UNKNOWN_IN_PRODUCTION).join(' ');
  console.error(`[bootstrap] profile=${PROFILE} — pinned ${expected.size} switches to production; UNKNOWN in production (left at code default): ${names}`);
}

const api = { unpin, mutatesEnv, assertPins, needsRealPostgres, PRODUCTION, SAFETY, UNKNOWN_IN_PRODUCTION, EXIT_DECLARED_GAP };
module.exports = api;

// ─── 5. `node tests/_bootstrap.js` — THE CONFORMANCE LINT ───────────────────
// A file cannot notice that another file failed to require it. Nothing inside
// this process can see a test that never loaded the bootstrap, and pretending
// otherwise would be the same shape of vacuous check this suite is being
// cleaned of. So the check runs OUTSIDE the process, over the source: every
// tests/*.js must have require('./_bootstrap') as its first executable line.
// Wire it as the first step of the suite runner; it exits 1 and names names.
if (require.main === module) {
  const files = [];
  for (const dir of [TESTS, path.join(TESTS, 'integration')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js') && f !== '_bootstrap.js') files.push(path.join(dir, f));
    }
  }
  const bad = [];
  for (const f of files) {
    const first = firstExecutableLine(fs.readFileSync(f, 'utf8'));
    if (!/require\((['"])[.\/]*_bootstrap\1\)/.test(first || '')) {
      bad.push(`  ${path.relative(REPO, f)}\n      first executable line is: ${first ? first.slice(0, 90) : '(none)'}`);
    }
  }
  if (bad.length) {
    console.error(`\n${'═'.repeat(74)}`);
    console.error(` ${bad.length} of ${files.length} test files do not load the bootstrap FIRST.`);
    console.error(' Each one runs CLINIC_MODE=full, READBACK=off, STT_MODE=transcribe and');
    console.error(' every latency flag OFF — a machine production does not run.');
    console.error(`${'═'.repeat(74)}`);
    console.error(bad.join('\n'));
    console.error("\n Fix: make this the first executable line:\n     require('./_bootstrap');\n");
    process.exit(1);
  }
  console.log(`✓ all ${files.length} test files load tests/_bootstrap.js first`);
}

// Strip shebang, 'use strict', blank lines and comments (line and block), and
// return the first line that actually runs. Kept deliberately small: it reads
// the top-of-file preamble these tests all share, not arbitrary JavaScript.
function firstExecutableLine(src) {
  let inBlock = false;
  for (let raw of src.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2).trim();
      inBlock = false;
    }
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      if (end === -1) { inBlock = true; line = ''; break; }
      line = line.slice(end + 2).trim();
    }
    if (inBlock || !line) continue;
    if (line.startsWith('#!') || line.startsWith('//')) continue;
    if (/^['"]use strict['"];?$/.test(line)) continue;
    return line;
  }
  return null;
}
