// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP → brain-lean. A CARRIER, NOT A RECEPTIONIST.
//
// WHY THIS FILE IS THIN ON PURPOSE. Before this, WhatsApp had its own brain
// (whatsappBrain.js, 176 lines) with its own prompt, its own action enum, and
// its own idea of what Ritu can do. It could not book — its prompt said so
// outright — and its reschedule branch replied "ho gaya" while changing
// nothing. That is what a second brain becomes: it does not stay a smaller
// copy, it becomes a WRONGER one, and every guard has to be built twice.
//
// So WhatsApp now runs the SAME brain the phone runs. This file's entire job is
// to turn (phone, inbound text, conversation row) into brain-lean's two
// arguments, and hand back what brain-lean returns. It holds no prompt, no
// tools, no action switch, and no opinion about what to say. If it ever grows a
// decision about wording, that is the drift the architecture exists to prevent.
//
// TWO HARD RULES, both learned the expensive way:
//
//  1. NEVER require('./callHandler') from here. There is a cycle —
//     callHandler.js → crm.js → whatsapp.js — and crm.js destructures
//     sendConfirmation at load time. Importing callHandler anywhere the
//     WhatsApp path can reach binds that to undefined permanently and the VOICE
//     path silently stops sending its post-call confirmation. Shared text lives
//     in safetyText.js / translit.js for exactly this reason.
//     Locked by tests/test-no-callhandler-cycle.js.
//
//  2. The ONLY string this file may pass to the sender is `result.text` from
//     processLeanRaw (or a cannedLine when that is empty). Never a message this
//     file composes, never the model's raw text. On every failure path
//     brain-lean has ALREADY overwritten result.text with an audited
//     server-side line before returning — that is what makes "a stated booking
//     ⟺ a committed row" hold structurally instead of by a caller remembering
//     to check a flag.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const config = require('./config');
const db = require('./db');
const { runtimeConfig } = require('./runtimeConfig');
const { getLeanResponse, preloadRoster, refreshRoster, cannedLine, _roster } = require('./brain-lean');
const findPatientAppointmentTool = require('./tools/findPatientAppointment');
const { cleanPersonName } = require('./nameGuard');

// Voice keeps 20 turns (callHandler MAX_CONVERSATION_HISTORY). Matching it means
// the roster slice and the history machine see the same depth on both channels.
const HISTORY_TURNS = 20;

// Any machine sentinel that reaches a patient is a bug. brain.js strips them and
// tests/test-sentinel-leak.js locks that — this is belt-and-braces on the one
// channel where the patient would READ the JSON rather than hear it as noise.
const SENTINEL_TOKEN = /^[A-Z][A-Z_]{3,}:/m;

// ── language ────────────────────────────────────────────────────────────────
// The one non-obvious mapping here, and it is not cosmetic.
//
// brain-lean has TWO language mechanisms. `languageCode` pins a NON-hi/mr
// language ("reply entirely in Kannada"). `hindiInCall` selects the Hindi
// branch. They are not interchangeable:
//
//   languageCode:'hi-IN'                 → "reply in HINDI … Hindi/Marathi mat
//                                           bol" — self-contradictory
//   languageCode:null, hindiInCall:true  → "reply in HINDI. Marathi mat bol"  ✓
//   languageCode:'kn-IN'                 → "reply in KANNADA"                 ✓
//
// And cannedLine() falls back to mr-IN when languageCode is null and
// hindiInCall is false — so passing null alone gives a Hindi-typing patient
// Marathi safety lines. That is the same class of bug as commit 304d1f6, where
// a Hindi caller was answered in Marathi for the first three turns.
function languageFields(lang) {
  const pinned = (lang && lang !== 'hi-IN' && lang !== 'mr-IN' && config.languageNames && config.languageNames[lang])
    ? lang : null;
  return { languageCode: pinned, hindiInCall: !pinned && lang !== 'mr-IN' };
}

// ── patient identity ────────────────────────────────────────────────────────
// Moved here from whatsappBrain.js with two fixes. The old version defaulted
// name to the string 'Patient', which (a) reached the prompt as if the patient
// were called Patient, and (b) is worse than cosmetic: db.upsertPatient
// conflicts on (clinic_id, phone, name), so the placeholder mints a SEPARATE
// row from the same person's real name.
async function loadPatientContext(phoneDigits) {
  const out = { patientId: null, name: null, isReturning: false };
  try {
    // Phones are stored in three shapes across this system (+91… from voice,
    // 919876543210 from Meta, 9876543210 from the tools). Match on the last 10
    // digits so a WhatsApp message finds the row a phone call created.
    const last10 = String(phoneDigits || '').replace(/\D/g, '').slice(-10);
    if (!last10) return out;
    const res = await db.pool.query(
      `SELECT id, name FROM patients
        WHERE clinic_id = $1 AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
        ORDER BY created_at DESC LIMIT 1`,
      [config.clinicId, last10]
    );
    if (res.rows.length) {
      out.patientId = res.rows[0].id;
      // The READ path, and the one that bites first. Twelve rows in the
      // production table are already corrupt — "your name", "Unknown", ".",
      // "ಅಪರಿಚಿತ" — written before the guard existed. Filtering on write does
      // nothing for them; this is what stops a returning caller being greeted
      // as "your name जी" until those rows are cleaned.
      out.name = cleanPersonName(res.rows[0].name);
      out.isReturning = true;
    }
  } catch (err) {
    console.error('[WA-CHANNEL] loadPatientContext:', err.message);
  }
  return out;
}

// ── context ─────────────────────────────────────────────────────────────────
// ─── WHICH SCRIPT IS THE PATIENT TYPING IN? ─────────────────────────────────
// resolveInboundLanguage (whatsapp.js:24) answers "which LANGUAGE", and it
// deliberately treats a Latin-script message as no signal so a Kannada caller
// typing "haan theek hai" stays in Kannada. Correct — but it leaves SCRIPT
// undecided, and script is a separate question from language.
//
// The visible cost: a new conversation whose first message is "hi" has no
// stored language, so languageFields(null) sets hindiInCall and Ritu answers in
// DEVANAGARI to someone who just typed two Latin letters. On WhatsApp, where the
// patient can see the reply, that reads as being answered in the wrong alphabet.
//
// Voice has no script — this is text-only, and passes undefined elsewhere so
// the voice prompt is byte-identical.
function inboundScript(text) {
  const s = String(text || '');
  if (/[\u0900-\u0DFF]/.test(s)) return 'indic';   // any Brahmic block
  if (/[A-Za-z]{2,}/.test(s)) return 'latin';
  return null;                                       // digits, emoji, too short
}

// The SAME policy keys as the three voice builders (callHandler
// _maybeStartSpeculation / _leanNonStreamedResult / processIntentLeanStream):
// bookedThisCall (second-appointment truth), driftReasked (the re-ask loop
// guard), onRosterSlice / onLlmUsage (the meters). tests/test-twin-parity.js
// holds the two builders to the same key set; this one used to carry none of
// the four, so on WhatsApp every drift re-asked forever and no turn was metered.
function buildLeanContext({ phone, language, patientName, patientTextAll, script,
  driftReasked = false, bookedThisCall = null, onRosterSlice = null, onLlmUsage = null }) {
  return {
    driftReasked: !!driftReasked,
    bookedThisCall: bookedThisCall || null,
    onRosterSlice: onRosterSlice || ((sl) => { if (sl && sl.sliced) console.log(`[WA-CHANNEL] roster slice ${sl.count}/${sl.total}`); }),
    onLlmUsage: onLlmUsage || ((u) => { if (u) console.log(`[WA-CHANNEL] llm usage prompt=${u.prompt ?? '?'} completion=${u.completion ?? '?'} cached=${u.cached ?? '?'}`); }),
    channel: 'whatsapp',              // the only prompt switch — see brain-lean
    replyScript: script || null,
    clinicId: config.clinicId,
    callerPhone: phone,               // the booking tools normalise internally
    // Was a two-value check for 'Patient' and 'Unknown' — right instinct, wrong
    // scope. The production table also holds "your name", "." and a Kannada
    // "ಅಪರಿಚಿತ", and a WhatsApp profile name is at least as unreliable as a
    // spoken one. One shared list now, in nameGuard.js.
    patientName: cleanPersonName(patientName),
    ...languageFields(language),
    multilingual: process.env.ENABLE_MULTILINGUAL === 'true',
    // The roster slice needs the WHOLE complaint. A WhatsApp thread spans days,
    // so the original symptom falls out of the history window long before the
    // booking happens; without this the slice narrows on the wrong text.
    patientTextAll: patientTextAll || '',
    // ── DELIBERATELY ALWAYS FALSE ──────────────────────────────────────────
    // brain-lean disables its false-booking guard when appointmentBooked is
    // true. On voice that means "committed during THIS call" — a bounded
    // window. The tempting WhatsApp mapping, `!!context.appointmentId`, would
    // hand a PERMANENT licence to every patient who already has an appointment:
    // precisely the population most likely to be told "हो गया" about a second,
    // uncommitted one, with the guard structurally unable to fire. A WhatsApp
    // conversation has no session to scope it to, so it is false on every
    // inbound message. If a re-confirm loop ever shows up, fix it with a
    // narrower turn-scoped flag — never by widening this.
    appointmentBooked: !!(bookedThisCall && bookedThisCall.appointment_id),
  };
}

// ── one inbound message ─────────────────────────────────────────────────────
/**
 * @param {{phone:string, conv:{id:number, language:?string}, patientName:?string,
 *          patientTextAll:?string}} a
 * @returns {Promise<object>} processLeanRaw's result verbatim — {text, booked, ...}
 */
// ─── THE PRE-VISIT INTAKE, SHARED WITH VOICE ─────────────────────────────────
// The intake is callHandler._maybeHistoryQuestion and its callees: ~600 lines,
// every branch with a live-call incident behind it. It is NOT re-implemented
// here. It runs UNCHANGED on a throwaway adapter — an object with the
// CallHandler prototype whose instance fields are hydrated from the thread's
// intake column and written back after the call — so both channels ask the
// same questions in the same order and write the same patient_medications
// rows, because it is literally the same code. tests/test-twin-parity.js
// holds the two channels equal; tests/test-whatsapp-intake.js drives a thread.
//
// The cycle rule above still holds for TOP-LEVEL requires: callHandler is
// required lazily, inside runIntake, at call time — when the module graph is
// complete in both load orders (tests/test-whatsapp-load-order.js).
const INTAKE_EPISODE_MS = 24 * 60 * 60 * 1000;   // a day of silence starts a new episode
const INTAKE_VERSION = 1;
function freshIntake() {
  return { v: INTAKE_VERSION, stage: 0, readbackPending: null, readbackDtmfPending: null, medRepeatPending: null,
    readbackDone: false, medsHeld: false, durationReasked: false, reportAskSent: false, bookedAt: null, at: 0 };
}
function hydrateIntake(conv, now = Date.now()) {
  let raw = conv && conv.intake;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  if (!raw || typeof raw !== 'object') return freshIntake();
  if (raw.at && now - raw.at > INTAKE_EPISODE_MS) {
    if (raw.readbackPending || raw.medRepeatPending) console.log(`[WA-INTAKE] new episode after ${Math.round((now - raw.at) / 3600000)}h — a pending read-back is dropped (voice flushes it at endCall; the thread has no end)`);
    return freshIntake();
  }
  return { ...freshIntake(), ...raw };
}
// Runs the voice intake once for this inbound text. Returns { ask, intake }:
// ask is the deterministic line to send INSTEAD of a brain reply (or null),
// intake is the state written back.
// The adapter: every instance field the intake reads, hydrated from the thread.
// tests/test-whatsapp-intake.js drives this SAME object through a Proxy and
// asserts the machine reads nothing that is not hydrated here.
function buildIntakeAdapter({ conv, phone, language, history, intake, now = Date.now() }) {
  const { CallHandler } = require('./callHandler');   // lazy — see the header
  const h = Object.create(CallHandler.prototype);
  Object.assign(h, {
    callSid: `wa:${conv.id}`, callerPhone: phone, startTime: now - 1000,
    conversationHistory: history,                       // the machine pushes its marker turns here
    appointmentBooked: !!intake.bookedAt, appointmentTime: null,
    _langCode: () => language || 'hi-IN', _hindiInCall: (language || 'hi-IN') === 'hi-IN',
    _historyStage: intake.stage, _readbackPending: intake.readbackPending, _readbackDtmfPending: intake.readbackDtmfPending,
    _medRepeatPending: intake.medRepeatPending, _readbackDone: !!intake.readbackDone, _medsHeld: !!intake.medsHeld,
    _durationReasked: !!intake.durationReasked, _reportAskSpoken: !!intake.reportAskSent,
    _priorMeds: [], confirmedMeds: [], _lastTimeExpr: null, _rmsSpeech: 0, _rmsFloor: 0, _lastTurnPeakRms: 0,
  });
  return h;
}
async function runIntake({ conv, phone, patientId, language, history, text, intake, now = Date.now() }) {
  const h = buildIntakeAdapter({ conv, phone, language, history, intake, now });
  try { await h._loadPriorMeds(); } catch (e) { console.warn(`[WA-INTAKE] prior meds unavailable: ${e.message}`); }
  const before = history.length;
  let ask = null;
  try { ask = h._maybeHistoryQuestion(String(text || '')); }
  catch (e) { console.error(`[WA-INTAKE] intake threw (fail-open, brain answers): ${e.message}`); }
  // Marker turns ([VERIFIED] …, [ALLERGY] …) are pushed as role:'user' so the
  // model reads them as facts. Persist them as inbound rows of their own type:
  // getConversationHistory returns them as user turns next time (as on voice),
  // and collectInboundText excludes the type from patientTextAll.
  for (const m of history.slice(before)) {
    if (m && m.role === 'user' && m.content) await db.saveWhatsAppMessage(conv.id, patientId || null, 'inbound', m.content, 'intake-marker', null);
  }
  const next = { ...intake, v: INTAKE_VERSION, stage: h._historyStage, readbackPending: h._readbackPending || null,
    readbackDtmfPending: h._readbackDtmfPending || null, medRepeatPending: h._medRepeatPending || null,
    readbackDone: !!h._readbackDone, medsHeld: !!h._medsHeld, durationReasked: !!h._durationReasked, at: now };
  await db.updateConversationIntake(conv.id, next);
  return { ask: ask || null, intake: next };
}

async function runTurn({ phone, conv, patientName, patientTextAll, patientId = null }) {
  // index.js loads the roster at boot. This is the net for a process that
  // somehow reaches an inbound message first — without it, resolveDoctor fails
  // for every booking and the patient gets `unknownDoctor` with nothing logged.
  if (!_roster().doctors.length) {
    console.warn('[WA-CHANNEL] roster empty at inbound — loading now');
    await preloadRoster(config.clinicId);
  }
  // Desk edits reach the next WhatsApp turn too (60 s TTL, never awaited).
  refreshRoster().catch(() => {});

  // The caller SAVES the inbound message before reading history (whatsapp.js),
  // so history already ENDS with this message. Do not append it — that was a
  // live bug in whatsappBrain.js, which sent the patient's turn twice.
  const history = await db.getConversationHistory(conv.id, HISTORY_TURNS);
  // The script the patient is writing in RIGHT NOW. Taken from the last inbound
  // turn rather than patientTextAll, which spans days: a thread that opened in
  // Devanagari and continued in Latin should follow the patient, not its own
  // history. history already ends with this message (see the comment above).
  const lastIn = [...history].reverse().find((m) => m && m.role === 'user');
  // Was the LAST thing Ritu said the ask-complaint line? Then this turn is the
  // re-ask, and a second drift must be stripped, not re-asked (the voice path
  // carries _driftReasked; WhatsApp carried nothing and looped).
  const lastOut = [...history].reverse().find((m) => m && m.role === 'assistant');
  const baseCtx = buildLeanContext({ phone, language: conv.language, patientName, patientTextAll });
  const driftReasked = !!(lastOut && String(lastOut.content || '').trim() === String(cannedLine('askComplaint', baseCtx) || '').trim());
  // The thread's "booked this call": the patient's next active appointment.
  // Voice remembers the row it created this call; a WhatsApp thread spans days,
  // so the honest equivalent is the row that already exists. With it, a BOOK
  // re-emit for another day speaks bookedSecond (both rows named) instead of
  // "बदल दी" over a second silent INSERT, and the post-booking guards apply.
  let bookedThisCall = null;
  try {
    const found = await findPatientAppointmentTool.execute({}, { pool: db.pool, clinicId: config.clinicId, patientPhone: phone });
    const next = found && Array.isArray(found.appointments) && found.appointments[0];
    if (next && next.appointment_id) bookedThisCall = { appointment_id: next.appointment_id, appointment_time: next.appointment_time, doctor_name: next.doctor_name || null };
  } catch (e) { console.warn(`[WA-CHANNEL] next-appointment lookup failed (continuing without): ${e.message}`); }
  const ctx = buildLeanContext({
    phone, language: conv.language, patientName, patientTextAll, driftReasked, bookedThisCall,
    script: inboundScript(lastIn && (lastIn.content || lastIn.text)),
  });
  // ── the deterministic intake, in voice's position: after the guards, before the brain ──
  let intake = hydrateIntake(conv);
  const inboundText = lastIn ? String(lastIn.content || lastIn.text || '') : '';
  if (config.clinicMode === 'lean' && config.previsitIntake && inboundText) {
    const it = await runIntake({ conv, phone, patientId, language: ctx.languageCode || (ctx.hindiInCall ? 'hi-IN' : 'mr-IN'), history, text: inboundText, intake });
    intake = it.intake;
    if (it.ask) return { text: it.ask, canned: true, intake: true, booked: false, endCall: false, patientName: null, reason: null, emergency: false };
    // the report-photo ask, once per episode, the turn after a booking (voice: _maybeReportAsk)
    if (intake.bookedAt && !intake.reportAskSent && runtimeConfig().reportIntake) {
      const line = cannedLine('reportAsk', ctx);
      if (line) {
        await db.updateConversationIntake(conv.id, { ...intake, reportAskSent: true, at: Date.now() });
        return { text: line, canned: true, intake: true, booked: false, endCall: false, patientName: null, reason: null, emergency: false };
      }
    }
  }
  const result = await getLeanResponse(history, ctx);
  if (result && result.booked && !intake.bookedAt) await db.updateConversationIntake(conv.id, { ...intake, bookedAt: Date.now(), at: Date.now() });

  // Empty text is possible (a reply that was nothing but a sentinel). Send an
  // audited line chosen by what actually committed. NEVER re-run the LLM to get
  // a message: a retry could emit a second BOOK_APPOINTMENT and move the
  // appointment the patient just agreed to.
  let text = String(result.text || '').trim();
  if (!text) {
    text = cannedLine(result.booked ? 'booked' : 'retry', ctx) || cannedLine('retry', ctx);
    console.warn(`[WA-CHANNEL] empty brain text — sent canned (booked=${!!result.booked})`);
  }
  if (SENTINEL_TOKEN.test(text)) {
    console.error('[WA-CHANNEL] sentinel survived into patient text — stripping');
    text = text.split('\n').filter(l => !SENTINEL_TOKEN.test(l)).join('\n').trim()
      || cannedLine('retry', ctx);
  }

  return { ...result, text };
}

module.exports = { runTurn, buildLeanContext, hydrateIntake, runIntake, buildIntakeAdapter, INTAKE_EPISODE_MS, languageFields, inboundScript, loadPatientContext, HISTORY_TURNS };
