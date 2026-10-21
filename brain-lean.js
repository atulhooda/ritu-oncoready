// ═══════════════════════════════════════════════════════════════════════════
// brain-lean.js — LEAN MODE for small clinics / demos (CLINIC_MODE=lean)
//
// The hospital path (brain-tools.js) calls find_doctor + book_appointment as
// schema-enforced tools — two LLM calls + a DB round-trip per turn. For a clinic
// with 1-2 doctors that's overkill, and it's where the weak model stalls,
// hallucinates doctors, garbages output, and emits malformed tool calls.
//
// Lean mode instead PRELOADS the whole doctor roster into the prompt and runs ONE
// LLM call per turn. The model can't stall on a tool (there is none), can't invent
// a doctor (the real list is in front of it), and answers fast. Booking still goes
// through the SAME DB write as the hospital (tools/bookAppointment.execute) — so
// the dashboard, reminders, and the one-row/no-flip-flop invariant all still hold.
//
// Pair with LLM_PRIMARY_PROVIDER=gemini on the deployment for a reliable, demo-grade
// model (no scout garbage/stalls).
// ═══════════════════════════════════════════════════════════════════════════

const db = require('./db');
const config = require('./config');
const { completeWithFailover, streamWithFailover } = require('./llm');
const { cleanResponse } = require('./brain');
// Shared with brain.js so there is ONE reject-list. brain.js had a careful
// version of this that has never run a production call — see nameGuard.js.
const { cleanPersonName } = require('./nameGuard');
// Machine weekdays and 24-hour clocks must never reach an Indic TTS voice —
// see the live call quoted at the call site in processLeanRaw.
const { localizeDateTime } = require('./localizeDateTime');
const { scanForBookingIntent, spokenRegion, nextSentence } = require('./brain-streaming');
const bookAppointmentTool = require('./tools/bookAppointment');
const findPatientAppointmentTool = require('./tools/findPatientAppointment');
const updateAppointmentTool = require('./tools/updateAppointment');

// ─── TOOL TIME PER CALL (2026-09-18) ─────────────────────────────────────────
// The turn record measured "llm+tool" as ONE span, so a 3 s turn on a real
// Skin Essence call could not say whether the model or the booking tool was
// slow. Every tool execution on a turn is timed here, keyed by the call
// (context.callSid; a WhatsApp turn keys by its conversation id), and
// callHandler takes the total at the turn's first audio — so the record and
// the [LATENCY] line carry llm and tool separately.
const _toolMsByCall = new Map();
async function timedTool(context, run) {
  const key = (context && context.callSid) || '_';
  const t0 = Date.now();
  try { return await run(); }
  finally {
    if (_toolMsByCall.size > 500) _toolMsByCall.clear();
    _toolMsByCall.set(key, (_toolMsByCall.get(key) || 0) + (Date.now() - t0));
  }
}
/** Tool milliseconds accumulated for this call since the last take; resets. */
function takeTurnToolMs(callSid) {
  const key = callSid || '_';
  const v = _toolMsByCall.get(key) || 0;
  _toolMsByCall.delete(key);
  return v;
}
// Written and registered in tools/index.js since 001, but tools/index.js is the
// TOOL-CALLING brain's registry and production runs lean. Nothing here ever
// called it, so `callbacks` sat empty while Ritu promised callbacks for 11 of
// 25 doctors. Reused rather than re-implemented: it already validates the
// specialty against the clinic's on-call roster and dedups a repeat request.
const requestCallbackTool = require('./tools/requestCallback');
const { specialtiesForSymptom } = require('./tools/symptomMapping');

// ─── PER-TURN ROSTER SLICE (flag ENABLE_ROSTER_SLICE, default OFF) ──────────
// At 25+ doctors the full roster costs ~1k prompt tokens/turn and gives the
// model 25 chances to grab the wrong name. The slice injects FULL detail only
// for doctors whose specialty matches the symptoms the patient has stated so
// far, plus a one-line name+specialty INDEX of everyone else — so a by-name
// ask ("डॉ शर्मा से दिखाना है") still works in any script, and the model can
// never invent a doctor that isn't in front of it.
//
// Fail-safe by construction: every uncertain branch returns the FULL roster
// (slower-but-right beats fast-but-wrong):
//   - flag off / roster ≤ 3 doctors / no patient turn yet   → full
//   - no symptom matched anywhere in the call               → full
//   - symptom matched but roster has no such specialist     → full (the model
//     must see everything to honestly say "we don't have an eye doctor")
// The slice is a UNION over all patient turns — it only ever widens as the
// call reveals more symptoms, never flip-flops on a single utterance. If the
// original complaint falls off the trimmed history late in a long call, the
// slice degrades back to the full roster — bigger prompt, never a wrong one.
// Booking stays safe regardless: resolveDoctor matches against the FULL
// roster, and bookAppointmentTool validates every slot against the DB.
const ENABLE_ROSTER_SLICE = process.env.ENABLE_ROSTER_SLICE === 'true';

// "Is ANYONE free?" — a question about the CLINIC, not about a specialty, and
// therefore one the slice cannot answer: the slice demotes every non-matching
// doctor to a name-only index the prompt explicitly disclaims ("inke time/fees
// tujhe NAHI pata"), which is exactly the information such a question asks for.
//
// Built from the three live utterances that exposed it, not invented:
//   "कोई अभी doctor available है तुरंत"            0a0f0d8f, 2026-08-05
//   "अभी कोई नहीं है क्या, emergency में जल्दी"     3312d865, 2026-08-08
//   "আজকে কোনো ডাক্তার আছে?"                       5b261b844e, 2026-08-14
//
// Two shapes, either sufficient: an indefinite quantifier over people
// (koi/kaun/anyone/কোনো), or urgency (abhi/turant/jaldi/emergency), which is a
// whole-clinic question however it is phrased.
//
// DELIBERATELY LOOSE, and the asymmetry is the reason: a false positive costs a
// longer prompt and a little latency; a false negative costs a patient the
// appointment they rang for. Eleven languages, because the Bengali call is the
// one that made this visible at all.
const WHOLE_CLINIC_AVAILABILITY_RE = new RegExp('(कोई|कौन|कौनसा|कुणी|कोणी|কোনো|কেউ|ಯಾರಾದರೂ|ಯಾರು|ਕੋਈ|யாராவது|ఎవరైనా|કોઈ|ആരെങ്കിലും|କେହି|koi|kaun|anyone|any\s+doctor|someone|who\s+is\s+available)|(अभी|abhi|तुरंत|turant|जल्दी|jaldi|फटाफट|आत्ता|ताबडतोब|এখন|এখনই|তাড়াতাড়ি|ইমিডিয়েটলি|ಈಗ|ਹੁਣੇ|இப்போது|ఇప్పుడు|હમણાં|ഇപ്പോൾ|ଏବେ|emergency|इमरजेंसी|right\s+now|immediately|urgent)', 'i');

// The symptom map's canonical names vs the free-text doctors.specialty column
// ("Internal Medicine" vs "General Physician", "Cardiology" vs "Cardiologist").
// Token-level matching — naive substring would match ENT inside "dENTal".
// Alias entries are STEMS so prefix-matching covers -y/-ist/-ician variants.
const SPECIALTY_ALIASES = {
  // "ortho" must be EXACT (a 5-char stem would prefix-match orthodontist —
  // a DENTAL specialty); the ≥6 stems orthopaed/orthoped stay dental-safe.
  'orthopedic': ['orthopaed', 'orthoped', 'ortho', 'bone'],
  'gynecology': ['gynecolog', 'gynaecolog', 'obstetric', 'obgyn', 'obgy', 'obg', 'obs', 'gynae', 'gyn'],
  'pediatric': ['paediatr', 'pediatr', 'child'],
  'neurology': ['neurolog', 'neuro'],
  'nephrology': ['nephrolog', 'nephro'],
  'urology': ['urolog', 'uro'],
  'anesthesia': ['anaesthes', 'anesthesiolog'],
  'surgery': ['surgeon'],
  'dental': ['dentist', 'orthodont', 'endodont', 'oral'],
  'cardiology': ['cardiolog', 'cardio'],
  'ent': ['otolaryngolog', 'otorhinolaryngolog'],
  'dermatology': ['dermatolog', 'dermat', 'derma', 'skin'],
  'ophthalmology': ['ophthalmolog', 'ophthal', 'eye'],
  'psychiatry': ['psychiatr', 'psycholog', 'mental'],
  'oncology': ['oncolog', 'onco', 'cancer'],
  'gastroenterology': ['gastroenterolog', 'gastro'],
  'pulmonology': ['pulmonolog', 'pulmo', 'respiratory', 'chest'],
  'endocrinology': ['endocrinolog', 'endocrin', 'diabetolog'],
  // NO bare 'general' — it pulled General Dentist / General Surgeon into the
  // fever slice. "General Physician" still matches via 'physician'.
  'internal medicine': ['physician', 'medicine', 'family', 'practitioner', 'gp'],
};

function specialtyMatches(canonName, docSpecialty) {
  const tok = s => String(s || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const canonToks = tok(canonName), docToks = tok(docSpecialty);
  if (!docToks.length) return false;
  // canon ↔ doc: exact token, or prefix either way when both are ≥4 chars
  // (canon names are full unambiguous words, so this direction is safe).
  const hit = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  if (canonToks.some(c => docToks.some(d => hit(c, d)))) return true;
  // Aliases are STEMS and match ONE direction only — the doctor token must
  // start with the stem, and short stems (<6) must match exactly. A
  // bidirectional rule let doc "Ortho" claim the dental stem "orthodont".
  return (SPECIALTY_ALIASES[String(canonName).toLowerCase()] || [])
    .some(alias => docToks.some(d => d === alias || (alias.length >= 6 && d.startsWith(alias))));
}

// ─── LIVE availability (anchored to NOW, IST) ────────────────────────────────
// The model kept offering slots that had already passed (a doctor whose window
// ended at 1pm, offered at 2:23pm) because it had to compare weekly hours to the
// clock itself — LLMs are unreliable at that. So we compute it server-side, per
// turn, and hand the model a slot it can only ever offer if it's genuinely open.
const _DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function _istNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[m.weekday];
  let hh = parseInt(m.hour, 10); if (hh === 24) hh = 0;
  return { dow, mins: hh * 60 + parseInt(m.minute, 10) };
}
function _toMin(hhmm) { const [h, mm] = String(hhmm).split(':').map(Number); return h * 60 + (mm || 0); }
function _fmtMin(min) {
  const h = Math.floor(min / 60), mm = min % 60, ap = h < 12 ? 'AM' : 'PM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`;
}
// { today, earliestMin, label } for a doctor at the current IST moment. A window
// ─── IS THIS DOCTOR SHUT ON THE DAY `step` DAYS FROM NOW? ───────────────────
// firstFreeSlot has consulted CLOSED_DAYS since 2517a13. liveAvailability and
// soonestTodayLine did NOT, and they feed three of the four availability facts
// doctorLine puts in front of the model. The result was a single prompt line
// disagreeing with itself:
//
//   OFFER YEH: Sat 10:30 AM | ABHI available: AAJ 10:30 AM se 7:50 PM tak
//
// with today closed for Raksha Bandhan. OFFER YEH was right and everything
// beside it was wrong — and the prompt's own availability rule tells the model
// to offer from "ABHI available" and the soonest line when the caller says
// jaldi/abhi/aaj. So the caller who is in the biggest hurry got the answer that
// was refused at the commit.
//
// Same clinic-local date key as getTakenSlots and firstFreeSlot, for the same
// reason: a Date comparison here reintroduces the timezone drift those key
// formats exist to avoid.
function _closedOnStep(doctorId, step, base = new Date()) {
  return isClosed(CLOSED_DAYS, doctorId, _ymd(new Date(base.getTime() + step * 86400000)));
}


// only counts for "today" if it hasn't already ended.
function liveAvailability(d, now) {
  const wins = d.windows || [];
  // ─── TOMORROW IS COMPUTED HERE FOR THE SAME REASON TODAY IS ────────────────
  // LIVE, demo clinic, 2026-08-08 08:06 (a Saturday): "कल के लिए डॉ. अंजलि
  // देशमुख सुबह 10:00 से उपलब्ध हैं" — for a SUNDAY, on a schedule with no
  // Sunday window. The patient caught it two turns later ("अभी तो आपने कहा कि
  // कल सुबह दस बजे है available") and only then did she admit the clinic is
  // shut. The book path refused the write (slot_unavailable); the offer path
  // had already promised it.
  //
  // The cause is structural. The forward scan below only runs when the doctor
  // is CLOSED today, and at 08:06 on a Saturday she was open — so the model
  // received `AAJ 10:00 AM se 2:00 PM tak` and nothing else about any other
  // day, while the prompt pointed it at `weekly: Mon,…,Sat 10:00-14:00` for
  // future days. To refuse, it had to derive that today is Saturday, that
  // tomorrow is Sunday, and that Sunday is ABSENT from a list of open days.
  // Reasoning from an absence — which is exactly the arithmetic the header
  // above says LLMs are unreliable at, and exactly why today is computed here.
  // So: same treatment, stated as a positive dated fact.
  const tdow = (now.dow + 1) % 7;
  const tws = wins.filter(w => w.dow === tdow).sort((a, b) => _toMin(a.start) - _toMin(b.start));
  // CLOSED DAYS — the same fix as KAL, generalised past tomorrow. परसों,
  // "Monday" and "13 तारीख को" all still landed on `weekly:`, a list of OPEN
  // days where a closed day is present only by being absent. The arithmetic was
  // never the problem: on the live call she said "कल रविवार है और क्लिनिक बंद
  // रहता है" unprompted, once challenged. She simply did not CHECK before
  // offering, and an inference from an absence is skippable in a way a stated
  // fact is not. Naming the shut days positively removes the inference for
  // EVERY future day at ~11 characters per doctor — deliberately compact,
  // because ENABLE_ROSTER_SLICE exists to keep this text small at 25+ doctors.
  // null (not []) when no schedule is on file: unknown must never read as shut.
  const closedDays = !wins.length
    ? null
    : _DOWN.filter((_, d) => !wins.some((w) => w.dow === d));

  const tomorrow = !wins.length
    // No schedule on file is UNKNOWN, never "closed". A clinic mid-onboarding
    // must not have real bookings refused because its roster is half-entered.
    ? null
    // A dated closure reads exactly like a weekly one. The model is told a
    // POSITIVE fact — "KAL BAND" — rather than being left to infer a closure
    // from an absence, which this function's own header argues it cannot do.
    : (tws.length && !_closedOnStep(d.id, 1))
      ? { open: true,  label: `KAL (${_DOWN[tdow]}) ${_fmtMin(_toMin(tws[0].start))} se ${_fmtMin(_toMin(tws[tws.length - 1].end))} tak` }
      : { open: false, label: `KAL (${_DOWN[tdow]}) BAND` };

  if (!wins.length) return { today: false, earliestMin: null, tomorrow, closedDays, label: d.schedule || 'schedule not set' };
  // Today's windows are irrelevant if the clinic is shut today. Checked before
  // the window filter rather than after, so `today` is false and every consumer
  // — the label, earliestMin, and soonestTodayLine's filter — follows.
  const openToday = _closedOnStep(d.id, 0) ? [] :
    wins.filter(w => w.dow === now.dow && _toMin(w.end) > now.mins)
      .sort((a, b) => _toMin(a.start) - _toMin(b.start));
  if (openToday.length) {
    const w = openToday[0];
    const startMin = Math.max(_toMin(w.start), now.mins);
    const label = _toMin(w.start) <= now.mins
      ? `AAJ abhi se ${_fmtMin(_toMin(w.end))} tak`
      : `AAJ ${_fmtMin(_toMin(w.start))} se ${_fmtMin(_toMin(w.end))} tak`;
    return { today: true, earliestMin: startMin, tomorrow, closedDays, label };
  }
  for (let step = 1; step <= 7; step++) {
    const dow = (now.dow + step) % 7;
    if (_closedOnStep(d.id, step)) continue;   // shut that day, whatever the weekly window says
    const ws = wins.filter(w => w.dow === dow).sort((a, b) => _toMin(a.start) - _toMin(b.start));
    if (ws.length) {
      const day = step === 1 ? 'kal' : _DOWN[dow];
      return { today: false, earliestMin: null, tomorrow, closedDays, label: `${day} ${_fmtMin(_toMin(ws[0].start))} se` };
    }
  }
  return { today: false, earliestMin: null, tomorrow, closedDays, label: d.schedule || 'schedule not set' };
}
// ─── THE FIRST SLOT WE WOULD ACTUALLY ACCEPT ────────────────────────────────
// Everything above hands the model a RANGE and a list of what is gone, and asks
// it to reconcile the two. That is strictly better than the roster it replaced
// — which knew neither — but it is still a reconciliation the model can get
// wrong, and offering a taken slot is the exact failure being fixed.
//
// So the offer is computed here instead. Walk the doctor's own windows forward
// from now, in appointmentSlotMinutes steps, skipping anything already booked,
// and hand the model ONE concrete time it can say out loud. The window ends are
// already the OFFERABLE ends (tools/utils/offerWindow.js), so a slot that comes
// out of this walk satisfies every rule the accept side enforces.
//
// Returns null when nothing is free inside the horizon — the model then falls
// back to the range, which is where it was before this existed.
// The holiday rule, shared with the accept side (tools/utils/availability.js).
// Not a copy of it — the same function. See tools/utils/dayClosure.js.
const { closedDaySet, isClosed } = require('./tools/utils/dayClosure');
// A complaint asserted about the caller that the caller never stated, and a
// booking reason the caller's words do not support. See symptomGuard.js.
const { unsupportedAttributions, reasonSupported, assertedClauses } = require('./symptomGuard');
const { toDevanagari } = require('./translit');

const SLOT_SEARCH_DAYS = 8;
function _ymd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function firstFreeSlot(d, now = _istNow()) {
  const wins = d.windows || [];
  if (!wins.length) return null;
  const slot = config.appointmentSlotMinutes;
  const taken = new Set((d.taken || []).map((t) => t.key));
  const base = new Date();

  for (let step = 0; step < SLOT_SEARCH_DAYS; step++) {
    const dow = (now.dow + step) % 7;
    const dayWins = wins.filter((w) => w.dow === dow)
      .sort((a, b) => _toMin(a.start) - _toMin(b.start));
    if (!dayWins.length) continue;
    // Clinic-local calendar date for this step, so the key matches getTakenSlots.
    const ymd = _ymd(new Date(base.getTime() + step * 86400000));
    // The clinic is shut that day. The accept side has always refused these;
    // until now the offer side did not know, so Ritu named a time on a holiday
    // and the booking commit turned it down.
    if (isClosed(CLOSED_DAYS, d.id, ymd)) continue;
    for (const w of dayWins) {
      const start = _toMin(w.start), end = _toMin(w.end); // end = last OFFERABLE start
      for (let m = start; m <= end; m += slot) {
        // Today only: never offer a time that has already passed. A small lead
        // keeps us from proposing a slot the caller cannot physically reach.
        if (step === 0 && m < now.mins + SLOT_LEAD_MIN) continue;
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        if (taken.has(`${ymd} ${hhmm}`)) continue;
        const when = step === 0 ? 'AAJ' : step === 1 ? 'KAL' : _DOWN[dow];
        return { ymd, hhmm, minutes: m, dayOffset: step, label: `${when} ${_fmtMin(m)}` };
      }
    }
  }
  return null;
}
// Don't offer a slot the caller cannot get to. Minutes of lead time on today's
// slots only; future days are unaffected.
const SLOT_LEAD_MIN = parseInt(process.env.SLOT_LEAD_MINUTES || '30', 10);

// One clinic-wide line the model offers when the patient wants the soonest.
// SPECIALTY-AWARE SOONEST POOL (live 2026-07-26, call 56d6db79). A caller with
// a HEADACHE asked "कोई और doctor नहीं है, जल्दी से जल्दी दिखाना है" and Ritu
// offered "डॉ. अंजली देशमुख (डेंटिस्ट)" — because this list was ranked purely by
// who was free soonest, with no regard for what the patient had. He pushed back
// ("मैं dentist को क्यों दिखाऊँ") and she recovered, but a patient who did not
// know better would have been booked with the wrong specialist.
// Urgency must never override suitability: when the roster slice has already
// narrowed the doctors to the complaint, rank SOONEST WITHIN THAT SET. Falls
// back to the full roster only when there is no slice (a caller who named no
// symptom, e.g. a pure "book me anything today").
function soonestPool(context) {
  const slice = context && context.rosterSlice;
  const docs = slice && Array.isArray(slice.doctors) && slice.doctors.length
    ? slice.doctors
    : ROSTER.doctors;
  return docs;
}

function soonestTodayLine(docs) {
  const now = _istNow();
  const avail = (docs || []).filter(d => !d.is_on_call)
    .map(d => ({ d, av: liveAvailability(d, now) }))
    .filter(x => x.av.today)
    .sort((a, b) => a.av.earliestMin - b.av.earliestMin);
  if (!avail.length) return 'AAJ koi doctor available NAHI — sabse jaldi AGLA available din offer kar (kisi doctor ka aaj ka time offer MAT kar).';
  return avail.map(x => `${x.d.name} (${x.av.label})`).join(' · ');
}

// Per-doctor detail line — availability computed LIVE (see liveAvailability).
function doctorLine(d) {
  if (d.is_on_call) return `- ${d.name} (${d.specialty}) — on-call specialist; book mat kar, callback lagao.`;
  const fee = d.fee_inr ? `, fees ₹${d.fee_inr}` : '';
  const av = liveAvailability(d, _istNow());
  const weekly = d.schedule ? ` | weekly: ${d.schedule}` : '';
  // KAL is stated, not inferred. Placed BEFORE weekly: so the dated fact is the
  // nearer antecedent when the model answers a "कल" question.
  const kal = av.tomorrow ? ` | ${av.tomorrow.label}` : '';
  // Only when there ARE closed days — a seven-day doctor costs zero extra text.
  const band = (av.closedDays && av.closedDays.length) ? ` | BAND: ${av.closedDays.join(',')}` : '';
  // ─── SLOTS ALREADY GONE ────────────────────────────────────────────────────
  // Live 2026-08-09, call 4843c8bc: Ritu offered Dr. Manoj Deo "कल शाम 5:00",
  // the caller said "कर दो", and the write was refused — that Monday 17:00 had
  // been booked two days earlier. She apologised, repeated the same canned
  // refusal three times, and the caller had to argue her into naming the real
  // window ("क्या कल शाम पाँच बजे आपने तो कहा है"). The offer side knew the
  // doctor's HOURS and nothing about which slots were gone.
  //
  // Stated positively, like BAND above and for the same reason: a taken slot
  // the model must infer from an absence is a check it can skip.
  const taken = (d.taken && d.taken.length) ? ` | GAYA (mat offer): ${d.taken.map(t => t.label).join(', ')}` : '';
  // The one time we would actually accept, computed rather than reconciled.
  // Placed FIRST so it is the nearest antecedent when the model picks a slot to
  // speak; the ranges after it stay for "when else is he free?" questions.
  const free = firstFreeSlot(d);
  const offer = free ? `OFFER YEH: ${free.label} | ` : '';
  return `- ${d.name} (${d.specialty})${fee} — ${offer}ABHI available: ${av.label}${kal}${band}${taken}${weekly}`;
}

function sliceRoster(conversationHistory, context = {}) {
  // Rebuild the full roster text LIVE every turn (not the boot-baked ROSTER.text)
  // so availability is anchored to the current moment, not to server-start time.
  const full = { sliced: false, text: (ROSTER.doctors || []).map(doctorLine).join('\n') };
  if (!ENABLE_ROSTER_SLICE) return full;
  const docs = ROSTER.doctors || [];
  if (docs.length <= 3) return full;
  // Prefer the call-lifetime accumulator (context.patientTextAll, kept by
  // callHandler) over the trimmed history: on a long call the original
  // complaint falls off MAX_CONVERSATION_HISTORY and a history-only union
  // would NARROW mid-call — demoting the doctor being booked to the index.
  // The accumulator makes the union truly monotone for the whole call.
  const patientText = (context.patientTextAll && context.patientTextAll.trim())
    ? context.patientTextAll
    : (conversationHistory || [])
        .filter(m => m && m.role === 'user').map(m => m.content || '').join(' \n ');
  if (!patientText.trim()) return full;
  // ─── A WHOLE-CLINIC QUESTION CANNOT BE ANSWERED FROM A SLICE ──────────────
  // The slice keeps the matching specialists in DETAIL and demotes everyone else
  // to a name-only index the prompt explicitly disclaims — "inke time/fees tujhe
  // NAHI pata". That is right for "I need a dentist" and wrong for "is anyone
  // free right now", where the answer is precisely the hours of the doctors the
  // index just hid.
  //
  // LIVE CALL 0a0f0d8f3c4cc14f2927b8adb06e1a85, Wed 2026-08-05 11:03 IST:
  //     patient  "कोई अभी doctor available है तुरंत"
  //     Ritu     "अभी के लिए Dr. Manoj Deo ही सबसे जल्दी उपलब्ध हैं, शाम 5:00 से"
  // NINE doctors were mid-session at that moment (Anjali Deshmukh 10:00-14:00,
  // and eight more on 10:00-13:00). diagnostics.rosterSlice recorded 2 of 25 in
  // detail. The model answered correctly from what it was given; what it was
  // given was two doctors.
  //
  // Also live: 3312d865 ("अभी कोई नहीं है क्या, emergency में दिखाना है जल्दी" —
  // offered Monday, 56 hours out, with sixteen windows open that same Saturday)
  // and 5b261b844e ("আজকে কোনো ডাক্তার আছে?").
  //
  // THE ASYMMETRY DECIDES THE DESIGN. Returning the full roster costs tokens and
  // a little latency. Returning a slice costs a patient the appointment they
  // called for. So this errs toward full: a false positive is a longer prompt, a
  // false negative is call 0a0f0d8f again.
  if (WHOLE_CLINIC_AVAILABILITY_RE.test(patientText)) return full;

  // Transliterate first, as the guard and the intake probe do — raw Gujarati /
  // Kannada script mapped to nothing here, so those callers got no slice.
  const specs = specialtiesForSymptom(String(patientText || '') + ' ' + toDevanagari(String(patientText || '')));
  if (!specs.length) return full;
  // Per-specialty fail-safe: if ANY named specialty has no doctor here, the
  // model must see the FULL roster to answer honestly ("hamare paas eye
  // specialist nahi hai") — a partially-served union must not hide that.
  const inSlice = [];
  for (const s of specs) {
    const matched = docs.filter(d => specialtyMatches(s, d.specialty));
    if (!matched.length) return full;
    for (const d of matched) if (!inSlice.includes(d)) inSlice.push(d);
  }
  const rest = docs.filter(d => !inSlice.includes(d));
  const text =
    inSlice.map(doctorLine).join('\n') +
    (rest.length
      ? `\n\nBAAKI DOCTORS (sirf naam-specialty ka index — inke time/fees tujhe NAHI pata; patient inhe naam se maange toh haan bol, unka pasandida time pooch — booking par system time verify kar lega):\n` +
        // On-call marker MUST survive into the index — without it the model
        // books an on-call specialist, hits slot-refusals forever, and never
        // routes to the callback flow.
        rest.map(d => `${d.name} (${d.specialty}${d.is_on_call ? ' — ON-CALL: book mat kar, callback lagao' : ''})`).join(' · ')
      : '');
  // `doctors` is what soonestPool reads to rank the soonest-available line WITHIN
  // the complaint. It was absent from this object from the day the specialty-aware
  // pool was written, so the lookup was undefined on every turn and silently fell
  // back to the full roster — the exact behaviour that fix was meant to end.
  // Live cost, 2026-07-30 call b23c97d51be5: a slice of Neurology+Gastroenterology
  // still produced "Dr. Alka Ranade (MD Medicine) is available until 8:00 tonight",
  // an index doctor whose hours the prompt tells the model it does not know.
  // Regression: tests/test-slice-soonest-leak.js.
  return { sliced: true, specs, count: inSlice.length, total: docs.length, text, doctors: inSlice };
}

// Roster is loaded once at boot (preloadRoster) and reused every turn.
let ROSTER = { text: '', doctors: [] };

// Treatments live beside the roster and are loaded by the same call. Unlike
// taken slots, a price list does not change mid-shift — a clinic edits it on
// the desk and the next deploy or the next boot picks it up. Same staleness
// profile as doctors and schedules, so the same boot-once treatment.
let TREATMENTS = { text: '', treatments: [] };

// Doctor-days the clinic has closed (holidays, leave). Refreshed on the taken-
// slot TTL, NOT baked at boot: a clinic adds Raksha Bandhan from the desk on a
// working morning. A Set of `${doctorId}|${YYYY-MM-DD}`; empty means "nothing
// closed", which is also what a failed load leaves behind — and that failure
// direction is the pre-existing behaviour, not a new risk.
let CLOSED_DAYS = new Set();

// The clinic's fee policy and its default doctor. Boot-stable like the roster:
// a clinic does not change its consultation fee mid-shift, and when it does, a
// deploy or a restart is the honest place for that to take effect.
// null throughout means "this clinic has not answered", and the prompt then
// carries no fee block at all — byte-identical to before migration 015.
let FEE_POLICY = null;

// The clinic's own written answers (setup form section E3). Boot-loaded beside
// the roster and the treatments list, and empty by default — a clinic that has
// written none renders no block, so the prompt is unchanged.
let FAQS = { text: '', faqs: [] };

// ─── DESK EDITS REACH RITU WITHOUT A RESTART (2026-09-14, module 3) ─────────
// The boot-once roster meant a doctor added, a timing changed, a fee or FAQ
// edited on the desk was invisible to Ritu until the next deploy. Now the
// roster, treatments, FAQs and fee policy are re-read on ROSTER_TTL_MS
// (default 60 s), off the latency path — the same shape as the taken-slot
// refresh below: called at call start and at each WhatsApp turn, collapsed
// onto one in-flight load, and a failure keeps the LAST GOOD copy. An empty
// roster from the database never replaces a non-empty one (getDoctorsRoster
// answers empty on error too, and a clinic does not lose every doctor mid-day).
const ROSTER_TTL_MS = parseInt(process.env.ROSTER_TTL_MS || '60000', 10);
let _rosterClinicId = null;
let _rosterFetchedAt = 0;
let _rosterInFlight = null;
const rosterSignature = (r) => JSON.stringify((r && r.doctors || []).map(({ taken, ...d }) => d)); // eslint-disable-line no-unused-vars

async function refreshRoster({ force = false } = {}) {
  if (!_rosterClinicId) return false;
  if (!force && Date.now() - _rosterFetchedAt < ROSTER_TTL_MS) return false;
  if (_rosterInFlight) return _rosterInFlight;
  _rosterInFlight = (async () => {
    try {
      const next = await db.getDoctorsRoster(_rosterClinicId);
      if (!next || !Array.isArray(next.doctors)) return false;
      if (!next.doctors.length && (ROSTER.doctors || []).length) {
        console.warn('[LEAN] roster refresh returned no doctors — keeping the last good roster');
        _rosterFetchedAt = Date.now();
        return false;
      }
      const changed = rosterSignature(next) !== rosterSignature(ROSTER);
      // Taken slots live on the doctor objects; carry them over by id so a
      // refresh never blanks them between two taken-slot refreshes.
      for (const d of next.doctors) {
        const old = (ROSTER.doctors || []).find((o) => o.id === d.id);
        if (old && old.taken) d.taken = old.taken;
      }
      ROSTER = next;
      try { TREATMENTS = await db.getTreatments(_rosterClinicId); } catch (e) { console.warn('[LEAN] treatments refresh failed (keeping last):', e.message); }
      try { FAQS = await db.getClinicFaqs(_rosterClinicId); } catch (e) { console.warn('[LEAN] FAQ refresh failed (keeping last):', e.message); }
      try { FEE_POLICY = await db.getClinicFeePolicy(_rosterClinicId); } catch (e) { console.warn('[LEAN] fee policy refresh failed (keeping last):', e.message); }
      _rosterFetchedAt = Date.now();
      if (changed) {
        console.log(`[LEAN] Roster refreshed from the desk: ${next.doctors.length} doctor(s) — ${next.doctors.map((d) => d.name).join(', ')}`);
        // A new doctor's taken slots are unknown until the next taken refresh — do it now.
        refreshTakenSlots({ force: true }).catch(() => {});
      }
      return changed;
    } catch (err) {
      console.warn('[LEAN] roster refresh failed (keeping the last good roster):', err.message);
      return false;
    } finally {
      _rosterInFlight = null;
    }
  })();
  return _rosterInFlight;
}

async function preloadRoster(clinicId) {
  _rosterClinicId = clinicId;
  ROSTER = await db.getDoctorsRoster(clinicId);
  try {
    TREATMENTS = await db.getTreatments(clinicId);
    if (TREATMENTS.treatments.length) {
      console.log(`[LEAN] Treatments loaded: ${TREATMENTS.treatments.length}`);
    }
  } catch (err) {
    // A clinic with no treatments table entry is the NORMAL case for a GP
    // clinic. Never let it cost the roster.
    console.error('[LEAN] treatments load failed (Ritu will say the clinic confirms):', err.message);
    TREATMENTS = { text: '', treatments: [] };
  }
  try {
    FAQS = await db.getClinicFaqs(clinicId);
    if (FAQS.faqs.length) console.log(`[LEAN] Clinic FAQs loaded: ${FAQS.faqs.length}`);
  } catch (err) {
    console.error('[LEAN] FAQ load failed (Ritu will offer to confirm instead):', err.message);
    FAQS = { text: '', faqs: [] };
  }
  try {
    FEE_POLICY = await db.getClinicFeePolicy(clinicId);
    if (FEE_POLICY) {
      console.log(`[LEAN] Fee policy: follow-up free ${FEE_POLICY.followupFreeDays ?? '—'}d then ₹${FEE_POLICY.followupFeeInr ?? '—'}; default doctor ${FEE_POLICY.defaultDoctorName || '—'}`);
    }
  } catch (err) {
    console.error('[LEAN] fee policy load failed:', err.message);
    FEE_POLICY = null;
  }
  _takenFetchedAt = Date.now();
  _rosterFetchedAt = Date.now();
  console.log(`[LEAN] Roster preloaded: ${ROSTER.doctors.length} doctor(s)${ROSTER.doctors.length ? ' — ' + ROSTER.doctors.map(d => d.name).join(', ') : ''}`);
  return ROSTER;
}

// ─── TAKEN SLOTS GO STALE; DOCTORS AND SCHEDULES DO NOT ─────────────────────
// The roster is deliberately baked once at boot — a doctor's weekly hours do
// not change mid-shift. Bookings do, in both directions: a cancellation frees a
// slot, another caller takes one. A boot-baked taken list would therefore start
// LYING within minutes, hiding real capacity as often as it prevents a clash.
//
// So the taken list alone is refreshed on a short TTL, off the latency path.
// The greeting is already playing when a call triggers this, and a failure is
// swallowed — offering blind is exactly the behaviour that shipped before.
const TAKEN_TTL_MS = parseInt(process.env.ROSTER_TAKEN_TTL_MS || '45000', 10);
let _takenFetchedAt = 0;
let _takenInFlight = null;

async function refreshTakenSlots({ force = false } = {}) {
  const docs = ROSTER.doctors || [];
  if (!docs.length) return;
  if (!force && Date.now() - _takenFetchedAt < TAKEN_TTL_MS) return;
  // Collapse concurrent callers onto one query — several calls can land inside
  // the same TTL window and there is no reason to ask the database N times.
  if (_takenInFlight) return _takenInFlight;
  _takenInFlight = (async () => {
    try {
      const ids = docs.map((d) => d.id);
      // One round-trip each, in parallel: both are the same kind of fact — DB
      // state that moves during a working day and must not be boot-frozen.
      const [byDoc, exceptions] = await Promise.all([
        db.getTakenSlots(ids),
        db.getUpcomingExceptions(ids, SLOT_SEARCH_DAYS + 1).catch((e) => {
          // A clinic with no exceptions table entry is the normal case. Never
          // let an empty holiday list cost the taken-slot refresh.
          console.error('[LEAN] exception load failed (offering without holidays):', e.message);
          return [];
        }),
      ]);
      for (const d of docs) d.taken = byDoc[d.id] || [];
      CLOSED_DAYS = closedDaySet(exceptions);
      if (CLOSED_DAYS.size) console.log(`[LEAN] closed doctor-days in view: ${CLOSED_DAYS.size}`);
      _takenFetchedAt = Date.now();
    } catch (err) {
      console.error('[LEAN] taken-slot refresh failed (offering blind):', err.message);
    } finally {
      _takenInFlight = null;
    }
  })();
  return _takenInFlight;
}

// ─── THE EXAMPLE DATE MUST BE TODAY, NOT A DATE FROM WHENEVER IT WAS TYPED ──
// The two sentinel examples below carried "2026-06-22T18:30:00+05:30" as a
// literal — a date that was current when the line was written and was two
// months stale by August. The prompt therefore showed the model a correct
// CURRENT DATE line and, a few lines later, an example dateTime from a
// different month with the SAME day-of-month.
//
// Nothing proves that caused a specific misbooking, and I am not claiming it
// did. What is certain is that it drifts further every day it ships, that the
// example is the shape the model copies, and that a date example which is
// wrong by construction has no business sitting next to the rule telling the
// model to compute dates from the current line.
//
// 18:30 is kept because it is a plausible clinic hour and reads as an example
// rather than as the answer; only the DATE follows the clock.
function istExampleDateTime() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return `${p}T18:30:00+05:30`;
}

function istDateLine() {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  });
  return fmt.format(new Date());
}

// Verbatim emergency line per language — quoted in the prompt so the model
// never improvises the 108 instruction, and the reply stays IN the pinned
// language (a Devanagari reply on a pinned call would also evict the pin).
const EMERGENCY_LINES = {
  'hi-IN': 'यह इमरजेंसी है। अभी 108 कॉल करें या हॉस्पिटल जाएं।',
  'mr-IN': 'ही इमरजन्सी आहे. लगेच 108 ला कॉल करा किंवा हॉस्पिटलला जा.',
  'en-IN': 'This is an emergency. Please call 108 right away or go to the nearest hospital.',
  'kn-IN': 'ಇದು ಎಮರ್ಜೆನ್ಸಿ. ಈಗಲೇ 108 ಗೆ ಕರೆ ಮಾಡಿ ಅಥವಾ ಆಸ್ಪತ್ರೆಗೆ ಹೋಗಿ.',
  'pa-IN': 'ਇਹ ਐਮਰਜੈਂਸੀ ਹੈ। ਹੁਣੇ 108 ਨੂੰ ਕਾਲ ਕਰੋ ਜਾਂ ਹਸਪਤਾਲ ਜਾਓ।',
  'ta-IN': 'இது அவசர நிலை. உடனே 108-ஐ அழைக்கவும் அல்லது மருத்துவமனைக்குச் செல்லவும்.',
  'te-IN': 'ఇది ఎమర్జెన్సీ. వెంటనే 108కి కాల్ చేయండి లేదా హాస్పిటల్‌కి వెళ్ళండి.',
  'bn-IN': 'এটা ইমার্জেন্সি। এখনই 108-এ কল করুন বা হাসপাতালে যান।',
  'gu-IN': 'આ ઇમરજન્સી છે. હમણાં જ 108 પર કૉલ કરો અથવા હોસ્પિટલ જાઓ.',
  'ml-IN': 'ഇത് എമർജൻസിയാണ്. ഉടനെ 108-ൽ വിളിക്കൂ അല്ലെങ്കിൽ ആശുപത്രിയിൽ പോകൂ.',
  'od-IN': 'ଏହା ଏମରଜେନ୍ସି। ଏବେ 108 କୁ କଲ୍ କରନ୍ତୁ କିମ୍ବା ହସ୍ପିଟାଲ୍ ଯାଆନ୍ତୁ।'
};

function buildSystemPrompt(context = {}) {
  const clinicName = config.greetingClinicName || 'क्लिनिक';
  // ── THE ONLY CHANNEL SWITCH IN THIS FILE ────────────────────────────────────
  // WhatsApp runs THIS brain, not a second one — two receptionists drift and
  // every safety guard would have to be built twice. But a handful of lines here
  // are physics of speech, not policy: an 8-12 word cap is a TTS-duration rule,
  // "kabhi mat bolo" is meaningless when the model is writing, and one line
  // flatly asserts she cannot send anything on WhatsApp.
  //
  // Voice passes no `channel`, so isText is false and EVERY existing voice byte
  // is unchanged. That property is what makes this safe to ship.
  // Keep this delta minimal — every divergence is future drift.
  const isText = context.channel === 'whatsapp';
  const slice = context.rosterSlice; // set by generateLeanRaw/getLeanResponseStream
  const roster = (slice && slice.text) || ROSTER.text || '(कोई डॉक्टर लोड नहीं हुआ)';

  // ─── A CLINIC WITH NO BOOKABLE DOCTOR IS A REAL STATE, NOT AN ERROR ────────
  // It is the state EVERY newly onboarded clinic starts in: the deploy is live
  // and the phone number is routed before anyone has entered a doctor.
  //
  // Tested against the real model on a virgin database, this was the reply:
  //   "आज के लिए कोई डॉक्टर उपलब्ध नहीं हैं। क्या मैं आपके लिए कल का समय देखूँ?"
  // She did NOT invent a doctor — the anti-fabrication rule held. But tomorrow
  // is empty too, and so is the day after, so the caller is offered a date that
  // can never exist and every future call repeats it. A dead end that sounds
  // like progress is worse than an honest no.
  //
  // The cause is that the roster being empty changed the LIST while leaving the
  // INSTRUCTIONS ("offer the soonest", "offer the next available day") intact.
  // Same shape as the offer/accept split fixed in ae16022: one half of the
  // system knew something the other half was never told.
  //
  // ON-CALL DOCTORS DO NOT COUNT. doctorLine already says "book mat kar,
  // callback lagao" for them — a roster of nothing but on-call specialists has
  // no bookable slot either, and REQUEST_CALLBACK is already where that path
  // ends. Deciding it here, in code, keeps it out of the model's judgement.
  const noBookableDoctor = !(ROSTER.doctors || []).some((d) => !d.is_on_call);
  const hindiInCall = !!context.hindiInCall; // system already detected Hindi this call
  // Multilingual pin (flag-gated upstream): a non-hi/mr language auto-detected
  // by Sarvam and pinned for the call. Overrides the hi/mr language rule below.
  const pinnedLang = context.languageCode && config.languageNames
    ? config.languageNames[context.languageCode] : null;
  // Returning patients are greeted BY NAME (callHandler sets patientName from the
  // caller-id lookup before turn 1). Without this line the model followed FLOW
  // step 1 and asked "आपका नाम?" right after greeting "Siddharth जी" — a live
  // patient called it out ("आपने मेरा नाम बोला तो").
  const knownName = (context.patientName || '').trim();
  return `Tu ${clinicName} ki AI receptionist Ritu hai — गरम, खुशमिजाज़, caring, professional, female (मैं करती हूँ). Patient ko lage ki koi apna, fikr karne wala insaan baat kar raha hai — na ki ek thanda form.

${noBookableDoctor ? `DOCTORS — is clinic mein ABHI koi bookable doctor set nahi hua hai. Yeh khaali list nahi, yeh CONFIGURATION adhoori hai.
⚠ Appointment offer KABHI mat kar. "kal dekh leti hoon", "kal ka time dekhun?", "aage ka din dekhti hoon" — in mein se kuch bhi MAT bol: kal bhi koi doctor nahi hoga, aur patient ko roz wahi jawab milega.
SAHI RAASTA — seedha aur imaandaar: patient ko bata ki abhi appointment book nahi ho pa rahi, uska naam+number le, aur USI turn mein REQUEST_CALLBACK emit kar taaki clinic use call kare. Uske baad clinic ka address/timing jaisa jo pooche wo bata sakti hai.
⚠ Bina REQUEST_CALLBACK ke "callback laga deti hoon" KABHI mat bol.`
: `DOCTORS — ${context.rosterSlice && context.rosterSlice.sliced
  ? `patient ki takleef ke hisaab se SABSE-FIT doctor upar poori detail mein hain; baaki sirf naam-specialty index mein. In sab ke BAHAR koi doctor/naam/time KABHI mat bana. Index-wale doctor ka time/fees tu nahi jaanti — guess KABHI mat kar.`
  : `yeh POORI list hai. SIRF inhi mein se doctor bol; list ke bahar koi doctor/naam/time KABHI mat bana:`}
${roster}

⏱ AAJ SABSE JALDI AVAILABLE (ABHI ke hisaab se, jaldi wala pehle) — patient "jaldi / abhi / जितना जल्दी हो / ASAP / turant" maange toh ISI list se SABSE PEHLA doctor offer kar (kisi doctor ka "ABHI available" jo aaj nikal chuka use aaj ke liye offer MAT kar). ⚠ YE LIST PEHLE SE HI patient ki takleef ke hisaab se chhaanti hui hai — isse BAAHAR ka doctor jaldi free ho tab bhi mat offer kar: ${soonestTodayLine(soonestPool(context))}`}

${feePolicyBlock(FEE_POLICY)}${TREATMENTS.text ? `TREATMENTS — yeh POORI list hai. Price, sessions, downtime SIRF isi list se bol; list ke bahar koi treatment/price/claim KABHI mat bana. Patient koi aisa treatment poochhe jo list mein NAHI hai: "woh hum karte hain ya nahi, clinic confirm karke bata dega" bol — GUESS mat kar. Price mein NUMBER na likha ho toh jo likha hai HUBAHU wahi bol — apna koi number KABHI mat laga.
⚠ Tu treatment BOOK aur BATA sakti hai — SALAH nahi de sakti. "Mere liye theek rahega?", "meri skin pe chalega?", "pregnancy mein safe hai?" jaise sawaal par: "yeh doctor hi dekh kar bata payenge, appointment le lete hain" — koi medical raay KABHI mat de, chahe list mein notes likhe hon.
${TREATMENTS.text}

` : ''}${FAQS.text ? `CLINIC KI JAANKARI — yeh jawab clinic ne KHUD likhe hain. In sawaalon ka jawab SIRF isi list se, HUBAHU — apne se kuch add ya badal KABHI mat kar. Jo sawaal na is list mein hai aur na upar DOCTORS / TREATMENTS / FEES / ADDRESS mein — uska jawab: "yeh main confirm karke bata dungi" — GUESS mat kar.
${FAQS.text}

` : ''}LANGUAGE (sabse zaroori — patient ki bhaasha se MATCH kar): ${pinnedLang
  ? `Patient ${pinnedLang.toUpperCase()} mein baat kar raha hai — apni POORI reply ${pinnedLang.toUpperCase()} mein de, usi bhaasha ki apni script mein. Hindi/Marathi mat bol jab tak patient khud na bole. Doctor/clinic ke naam waise hi rehne de. NEECHE ke saare Hindi/Marathi quoted examples SIRF style ke liye hain — unka text KABHI copy mat kar; empathy, confirm, goodbye, aadar-shabd (जी nahi — ${pinnedLang} ka aadar-roop) sab ${pinnedLang.toUpperCase()} mein.`
  : hindiInCall
  ? 'Patient HINDI mein baat kar raha hai — apni poori reply HINDI (Devanagari) mein de. Marathi mat bol.'
  : 'Patient MARATHI mein baat kar raha hai — apni poori reply MARATHI (Devanagari) mein de. Patient ki bhaasha turn-by-turn follow kar: agar patient POORI line Hindi ya English mein bole toh usi turn se us language mein jawab de — patient ko "Hindi mein boliye" kehna na pade. Ek-do Hindi shabd ya mixed line par Marathi mat chhod.'} (Purani "ek call = ek language, beech mein mat badlo" wali soch GALAT hai — hamesha patient ki current language follow kar.) ${context.replyScript === 'latin'
  ? 'SCRIPT — patient ne LATIN akshar mein likha hai, toh tu bhi LATIN mein hi likh (Hinglish): "Namaste! Main Ritu, kaise madad karu?" Bhaasha wahi, sirf script Latin. Doctor ka naam, time aur fees bhi Latin mein. Devanagari MAT likh — patient ne Latin mein likha hai aur woh reply PADH raha hai.'
  : 'Reply ek hi script mein: Hindi→Devanagari, Marathi→Devanagari, English→Latin. Romanized Hindi (aapka/kya/baje) KABHI nahi.'}${context.multilingual ? `
TERI BHAASHAAYEIN: tu Hindi, Marathi, English, Kannada, Punjabi, Tamil, Telugu, Bengali, Gujarati, Malayalam aur Odia — YE SAB bol sakti hai. Patient kisi inmein se bhaasha maange toh khushi se haan bol ("जी बिल्कुल!") — system khud switch kar dega, tu bas agli reply usi bhaasha mein de. KABHI mat bol ki tujhe inmein se koi bhaasha nahi aati.` : ''}

TONE: ek ASLI, efficient clinic receptionist jaisi — polite, warm, par BRISK aur kaam-focused. Jaise achhi front-desk wali jiske paas patients ki line hai: madad karti hai, par jaldi aur seedha. Thandi/robotic bhi nahi — par over-emotional / naatak / "sympathy hotline" bhi KABHI nahi.
FORMAT (ACKNOWLEDGE-fir-ACT, CHHOTA + BRISK): reply CHHOTI + seedhi — ${isText ? "2-3 chhoti lines (yeh text hai, patient padh raha hai)" : "1 chhota vaakya, ~8-12 shabd MAX"}. Pehle 1-2 shabd mein acknowledge ("अच्छा", "ठीक है जी", "समझ गई"), PHIR seedha kaam (doctor/slot/sawaal). Ek baar mein SIRF EK sawaal. Slot offer karte waqt SIRF EK window. Naam+"जी" sirf greet/confirm/bye par (har line mein nahi). To-the-point raho — na sookha hukum, na lambi bhaavuk baat.

RECEPTIONIST-REALISM (SABSE ZAROORI — pichhli baar over-empathy fake/bot lagi):
- Dard/pareshani par SIRF EK BAAR, poore call mein, ek CHHOTA neutral acknowledgment — "अच्छा, पेट दर्द।" ya "समझ गई जी।" — PHIR SEEDHA kaam (doctor offer). "बहुत दर्द हो रहा होगा", "चिंता मत कीजिए", "बहुत तकलीफ़ हो रही होगी", "मैं समझ सकती हूँ आप परेशान हैं" jaisi OVER-EMPATHY / bhaavuk naatak KABHI mat bol — yeh fake aur bot-jaisa lagta hai, asli receptionist aisa nahi karti.
- Empathy/sympathy line DOBARA KABHI nahi — ek baar halka acknowledge, phir har turn EFFICIENT receptionist. Same line repeat karna sabse zyada robotic lagta hai.
- Banawati josh / exclamation-baazi ("बहुत बढ़िया!!") KABHI nahi. Buri khabar par calm + factual, cheerful nahi.
- Baar-baar "माफ़ कीजिए"/"sorry" MAT. Opener ghumao — ek hi ghisa-pita line nahi.

FLOW:
1. TAKLEEF PEHLE — greeting mein wahi poochha gaya hai. Patient dard/pareshani bataye toh SIRF ek CHHOTA neutral acknowledgment PATIENT KI BHAASHA MEIN ("अच्छा, पेट दर्द।" / "समझ गई जी।" / Marathi: "बरं, पोटदुखी.") — PHIR naam (step 2). Bhaavuk over-empathy ("बहुत दर्द हो रहा होगा", "चिंता मत कीजिए", "तकलीफ़ हो रही होगी") KABHI mat bol — real receptionist seedha kaam pe aati hai.
2. ${knownName
    ? `Patient ka naam PEHLE SE PATA hai: ${knownName} (returning patient, greeting mein bola ja chuka hai). Naam KABHI MAT poochh — seedha "${knownName} जी" bol.`
    : `AB naam pooch — takleef acknowledge karne ke BAAD, us hi reply mein: "अच्छा, पेट दर्द। आपका नाम बता दीजिए जी?" Naam milte hi agle jawab mein use kar ("अच्छा सिद्धार्थ जी…") taaki galat suna ho toh patient theek kar de. Patient ne apna naam KHUD pehle hi bol diya ho toh DOBARA mat poochh.`}
${config.previsitIntake
  ? `3. HISTORY (booking se PEHLE — doctor ke pre-visit read ke liye), sirf jab koi takleef/symptom ho: 1-2 CHHOTE sawaal, ek baar mein SIRF EK, patient ki bhaasha mein — pehle "ये तकलीफ़ कब से है जी?", phir agle turn "कोई दवाई चल रही है या कोई एलर्जी?". 2 sawaal MAX — questionnaire NAHI. Advice/diagnosis/dawai-ka-naam KABHI mat de (sirf poochh). Patient jaldi mein ho ya "बस बुक कर दो"/decline kare toh BILKUL mat khich — turant step 4 (doctor+booking) pe aa. Pure booking/inquiry/reschedule (koi symptom nahi) par history SKIP kar.`
  : `3. HISTORY MAT POOCH — is clinic mein pre-visit sawaal (kab se, dawai, allergy) NAHI poochhe jaate; takleef/treatment aur naam ke baad seedha doctor aur time pe aa. Doctor khud poochhenge.`}
4. Ab takleef+history ke hisaab se list se EK sabse-fit doctor chun — jiski specialty match kare; saaf na ho toh general/pehla in-house doctor. ${isText ? "naam + specialty + 2 availability-windows + \"बुक करूँ?\" ek hi message mein." : "SIRF naam + EK availability-window + \"बुक करूँ?\"."} Specialty/fees/saare slots ek saath MAT bol (patient poochhe tabhi).
5. Patient SAAF haan bole ("हाँ"/"ठीक है"/"कर दो"/"जी करो") → BOOK_APPOINTMENT emit kar (us doctor ka naam + poora ISO datetime). Sirf "हम्म"/"अच्छा" jaisa HALKA hunkara mile toh book MAT kar — pehle EK chhota confirm poochh ("पक्का कर दूँ जी?"), saaf haan ke baad hi emit kar. Jab BOOK_APPOINTMENT emit kare, tera spoken text HO-CHUKA (past-tense) confirmation ho — jaise "हो गया जी! [doctor] जी के साथ बुक कर दिया है." — "बुक करूँ?"/"पक्का कर दूँ?" DOBARA MAT pooch (booking ho chuki hai).
   ⚠ SABSE ZAROORI (booking ka sabse bada niyam): "हो गया / बुक कर दिया / पक्का कर दिया" ya koi bhi DONE-confirmation bolne se PEHLE, USI hi reply mein BOOK_APPOINTMENT sentinel (nayi line par) LIKHNA HI HAI. Bina sentinel ke DONE-confirmation KABHI mat bol — warna booking asli mein NAHI hoti aur patient ko galat lagta hai. Confirmation aur sentinel HAMESHA saath.
6. Booking ke baad warmly "और कुछ मदद चाहिए जी?" → "नहीं/बाय" pe ek GARAM goodbye ("ठीक है सिद्धार्थ जी, अपना ख्याल रखिए! नमस्ते.") + END_CALL:true.
7. RESCHEDULE — DO alag haalat, alag sentinel:
${config.agentMayReschedule
  ? `   (a) ISI CALL mein tune jo booking ki, uska time YA din patient badle ("shaam ko nahi ho payega", "kal karo") → naya time availability se confirm karke SAAF haan par UPDATE_APPOINTMENT emit kar naye dateTime ke saath — system isi call ki booking khud dhoondh kar MOVE karega. BOOK_APPOINTMENT DOBARA mat emit kar: doosre din ke liye woh EK AUR appointment bana deta hai aur pehli wali BANI rehti hai (patient do baar day-sheet par).`
  : `   (a) ISI CALL mein tune jo booking ki, uska SIRF USI DIN ka time patient badle ("shaam 5 nahi, 6 karo") → BOOK_APPOINTMENT phir se emit kar usi doctor + usi din ke naye time ke saath — system usi appointment ko move karega. Patient DOOSRE DIN ko kahe ("kal nahi, parso") → tu khud nahi badal sakti: bol ki reschedule clinic staff hi karte hain, request note ho gayi, clinic call karega. Us haalat mein BOOK_APPOINTMENT DOBARA mat emit kar — do appointments ban jayengi.`}
${config.agentMayReschedule ? `   (b) PEHLE SE BANI appointment ke baare mein call aaye ("meri kal ki appointment hai, use shaam ko kar dijiye", "appointment ka time badalna hai") → UPDATE_APPOINTMENT emit kar naye dateTime ke saath. Doctor ka naam YA patient ka naam POOCHNA ZAROORI NAHI — system caller ke PHONE NUMBER se uski appointment KHUD dhoondh leta hai. "आपका नाम बताइए" / "किस डॉक्टर के साथ?" poochh kar patient ko ATKAO mat: naya time mila toh SEEDHA UPDATE_APPOINTMENT emit kar (doctor ya naam patient ne khud bola ho toh bhej de, warna khaali chhod). Aisi haalat mein BOOK_APPOINTMENT KABHI mat emit kar — usse purani appointment bani rahegi aur DOOSRI nayi ban jayegi, patient do baar day-sheet par aa jayega.` : STAFF_ONLY_RESCHEDULE}
${config.agentMayReschedule ? `   MISAAL (bilkul aise karo) — patient: "मेरी अपॉइंटमेंट है कल की, उसे शाम को कर दीजिए"
     GALAT: "क्या आप मुझे डॉक्टर का नाम बता सकते हैं?"  ← patient ATAK gaya, kuch move nahi hua
     GALAT: "आपका नाम बताइए ताकि मैं अपॉइंटमेंट ढूंढ सकूँ?"  ← number se already mil jaati hai
     SAHI:  UPDATE_APPOINTMENT:{"dateTime":"<kal ki date>T18:00:00+05:30"}  (aur system jo time likhega wahi bola jayega)
   EK BAAR ho gaya toh BAS: reschedule confirm hone ke BAAD patient "हाँ/ठीक है/अच्छा" bole toh sentinel DOBARA mat emit kar aur wahi confirmation DOBARA mat bol — sirf warmly "और कुछ मदद चाहिए जी?" pooch.` : ''}
   SABSE ZAROORI (dono haalat): jab tak tune USI turn mein sentinel emit nahi kiya, "बदल दिया/पक्का कर दिया/हो गया" KABHI mat bol — bina sentinel ke bola toh appointment asli mein PURANE time par hi rahegi aur patient ko WhatsApp galat time ka jayega.
${config.agentMayCancel ? `8. CANCEL: patient appointment cancel/rad karna chahe ("cancel kar do", "रद्द कर दो", "अब नहीं आना", "अपॉइंटमेंट हटा दो") → ek chhota confirm ("पक्का कैंसिल कर दूँ जी?") ke SAAF haan par CANCEL_APPOINTMENT emit kar (patientName + agar doctor ka naam bola ho toh doctor). ⚠ SABSE ZAROORI: jab tak USI turn mein CANCEL_APPOINTMENT emit nahi kiya, "कैंसिल कर दिया / रद्द कर दिया / cancelled" KABHI mat bol — bina sentinel ke bola toh appointment asli mein BANI rahegi, reminder jaayega, aur patient galti se nahi aayega. Confirmation aur sentinel HAMESHA saath.` : STAFF_ONLY_CANCEL}

RULES (SAKHTI SE):
- EK DOCTOR PAR TIKE REH (sabse zaroori): ek doctor suggest karne ke baad har turn USI doctor par raho. Patient "और"/"हाँ"/confuse ho ya sawaal poochhe → wahi doctor phir se bolo, naya doctor KABHI mat chuno. Doosra doctor SIRF tab jab patient KHUD kisi aur ka naam le ya saaf kahe "koi दूसरा डॉक्टर". (Galat: Gaikwad → phir Patwardhan → phir Gaikwad.)
- DOCTOR KA NAAM (SAKHT): ek turn mein SIRF EK doctor ka naam bol — do naam "… या …" KABHI mat de. Naam HAMESHA list se HUBAHU (exact) le; list mein jo naam nahi hai use KABHI mat bana ya mila-jula naam mat bol. Naam zara bhi doubtful lage toh list se dobara dekh kar bol. (Galat: "रश्मि जोशी" bola jabki list mein "मीरा जोशी" hai — pehla naam bana diya.)
${noBookableDoctor ? '' : `- Availability: har doctor ke saamne "ABHI available" JO likha hai SIRF wahi offer kar — woh ABHI ke waqt ke hisaab se sahi hai. Jis doctor ka aaj ka time NIKAL CHUKA (ABHI available = "kal…" ya aage), use AAJ ke liye offer MAT kar. Patient jaldi/turant maange → upar "AAJ SABSE JALDI AVAILABLE" line se sabse pehla doctor. Kisi bhi AAGE ke din ke liye — kal, parso, "Monday", "13 tareekh" — PEHLE "BAND:" wali list dekh: us din ka naam usme ho toh woh din OFFER MAT kar, seedha agla khula din de. KAL ke liye SIRF "KAL (<din>)" wali line se bol — "KAL … BAND" likha ho toh kal ka koi time OFFER MAT kar, seedha agla khula din de. "weekly:" sirf uske BAAD ke dinon (reschedule) ke reference ke liye — kal ka din usse KHUD mat nikaal — aaj ka slot uski jagah "ABHI available" se. List ke bahar ka time/din KABHI mat bana.`}
- Patient ka maanga doctor list mein nahi → ${pinnedLang ? `${pinnedLang} mein bol ki woh doctor yahan nahi hain` : `"माफ़ कीजिए, वो डॉक्टर यहाँ नहीं हैं"`} + list se options do. Naam invent mat kar; naam galat/adhura suna ho toh dobara poochh.
- on-call doctor → book mat kar, ${pinnedLang ? `callback lagane ki baat ${pinnedLang} mein bol` : `"कॉलबैक लगा देती हूँ" bol`} AUR USI turn mein REQUEST_CALLBACK emit kar. ⚠ Bina REQUEST_CALLBACK ke "कॉलबैक लगा दूँगी / callback laga deti hoon" KABHI mat bol — clinic ko kuch dikhega hi nahi aur patient ek aise call ka intezaar karega jo kabhi nahi aayega.
- Medical advice / diagnosis / dawai KABHI mat de — "यह डॉक्टर बताएंगे".
- CLINIC KA PATA/ADDRESS: ${config.clinicAddress
  ? `"${config.clinicAddress}" — address poochhe toh HUBAHU yahi bol, ek shabd mat badal.`
  : `tere paas clinic ka exact address NAHI hai. Address poochhe toh SEEDHA-SAADA imaandaari se: "माफ़ कीजिए, सटीक पता अभी मेरे पास नहीं है — reception से confirm करके आपको बता दिया जाएगा" jaisa bol. Koi gali/road/number/landmark KABHI MAT BANA (banaya hua pata patient ko galat jagah bhej dega). "WhatsApp par bhej dungi/details bhej di jayengi" bhi MAT bol — ${isText ? 'tu WhatsApp par hai, par pata TERE PAAS HAI HI NAHI, toh bhejne ka vaada phir bhi jhootha hai' : 'tu WhatsApp par address nahi bhej sakti, aur yeh jhootha vaada hai'}.`}
- ${isText ? "Headings (##), \"Step N\", \"assistant/user/system\" — KABHI mat likh. Nayi line theek hai." : "Markdown (##, **, bullets, numbered list), \"Step N\", \"assistant/user/system\" — yeh KABHI mat likh."} Sirf seedhi spoken line + (zaroorat ho toh) sentinels.

EMERGENCY (kisi BHI bhaasha mein: chest pain, saans nahi aa rahi, accident, behoshi, bahut khoon, stroke):
Bilkul yeh bol: "${EMERGENCY_LINES[context.languageCode] || EMERGENCY_LINES['hi-IN']}" phir nayi line par EMERGENCY_DETECTED:true. Koi sawaal nahi.

SENTINELS (machine-only, nayi line par, patient ko KABHI mat dikhao):
PATIENT_NAME:Naam
BOOK_APPOINTMENT:{"doctor":"<list ka exact doctor naam>","patientName":"X","reason":"Y","dateTime":"${istExampleDateTime()}"}
${config.agentMayReschedule ? `UPDATE_APPOINTMENT:{"dateTime":"${istExampleDateTime()}","patientName":"X","doctor":"<agar patient ne doctor ka naam bola ho warna khaali chhod>"}
` : ''}${config.agentMayCancel ? `CANCEL_APPOINTMENT:{"patientName":"X","doctor":"<agar patient ne doctor ka naam bola ho warna khaali chhod>"}
` : ''}REQUEST_CALLBACK:{"patientName":"X","specialty":"<on-call doctor ki specialty>","reason":"Y"}
END_CALL:true

CURRENT DATE/TIME (IST): ${istDateLine()}. "aaj"=today, "kal"=+1 din, "parso"=+2 din. dateTime HAMESHA poora ISO +05:30 ke saath, isi current date se gino. Aaj ka DIN/vaar SIRF isi line se le — doctor ke schedule (Tue/Thu/Sat jaisi list) se aaj ka din KABHI mat bol.

RULE: har reply mein spoken text ZAROOR ho (sirf sentinel kabhi nahi).`;
}

// Match the model's spoken/sentinel doctor name to a real roster doctor.
// Tolerant: substring either way, honorific-stripped.
function resolveDoctor(ref) {
  if (!ref) return null;
  const norm = s => String(s || '').toLowerCase().replace(/dr\.?|doctor|डॉक्टर|डॉ\.?|जी/gi, '').replace(/[^a-zऀ-ॿ]/g, ' ').replace(/\s+/g, ' ').trim();
  const r = norm(ref);
  if (!r) return null;
  // 1) exact, then 2) substring either direction. Substring hits must be
  // UNIQUE: at multispecialty roster sizes two doctors share a surname
  // ("Dr. Kulkarni" — Rohan or Sneha?), and .find() would silently book the
  // first one. Ambiguous → null → the canned re-ask, never a guessed booking.
  const exact = ROSTER.doctors.find(d => norm(d.name) === r);
  if (exact) return exact;
  const subHits = ROSTER.doctors.filter(d => { const n = norm(d.name); return n && (n.includes(r) || r.includes(n)); });
  if (subHits.length === 1) return subHits[0];
  if (subHits.length > 1) {
    console.warn(`[LEAN] resolveDoctor: "${ref}" matches ${subHits.length} doctors (${subHits.map(d => d.name).join(', ')}) — refusing, will re-ask`);
    return null;
  }
  // 3) token-level fuzzy — tolerate a model typo ("Desukh"≈"Deshmukh", "Bhosle"≈"Bhosale")
  // so a one-letter slip never refuses a valid booking. Same tolerance as the
  // hospital booking tool (tools/bookAppointment.js).
  const lev = (a, b) => {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[n];
  };
  const rToks = r.split(' ').filter(t => t.length >= 3);
  let best = null, bestScore = 0, secondScore = 0;
  for (const d of ROSTER.doctors) {
    const cToks = norm(d.name).split(' ').filter(t => t.length >= 3);
    let s = 0;
    for (const rt of rToks) for (const ct of cToks) {
      const sim = 1 - lev(rt, ct) / Math.max(rt.length, ct.length);
      if (sim > s) s = sim;
    }
    if (s > bestScore) { secondScore = bestScore; bestScore = s; best = d; }
    else if (s > secondScore) { secondScore = s; }
  }
  if (bestScore < 0.7) return null; // 0.7 ≈ one token with a small typo
  // AMBIGUITY GUARD (multispecialty safety): at 2 doctors the names are distinct
  // and the runner-up scores far below best. At 25 they collide — "Patil" vs
  // "Patel" both ~0.8, "Sharma" vs "Verma" etc. A fuzzy best that a near-equal
  // runner-up shadows is NOT safe to book (wrong-doctor DB write). Refuse and let
  // the caller re-ask BY NAME. Inert whenever names are distinct. Only the FUZZY
  // tier is guarded; exact + substring matches above are unambiguous and returned
  // as-is, so a real single-doctor typo still books.
  if (secondScore >= 0.7 && bestScore - secondScore < 0.15) {
    console.warn(`[LEAN] ambiguous doctor match for "${ref}" — best "${best && best.name}" ${bestScore.toFixed(2)} vs runner-up ${secondScore.toFixed(2)}; refusing to guess`);
    return null;
  }
  return best;
}

function extractSentinel(text, key) {
  const m = text.match(new RegExp(`${key}:\\s*(\\{[\\s\\S]*?\\})`));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

// ─── LOCALIZED CANNED LINES (verified-then-speak strings) ────────────────────
// These exist because the model CANNOT be trusted at these moments (a spoken
// booking claim must match the DB). They were hi/mr-only, which broke the
// spell on pinned multilingual calls — a Kannada caller hitting a busy slot
// heard Hindi. Language = context.languageCode (pinned) → hindiInCall → mr.
// {doctor}/{alt} replaced verbatim; day names/times stay Latin+digits.
// The request the staff will act on, as a callbacks row. Returns false when
// nothing was committed, and the caller must then NOT promise a call-back.
async function noteStaffRequest(kind, sentinel, context, patientName) {
  try {
    const id = await db.logStaffRequest({
      clinicId: context.clinicId || config.clinicId,
      patientName: (sentinel && sentinel.patientName) || context.patientName || patientName || 'Unknown',
      phone: context.callerPhone,
      kind,
      detail: kind === 'reschedule' && sentinel && sentinel.dateTime ? `asked for ${sentinel.dateTime}` : null,
    });
    if (id) console.log(`[POLICY] ${kind} request noted as callback ${id} (staff-only clinic)`);
    return !!id;
  } catch (err) {
    console.error(`[POLICY] could not note the ${kind} request:`, err.message);
    return false;
  }
}

// ─── WHEN THE CLINIC KEEPS CANCELLATION FOR ITSELF ──────────────────────────
// Skin Essence's form reserves cancel and reschedule for its staff (Q52). The
// rules and the two sentinel definitions are then NOT EMITTED AT ALL, rather
// than emitted with a "but don't" bolted on.
//
// That distinction is the whole design. A prompt carrying both "here is how to
// cancel" and "never cancel" leaves the model right either way, which is the
// defect shape this file has hit twice — the empty-roster "offer the soonest"
// against "never offer", and the Hinglish "KABHI nahi" against a Hinglish
// example. A model cannot misuse a sentinel it was never taught.
//
// The prompt is layer one of three. The sentinel handlers refuse even if the
// model invents the sentinel, and updateAppointment refuses even if a handler
// is bypassed — because a prompt line is a request, not a guarantee.
const STAFF_ONLY_RESCHEDULE = `   (b) PEHLE SE BANI appointment ka time badalne ko kahe ("meri kal ki appointment shaam ko kar dijiye") → tu KHUD nahi badal sakti. Sirf itna bol: cancel/reschedule clinic staff hi karte hain, tune request note kar li hai aur clinic call karega. Time badalne ka VAADA mat kar, aur "badal diya" KABHI mat bol.`;

const STAFF_ONLY_CANCEL = `8. CANCEL: patient appointment cancel karna chahe → tu KHUD cancel nahi kar sakti. Bol ki cancel clinic staff hi karte hain, tune request note kar li hai, clinic unhe call karega — aur kaho ki kam se kam do ghante pehle bata dein. "कैंसिल कर दिया / रद्द कर दिया / cancelled" KABHI mat bol: appointment asli mein BANI rahegi.`;

// ─── THE FEE SENTENCE, BUILT IN CODE ───────────────────────────────────────
// Assembled here rather than left to the model for the same reason the roster
// is: a fee the model paraphrases is a fee it can get wrong, and this one is
// quoted to a caller who will hold the clinic to it.
//
// Each half is independent. A clinic that gave a follow-up policy but no default
// doctor gets one sentence; one that gave neither gets no block, and the prompt
// is byte-identical to what it was before this existed.
function feePolicyBlock(policy) {
  if (!policy) return '';
  const lines = [];
  const { followupFreeDays: days, followupFeeInr: fee, defaultDoctorName: doc } = policy;
  if (days != null && fee != null) {
    lines.push(`Follow-up: pichhli visit ke ${days} din tak FREE, uske baad ₹${fee}.`);
  } else if (fee != null) {
    lines.push(`Follow-up fees ₹${fee}.`);
  }
  if (doc) {
    lines.push(`Patient kisi doctor ka naam NA le toh ${doc} ke saath book kar — par patient doosre doctor ka naam le toh usi ke saath.`);
  }
  if (!lines.length) return '';
  // Same no-invention rule the roster and treatments blocks carry, pointed at
  // fees: the numbers above are the only ones that may be spoken.
  return `FEES / DEFAULT DOCTOR — SIRF yeh lines bol, apna koi number ya doctor KABHI mat bana:\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}

const CANNED_LINES = {
  // Spoken when a caller asks to cancel or move an appointment at a clinic that
  // has reserved that for its own staff (config.agentMayCancel === false).
  // Ritu takes the request and says who will act on it — never "done".
  //
  // The "two hours" is the clinic's own wording from its form, and nothing in
  // the code enforces it. It is a sentence, not a rule, and is not pretended to
  // be one anywhere else.
  cancelPolicy: {
    'hi-IN': 'माफ़ कीजिए, अपॉइंटमेंट कैंसिल या रीशेड्यूल क्लिनिक स्टाफ ही करते हैं। मैं आपकी request नोट कर लेती हूँ, क्लिनिक से आपको call आ जाएगा। कृपया कम से कम दो घंटे पहले बता दीजिएगा।',
    'mr-IN': 'माफ करा, अपॉइंटमेंट कॅन्सल किंवा रीशेड्यूल क्लिनिकचे स्टाफच करतात. मी तुमची request नोंदवून घेते, क्लिनिककडून तुम्हाला call येईल. कृपया किमान दोन तास आधी कळवा.',
    'en-IN': "I'm sorry, cancellations and reschedules are handled by the clinic staff. I'll note your request and the clinic will call you back. Please do let them know at least two hours in advance.",
    'gu-IN': 'માફ કરજો, એપોઇન્ટમેન્ટ કેન્સલ કે રીશેડ્યૂલ ક્લિનિકનો સ્ટાફ જ કરે છે. હું તમારી request નોંધી લઉં છું, ક્લિનિકમાંથી તમને call આવશે. કૃપા કરીને ઓછામાં ઓછા બે કલાક પહેલાં જણાવી દેજો.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ರದ್ದು ಅಥವಾ ಬದಲಾವಣೆಯನ್ನು ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿಯೇ ಮಾಡುತ್ತಾರೆ. ನಿಮ್ಮ ಕೋರಿಕೆ ದಾಖಲಿಸಿಕೊಂಡಿದ್ದೇನೆ, ಕ್ಲಿನಿಕ್‌ನಿಂದ ಕರೆ ಬರುತ್ತದೆ. ದಯವಿಟ್ಟು ಕನಿಷ್ಠ ಎರಡು ಗಂಟೆ ಮೊದಲು ತಿಳಿಸಿ.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਅਪਾਇੰਟਮੈਂਟ ਰੱਦ ਜਾਂ ਬਦਲਣ ਦਾ ਕੰਮ ਕਲੀਨਿਕ ਦਾ ਸਟਾਫ਼ ਹੀ ਕਰਦਾ ਹੈ। ਮੈਂ ਤੁਹਾਡੀ request ਨੋਟ ਕਰ ਲਈ ਹੈ, ਕਲੀਨਿਕ ਤੋਂ ਤੁਹਾਨੂੰ call ਆਵੇਗਾ। ਕਿਰਪਾ ਕਰਕੇ ਘੱਟੋ-ਘੱਟ ਦੋ ਘੰਟੇ ਪਹਿਲਾਂ ਦੱਸ ਦਿਓ।',
    'ta-IN': 'மன்னிக்கவும், அப்பாயின்ட்மென்ட் ரத்து அல்லது மாற்றம் கிளினிக் ஊழியர்களே செய்வார்கள். உங்கள் கோரிக்கையை பதிவு செய்துவிட்டேன், கிளினிக்கிலிருந்து அழைப்பு வரும். தயவுசெய்து குறைந்தது இரண்டு மணி நேரம் முன்பு தெரிவியுங்கள்.',
    'te-IN': 'క్షమించండి, అపాయింట్మెంట్ రద్దు లేదా మార్పు క్లినిక్ సిబ్బందే చేస్తారు. మీ అభ్యర్థన నమోదు చేసుకున్నాను, క్లినిక్ నుండి కాల్ వస్తుంది. దయచేసి కనీసం రెండు గంటల ముందు తెలియజేయండి.',
    'bn-IN': 'দুঃখিত, অ্যাপয়েন্টমেন্ট বাতিল বা পরিবর্তন ক্লিনিকের স্টাফরাই করেন। আপনার অনুরোধ লিখে নিলাম, ক্লিনিক থেকে আপনাকে ফোন করা হবে। অনুগ্রহ করে অন্তত দুই ঘণ্টা আগে জানাবেন।',
    'ml-IN': 'ക്ഷമിക്കണം, അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കുന്നതും മാറ്റുന്നതും ക്ലിനിക് ജീവനക്കാരാണ് ചെയ്യുന്നത്. നിങ്ങളുടെ അഭ്യർത്ഥന ഞാൻ കുറിച്ചുവെച്ചു, ക്ലിനിക്കിൽ നിന്ന് വിളി വരും. ദയവായി കുറഞ്ഞത് രണ്ട് മണിക്കൂർ മുൻപ് അറിയിക്കുക.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଆପଏଣ୍ଟମେଣ୍ଟ ବାତିଲ୍ କିମ୍ବା ପରିବର୍ତ୍ତନ କ୍ଲିନିକ୍ ଷ୍ଟାଫ୍ ହିଁ କରନ୍ତି। ଆପଣଙ୍କ ଅନୁରୋଧ ଲେଖି ନେଲି, କ୍ଲିନିକ୍ ରୁ ଆପଣଙ୍କୁ କଲ୍ ଆସିବ। ଦୟାକରି ଅନ୍ତତଃ ଦୁଇ ଘଣ୍ଟା ପୂର୍ବରୁ ଜଣାଇ ଦିଅନ୍ତୁ।',
  },
  // Split switches (module 6, 2026-09-15): when the clinic lets patients MOVE
  // but keeps CANCEL for staff, the refusal must not claim both are staff-only.
  cancelStaffOnly: {
    'hi-IN': 'माफ़ कीजिए, अपॉइंटमेंट कैंसिल क्लिनिक स्टाफ ही करते हैं। मैं आपकी request नोट कर लेती हूँ, क्लिनिक से आपको call आ जाएगा। कृपया कम से कम दो घंटे पहले बता दीजिएगा।',
    'mr-IN': 'माफ करा, अपॉइंटमेंट कॅन्सल क्लिनिकचे स्टाफच करतात. मी तुमची request नोंदवून घेते, क्लिनिककडून तुम्हाला call येईल. कृपया किमान दोन तास आधी कळवा.',
    'en-IN': "I'm sorry, cancellations are handled by the clinic staff. I'll note your request and the clinic will call you back. Please do let them know at least two hours in advance.",
    'gu-IN': 'માફ કરજો, એપોઇન્ટમેન્ટ કેન્સલ ક્લિનિકનો સ્ટાફ જ કરે છે. હું તમારી request નોંધી લઉં છું, ક્લિનિકમાંથી તમને call આવશે. કૃપા કરીને ઓછામાં ઓછા બે કલાક પહેલાં જણાવી દેજો.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ರದ್ದನ್ನು ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿಯೇ ಮಾಡುತ್ತಾರೆ. ನಿಮ್ಮ ಕೋರಿಕೆ ದಾಖಲಿಸಿಕೊಂಡಿದ್ದೇನೆ, ಕ್ಲಿನಿಕ್‌ನಿಂದ ಕರೆ ಬರುತ್ತದೆ. ದಯವಿಟ್ಟು ಕನಿಷ್ಠ ಎರಡು ಗಂಟೆ ಮೊದಲು ತಿಳಿಸಿ.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਅਪਾਇੰਟਮੈਂਟ ਰੱਦ ਕਰਨ ਦਾ ਕੰਮ ਕਲੀਨਿਕ ਦਾ ਸਟਾਫ਼ ਹੀ ਕਰਦਾ ਹੈ। ਮੈਂ ਤੁਹਾਡੀ request ਨੋਟ ਕਰ ਲਈ ਹੈ, ਕਲੀਨਿਕ ਤੋਂ ਤੁਹਾਨੂੰ call ਆਵੇਗਾ। ਕਿਰਪਾ ਕਰਕੇ ਘੱਟੋ-ਘੱਟ ਦੋ ਘੰਟੇ ਪਹਿਲਾਂ ਦੱਸ ਦਿਓ।',
    'ta-IN': 'மன்னிக்கவும், அப்பாயின்ட்மென்ட் ரத்து கிளினிக் ஊழியர்களே செய்வார்கள். உங்கள் கோரிக்கையை பதிவு செய்துவிட்டேன், கிளினிக்கிலிருந்து அழைப்பு வரும். தயவுசெய்து குறைந்தது இரண்டு மணி நேரம் முன்பு தெரிவியுங்கள்.',
    'te-IN': 'క్షమించండి, అపాయింట్మెంట్ రద్దు క్లినిక్ సిబ్బందే చేస్తారు. మీ అభ్యర్థన నమోదు చేసుకున్నాను, క్లినిక్ నుండి కాల్ వస్తుంది. దయచేసి కనీసం రెండు గంటల ముందు తెలియజేయండి.',
    'bn-IN': 'দুঃখিত, অ্যাপয়েন্টমেন্ট বাতিল ক্লিনিকের স্টাফরাই করেন। আপনার অনুরোধ লিখে নিলাম, ক্লিনিক থেকে আপনাকে ফোন করা হবে। অনুগ্রহ করে অন্তত দুই ঘণ্টা আগে জানাবেন।',
    'ml-IN': 'ക്ഷമിക്കണം, അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കുന്നത് ക്ലിനിക് ജീവനക്കാരാണ് ചെയ്യുന്നത്. നിങ്ങളുടെ അഭ്യർത്ഥന ഞാൻ കുറിച്ചുവെച്ചു, ക്ലിനിക്കിൽ നിന്ന് വിളി വരും. ദയവായി കുറഞ്ഞത് രണ്ട് മണിക്കൂർ മുൻപ് അറിയിക്കുക.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଆପଏଣ୍ଟମେଣ୍ଟ ବାତିଲ୍ କ୍ଲିନିକ୍ ଷ୍ଟାଫ୍ ହିଁ କରନ୍ତି। ଆପଣଙ୍କ ଅନୁରୋଧ ଲେଖି ନେଲି, କ୍ଲିନିକ୍ ରୁ ଆପଣଙ୍କୁ କଲ୍ ଆସିବ। ଦୟାକରି ଅନ୍ତତଃ ଦୁଇ ଘଣ୍ଟା ପୂର୍ବରୁ ଜଣାଇ ଦିଅନ୍ତୁ।',
  },
  moveStaffOnly: {
    'hi-IN': 'माफ़ कीजिए, अपॉइंटमेंट का समय बदलना क्लिनिक स्टाफ ही करते हैं। मैं आपकी request नोट कर लेती हूँ, क्लिनिक से आपको call आ जाएगा।',
    'mr-IN': 'माफ करा, अपॉइंटमेंटची वेळ बदलणे क्लिनिकचे स्टाफच करतात. मी तुमची request नोंदवून घेते, क्लिनिककडून तुम्हाला call येईल.',
    'en-IN': "I'm sorry, rescheduling is handled by the clinic staff. I'll note your request and the clinic will call you back.",
    'gu-IN': 'માફ કરજો, એપોઇન્ટમેન્ટનો સમય બદલવાનું ક્લિનિકનો સ્ટાફ જ કરે છે. હું તમારી request નોંધી લઉં છું, ક્લિનિકમાંથી તમને call આવશે.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬದಲಾವಣೆಯನ್ನು ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿಯೇ ಮಾಡುತ್ತಾರೆ. ನಿಮ್ಮ ಕೋರಿಕೆ ದಾಖಲಿಸಿಕೊಂಡಿದ್ದೇನೆ, ಕ್ಲಿನಿಕ್‌ನಿಂದ ಕರೆ ಬರುತ್ತದೆ.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਅਪਾਇੰਟਮੈਂਟ ਦਾ ਸਮਾਂ ਬਦਲਣ ਦਾ ਕੰਮ ਕਲੀਨਿਕ ਦਾ ਸਟਾਫ਼ ਹੀ ਕਰਦਾ ਹੈ। ਮੈਂ ਤੁਹਾਡੀ request ਨੋਟ ਕਰ ਲਈ ਹੈ, ਕਲੀਨਿਕ ਤੋਂ ਤੁਹਾਨੂੰ call ਆਵੇਗਾ।',
    'ta-IN': 'மன்னிக்கவும், அப்பாயின்ட்மென்ட் மாற்றம் கிளினிக் ஊழியர்களே செய்வார்கள். உங்கள் கோரிக்கையை பதிவு செய்துவிட்டேன், கிளினிக்கிலிருந்து அழைப்பு வரும்.',
    'te-IN': 'క్షమించండి, అపాయింట్మెంట్ మార్పు క్లినిక్ సిబ్బందే చేస్తారు. మీ అభ్యర్థన నమోదు చేసుకున్నాను, క్లినిక్ నుండి కాల్ వస్తుంది.',
    'bn-IN': 'দুঃখিত, অ্যাপয়েন্টমেন্ট পরিবর্তন ক্লিনিকের স্টাফরাই করেন। আপনার অনুরোধ লিখে নিলাম, ক্লিনিক থেকে আপনাকে ফোন করা হবে।',
    'ml-IN': 'ക്ഷമിക്കണം, അപ്പോയിന്റ്മെന്റ് മാറ്റുന്നത് ക്ലിനിക് ജീവനക്കാരാണ് ചെയ്യുന്നത്. നിങ്ങളുടെ അഭ്യർത്ഥന ഞാൻ കുറിച്ചുവെച്ചു, ക്ലിനിക്കിൽ നിന്ന് വിളി വരും.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଆପଏଣ୍ଟମେଣ୍ଟ ପରିବର୍ତ୍ତନ କ୍ଲିନିକ୍ ଷ୍ଟାଫ୍ ହିଁ କରନ୍ତି। ଆପଣଙ୍କ ଅନୁରୋଧ ଲେଖି ନେଲି, କ୍ଲିନିକ୍ ରୁ ଆପଣଙ୍କୁ କଲ୍ ଆସିବ।',
  },
  // A second appointment booked in a call that already holds one. Canned and
  // mandatory: the model may still say "बदल दिया" (moved), and since migration
  // 013 a different day is an INSERT — the first appointment stands, its
  // reminder will fire, and the caller has to be told so they can keep or drop it.
  bookedSecond: {
    'hi-IN': 'हो गया जी! {doctor} जी के साथ {time} की एक और अपॉइंटमेंट बुक कर दी है। आपकी पहली अपॉइंटमेंट, {firstTime}, भी बनी हुई है — दोनों रखनी हैं?',
    'mr-IN': 'झालं जी! {doctor} यांच्यासोबत {time} ची आणखी एक अपॉइंटमेंट बुक केली आहे. तुमची पहिली अपॉइंटमेंट, {firstTime}, पण आहे — दोन्ही ठेवायच्या का?',
    'en-IN': 'Done! A second appointment with {doctor} is booked for {time}. Your first one, {firstTime}, is still in place — shall I keep both?',
    'kn-IN': 'ಆಯ್ತು ಜೀ! {doctor} ಅವರ ಜೊತೆ {time} ಕ್ಕೆ ಇನ್ನೊಂದು ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಿದ್ದೇನೆ. ನಿಮ್ಮ ಮೊದಲ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್, {firstTime}, ಹಾಗೇ ಇದೆ — ಎರಡನ್ನೂ ಇಡಬೇಕಾ?',
    'pa-IN': 'ਹੋ ਗਿਆ ਜੀ! {doctor} ਜੀ ਨਾਲ {time} ਦੀ ਇੱਕ ਹੋਰ ਅਪਾਇੰਟਮੈਂਟ ਬੁੱਕ ਕਰ ਦਿੱਤੀ ਹੈ। ਤੁਹਾਡੀ ਪਹਿਲੀ ਅਪਾਇੰਟਮੈਂਟ, {firstTime}, ਵੀ ਬਣੀ ਹੋਈ ਹੈ — ਦੋਵੇਂ ਰੱਖਣੀਆਂ ਹਨ?',
    'ta-IN': 'முடிந்தது! {doctor} உடன் {time} க்கு இன்னொரு அப்பாயின்ட்மென்ட் பதிவு செய்துவிட்டேன். உங்கள் முதல் அப்பாயின்ட்மென்ட், {firstTime}, அப்படியே உள்ளது — இரண்டையும் வைக்கவா?',
    'te-IN': 'అయిపోయింది! {doctor} గారితో {time} కి మరో అపాయింట్మెంట్ బుక్ చేశాను. మీ మొదటి అపాయింట్మెంట్, {firstTime}, అలాగే ఉంది — రెండూ ఉంచాలా?',
    'bn-IN': 'হয়ে গেছে! {doctor}-এর সঙ্গে {time}-এ আরেকটি অ্যাপয়েন্টমেন্ট বুক করে দিয়েছি। আপনার প্রথম অ্যাপয়েন্টমেন্ট, {firstTime}, এখনও আছে — দুটোই রাখব?',
    'gu-IN': 'થઈ ગયું! {doctor} સાથે {time} ની બીજી એપોઇન્ટમેન્ટ બુક કરી દીધી છે. તમારી પહેલી એપોઇન્ટમેન્ટ, {firstTime}, પણ છે — બંને રાખવી છે?',
    'ml-IN': 'ആയി! {doctor}-നൊപ്പം {time}-ന് മറ്റൊരു അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്തു. നിങ്ങളുടെ ആദ്യത്തേത്, {firstTime}, അതുപോലെ ഉണ്ട് — രണ്ടും വേണോ?',
    'od-IN': 'ହୋଇଗଲା! {doctor} ଙ୍କ ସହ {time} ରେ ଆଉ ଏକ ଆପଏଣ୍ଟମେଣ୍ଟ ବୁକ୍ କରିଦେଲି। ଆପଣଙ୍କ ପ୍ରଥମ ଆପଏଣ୍ଟମେଣ୍ଟ, {firstTime}, ମଧ୍ୟ ଅଛି — ଦୁଇଟି ରଖିବେ କି?',
  },
  // Spoken instead of a reply that asserted a complaint the caller never made.
  askComplaint: {
    'hi-IN': 'माफ़ कीजिए जी — किस तकलीफ़ के लिए दिखाना है?',
    'mr-IN': 'माफ करा — कोणत्या त्रासासाठी दाखवायचं आहे?',
    'en-IN': 'Sorry — what would you like to see the doctor for?',
    'kn-IN': 'ಕ್ಷಮಿಸಿ — ಯಾವ ತೊಂದರೆಗಾಗಿ ಡಾಕ್ಟರ್ ಅನ್ನು ನೋಡಬೇಕು?',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ ਜੀ — ਕਿਸ ਤਕਲੀਫ਼ ਲਈ ਦਿਖਾਉਣਾ ਹੈ?',
    'ta-IN': 'மன்னிக்கவும் — எந்த பிரச்சனைக்காக டாக்டரை பார்க்க வேண்டும்?',
    'te-IN': 'క్షమించండి — ఏ సమస్య కోసం డాక్టర్‌ను చూపించాలి?',
    'bn-IN': 'দুঃখিত — কোন সমস্যার জন্য ডাক্তার দেখাতে চান?',
    'gu-IN': 'માફ કરજો — કઈ તકલીફ માટે ડૉક્ટરને બતાવવું છે?',
    'ml-IN': 'ക്ഷമിക്കണം — ഏത് പ്രശ്നത്തിനാണ് ഡോക്ടറെ കാണേണ്ടത്?',
    'od-IN': 'କ୍ଷମା କରିବେ — କେଉଁ ଅସୁବିଧା ପାଇଁ ଡାକ୍ତରଙ୍କୁ ଦେଖାଇବେ?',
  },
  retry: {
    'hi-IN': 'माफ़ कीजिए, ज़रा फिर से बताइएगा?', 'mr-IN': 'माफ करा, पुन्हा सांगाल का?',
    'en-IN': 'Sorry, could you please say that again?',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ದಯವಿಟ್ಟು ಇನ್ನೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?', 'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ ਜੀ, ਜ਼ਰਾ ਫਿਰ ਤੋਂ ਦੱਸੋਗੇ?',
    'ta-IN': 'மன்னிக்கவும், தயவுசெய்து மீண்டும் சொல்லுங்கள்?', 'te-IN': 'క్షమించండి, దయచేసి మళ్ళీ చెప్పండి?',
    'bn-IN': 'দুঃখিত, একটু আবার বলবেন?', 'gu-IN': 'માફ કરજો, જરા ફરીથી કહેશો?',
    'ml-IN': 'ക്ഷമിക്കണം, ഒന്നുകൂടി പറയാമോ?', 'od-IN': 'କ୍ଷମା କରିବେ, ଦୟାକରି ପୁଣି ଥରେ କହିବେ?'
  },
  unknownDoctor: {
    'hi-IN': 'माफ़ कीजिए, डॉक्टर का नाम ठीक से समझ नहीं आया — कौन से डॉक्टर से मिलना है, ज़रा फिर बताइएगा?',
    'mr-IN': 'माफ करा, डॉक्टरांचं नाव नीट समजलं नाही — कोणत्या डॉक्टरांकडे भेट हवी आहे, पुन्हा सांगाल का?',
    'en-IN': "Sorry, I did not quite catch the doctor's name — which doctor would you like to see?",
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಡಾಕ್ಟರ್ ಹೆಸರು ಸರಿಯಾಗಿ ತಿಳಿಯಲಿಲ್ಲ — ಯಾವ ಡಾಕ್ಟರ್ ಬಳಿ ಹೋಗಬೇಕು, ಇನ್ನೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਡਾਕਟਰ ਦਾ ਨਾਂ ਠੀਕ ਤਰ੍ਹਾਂ ਸਮਝ ਨਹੀਂ ਆਇਆ — ਕਿਹੜੇ ਡਾਕਟਰ ਨੂੰ ਮਿਲਣਾ ਹੈ, ਫਿਰ ਤੋਂ ਦੱਸੋਗੇ?',
    'ta-IN': 'மன்னிக்கவும், டாக்டர் பெயர் சரியாக புரியவில்லை — எந்த டாக்டரை பார்க்க வேண்டும், மீண்டும் சொல்லுங்கள்?',
    'te-IN': 'క్షమించండి, డాక్టర్ పేరు సరిగ్గా అర్థం కాలేదు — ఏ డాక్టర్‌ని కలవాలి, మళ్ళీ చెప్పండి?',
    'bn-IN': 'দুঃখিত, ডাক্তারের নামটা ঠিক বুঝতে পারিনি — কোন ডাক্তারকে দেখাতে চান, আবার বলবেন?',
    'gu-IN': 'માફ કરજો, ડૉક્ટરનું નામ બરાબર સમજાયું નહીં — કયા ડૉક્ટરને મળવું છે, ફરી કહેશો?',
    'ml-IN': 'ക്ഷമിക്കണം, ഡോക്ടറുടെ പേര് ശരിക്ക് മനസ്സിലായില്ല — ഏത് ഡോക്ടറെ കാണണം, ഒന്നുകൂടി പറയാമോ?',
    'od-IN': 'କ୍ଷମା କରିବେ, ଡାକ୍ତରଙ୍କ ନାମ ଠିକ୍ ବୁଝି ପାରିଲି ନାହିଁ — କେଉଁ ଡାକ୍ତରଙ୍କୁ ଦେଖାଇବେ, ପୁଣି କହିବେ?'
  },
  booked: {
    'hi-IN': 'हो गया जी! {doctor} जी के साथ आपका अपॉइंटमेंट बुक कर दिया है.',
    'mr-IN': 'झालं जी! {doctor} यांच्यासोबत तुमची अपॉइंटमेंट बुक केली आहे.',
    'en-IN': 'Done! Your appointment with {doctor} is booked.',
    'kn-IN': 'ಆಯ್ತು ಜೀ! {doctor} ಅವರ ಜೊತೆ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಿದ್ದೇನೆ.',
    'pa-IN': 'ਹੋ ਗਿਆ ਜੀ! {doctor} ਜੀ ਨਾਲ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਬੁੱਕ ਕਰ ਦਿੱਤੀ ਹੈ।',
    'ta-IN': 'முடிந்தது! {doctor} அவர்களுடன் உங்கள் அப்பாயின்ட்மென்ட் புக் செய்துவிட்டேன்.',
    'te-IN': 'అయిపోయింది! {doctor} గారితో మీ అపాయింట్మెంట్ బుక్ చేశాను.',
    'bn-IN': 'হয়ে গেছে! {doctor}-এর সঙ্গে আপনার অ্যাপয়েন্টমেন্ট বুক করে দিয়েছি।',
    'gu-IN': 'થઈ ગયું જી! {doctor} સાથે તમારી એપોઇન્ટમેન્ટ બુક કરી દીધી છે.',
    'ml-IN': 'ആയി! {doctor}-നൊപ്പം നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്തിട്ടുണ്ട്.',
    'od-IN': 'ହୋଇଗଲା! {doctor}ଙ୍କ ସହ ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ବୁକ୍ କରିଦେଇଛି।'
  },
  // `rescheduled` WAS DECLARED HERE TOO, AND THIS COPY NEVER RAN. A second
  // `rescheduled:` further down this same object literal silently shadowed it —
  // last key wins, no warning from anything. The surviving copy takes {doctor}
  // and {time}, so every caller of the key suddenly needed both, and the one at
  // :987 passes only {doctor}. cannedLine substitutes what it is given and
  // returns the rest verbatim, so live callers were told:
  //
  //     "हो गया जी, डॉ. मनोज देव जी के साथ आपकी अपॉइंटमेंट {time} कर दी है."
  //
  // — a literal placeholder, read aloud, in the sentence confirming that their
  // appointment moved. Verified by executing cannedLine('rescheduled', …) with
  // only {doctor}, exactly as :987 calls it. This placeholder-free copy is gone
  // rather than renamed: two ways to say one thing is how the pair drifted into
  // needing different arguments in the first place.
  slotAlt: {
    'hi-IN': 'उस समय उपलब्ध नहीं। {alt} ठीक रहेगा?', 'mr-IN': 'त्या वेळी उपलब्ध नाहीत. {alt} चालेल का?',
    'en-IN': 'That time is not available. Would {alt} work?',
    'kn-IN': 'ಆ ಸಮಯದಲ್ಲಿ ಲಭ್ಯವಿಲ್ಲ. {alt} ಆಗಬಹುದಾ?', 'pa-IN': 'ਉਸ ਸਮੇਂ ਉਪਲਬਧ ਨਹੀਂ ਹਨ। {alt} ਠੀਕ ਰਹੇਗਾ?',
    'ta-IN': 'அந்த நேரத்தில் இல்லை. {alt} சரியா?', 'te-IN': 'ఆ సమయంలో అందుబాటులో లేరు. {alt} సరిపోతుందా?',
    'bn-IN': 'ওই সময়ে পাওয়া যাবে না। {alt} চলবে কি?', 'gu-IN': 'એ સમયે ઉપલબ્ધ નથી. {alt} ચાલશે?',
    'ml-IN': 'ആ സമയത്ത് ലഭ്യമല്ല. {alt} മതിയാകുമോ?', 'od-IN': 'ସେହି ସମୟରେ ଉପଲବ୍ଧ ନାହାଁନ୍ତି। {alt} ଚଳିବ କି?'
  },
  // ─── THE DOCTOR DOES NOT WORK THEN ────────────────────────────────────────
  // Distinct from "somebody already has that slot", and the caller's next move
  // differs: a shut day means pick another DAY, a taken slot means pick another
  // TIME. Both used to be "उस समय उपलब्ध नहीं", which sent people back with the
  // same question. Live: call fc3ba30a was offered a Sunday, accepted, then got
  // the generic rejection and had to work out for herself that the clinic shuts
  // on Sundays — "अभी तो आपने कहा कि कल सुबह दस बजे है available."
  // ─── AN ON-CALL DOCTOR TAKES A CALLBACK, NOT A SLOT ───────────────────────
  // tools/bookAppointment has returned hint:'route_to_callback' for these all
  // along and nothing read it, so a caller asking for an on-call specialist was
  // told "that time is not available" — about a doctor who has no times at all.
  // The callback path exists and writes rows (79f2677); this line hands the turn
  // to it instead of refusing.
  // ─── ASK FOR THE REPORTS, ONCE, AFTER THE BOOKING IS REAL ─────────────────
  // reportIntake.js has been able to receive, store and auto-summarize a photo
  // of a lab report or prescription for a doctor's pre-visit read since it was
  // written — and it had NEVER been asked for. Three separate things blocked it:
  // the voice call never mentioned reports at all; ENABLE_REPORT_INTAKE was off,
  // which gates the intake handler AND the ask; and the WhatsApp invitation that
  // did exist (whatsapp.js) was appended to the plain-text FALLBACK of
  // sendTemplateOrText, so an approved confirmation template — which this clinic
  // has — sent successfully and the invitation was never transmitted. Dead code
  // in the same position whatsapp.js:106 already documents as a past defect.
  //
  // WHY VOICE AND NOT THE TEMPLATE. A photo cannot travel over a phone call, so
  // the ask has to land on WhatsApp — but sending a template does NOT open the
  // 24-hour customer-service window, so a free-text follow-up would not deliver.
  // Spoken on the call it costs nothing and needs no Meta approval, and when the
  // patient sends the photo THAT opens the window, so reportIntake's own reply
  // delivers as plain text.
  //
  // WHY IT IS A STATEMENT, NOT A QUESTION. It is spoken after the booking is
  // already committed, so it must not re-open the conversation or invite a
  // yes/no the model then has to handle. Nothing branches on the answer.
  reportAsk: {
    'hi-IN': 'एक बात और जी — पुरानी रिपोर्ट या पर्ची हो तो WhatsApp पर फोटो भेज दीजिए, डॉक्टर के लिए तैयार रखूँगी।',
    'mr-IN': 'अजून एक जी — जुने रिपोर्ट किंवा चिठ्ठी असेल तर WhatsApp वर फोटो पाठवा, डॉक्टरांसाठी तयार ठेवते.',
    'en-IN': 'One more thing — if you have old reports or a prescription, send a photo on WhatsApp and I will keep it ready for the doctor.',
    'kn-IN': 'ಇನ್ನೊಂದು ವಿಷಯ ಜೀ — ಹಳೆಯ ರಿಪೋರ್ಟ್ ಅಥವಾ ಚೀಟಿ ಇದ್ದರೆ WhatsApp ನಲ್ಲಿ ಫೋಟೋ ಕಳುಹಿಸಿ, ಡಾಕ್ಟರ್‌ಗೆ ತಯಾರು ಮಾಡಿಡುತ್ತೇನೆ.',
    'pa-IN': 'ਇੱਕ ਗੱਲ ਹੋਰ ਜੀ — ਪੁਰਾਣੀ ਰਿਪੋਰਟ ਜਾਂ ਪਰਚੀ ਹੋਵੇ ਤਾਂ WhatsApp ਤੇ ਫੋਟੋ ਭੇਜ ਦਿਓ, ਡਾਕਟਰ ਲਈ ਤਿਆਰ ਰੱਖਾਂਗੀ।',
    'ta-IN': 'இன்னொரு விஷயம் — பழைய ரிப்போர்ட் அல்லது சீட்டு இருந்தால் WhatsApp-ல் போட்டோ அனுப்புங்கள், டாக்டருக்கு தயார் செய்து வைக்கிறேன்.',
    'te-IN': 'ఇంకొక విషయం జీ — పాత రిపోర్టు లేదా చీటీ ఉంటే WhatsApp లో ఫోటో పంపండి, డాక్టర్ కోసం సిద్ధం చేసి ఉంచుతాను.',
    'bn-IN': 'আরেকটা কথা — পুরনো রিপোর্ট বা প্রেসক্রিপশন থাকলে WhatsApp-এ ছবি পাঠান, ডাক্তারের জন্য তৈরি রাখব।',
    'gu-IN': 'એક વાત વધુ જી — જૂનો રિપોર્ટ કે ચિઠ્ઠી હોય તો WhatsApp પર ફોટો મોકલો, ડૉક્ટર માટે તૈયાર રાખીશ.',
    'ml-IN': 'ഒരു കാര്യം കൂടി — പഴയ റിപ്പോർട്ടോ കുറിപ്പടിയോ ഉണ്ടെങ്കിൽ WhatsApp-ൽ ഫോട്ടോ അയയ്ക്കൂ, ഡോക്ടർക്കായി തയ്യാറാക്കി വയ്ക്കാം.',
    'od-IN': 'ଆଉ ଗୋଟିଏ କଥା — ପୁରୁଣା ରିପୋର୍ଟ କିମ୍ବା ଚିଠି ଥିଲେ WhatsApp ରେ ଫଟୋ ପଠାନ୍ତୁ, ଡାକ୍ତରଙ୍କ ପାଇଁ ପ୍ରସ୍ତୁତ ରଖିବି।',
  },
  onCallUseCallback: {
    'hi-IN': '{doctor} ऑन-कॉल स्पेशलिस्ट हैं जी — उनका फिक्स समय नहीं होता। मैं कॉलबैक लगा दूँ?',
    'mr-IN': '{doctor} ऑन-कॉल स्पेशालिस्ट आहेत जी — त्यांची ठरलेली वेळ नसते. मी कॉलबॅक लावू का?',
    'en-IN': '{doctor} is an on-call specialist — there are no fixed slots. Shall I arrange a callback?',
    'kn-IN': '{doctor} ಆನ್-ಕಾಲ್ ಸ್ಪೆಷಲಿಸ್ಟ್ ಜೀ — ಅವರಿಗೆ ನಿಗದಿತ ಸಮಯ ಇಲ್ಲ. ಕಾಲ್‌ಬ್ಯಾಕ್ ಹಾಕಲೇ?',
    'pa-IN': '{doctor} ਆਨ-ਕਾਲ ਸਪੈਸ਼ਲਿਸਟ ਹਨ ਜੀ — ਉਨ੍ਹਾਂ ਦਾ ਪੱਕਾ ਸਮਾਂ ਨਹੀਂ ਹੁੰਦਾ। ਮੈਂ ਕਾਲਬੈਕ ਲਵਾ ਦਿਆਂ?',
    'ta-IN': '{doctor} ஆன்-கால் ஸ்பெஷலிஸ்ட் — நிரந்தர நேரம் இல்லை. கால்பேக் ஏற்பாடு செய்யட்டுமா?',
    'te-IN': '{doctor} ఆన్-కాల్ స్పెషలిస్ట్ జీ — వారికి నిర్ణీత సమయం ఉండదు. కాల్‌బ్యాక్ పెట్టనా?',
    'bn-IN': '{doctor} অন-কল স্পেশালিস্ট — ওঁর নির্দিষ্ট সময় নেই। আমি কলব্যাক লাগিয়ে দেব?',
    'gu-IN': '{doctor} ઓન-કોલ સ્પેશિયાલિસ્ટ છે — એમનો નક્કી સમય નથી હોતો. હું કોલબેક ગોઠવી દઉં?',
    'ml-IN': '{doctor} ഓൺ-കോൾ സ്പെഷലിസ്റ്റ് ആണ് — നിശ്ചിത സമയമില്ല. കോൾബാക്ക് ഏർപ്പാടാക്കട്ടെ?',
    'od-IN': '{doctor} ଅନ୍-କଲ୍ ସ୍ପେସିଆଲିଷ୍ଟ — ସେମାନଙ୍କର ନିର୍ଦ୍ଦିଷ୍ଟ ସମୟ ନାହିଁ। ମୁଁ କଲବ୍ୟାକ୍ ଲଗାଇଦେବି କି?'
  },
  notWorking: {
    'hi-IN': '{doctor} उस दिन नहीं बैठते जी। {alt} ठीक रहेगा?',
    'mr-IN': '{doctor} त्या दिवशी नसतात जी. {alt} चालेल का?',
    'en-IN': '{doctor} does not sit that day. Would {alt} work?',
    'kn-IN': '{doctor} ಆ ದಿನ ಇರುವುದಿಲ್ಲ ಜೀ. {alt} ಸರಿಯಾಗುತ್ತದೆಯೇ?',
    'pa-IN': '{doctor} ਉਸ ਦਿਨ ਨਹੀਂ ਬੈਠਦੇ ਜੀ। {alt} ਠੀਕ ਰਹੇਗਾ?',
    'ta-IN': '{doctor} அன்று இருக்க மாட்டார்கள். {alt} சரியாக இருக்குமா?',
    'te-IN': '{doctor} ఆ రోజు ఉండరు జీ. {alt} సరిపోతుందా?',
    'bn-IN': '{doctor} সেদিন বসেন না। {alt} ঠিক আছে?',
    'gu-IN': '{doctor} તે દિવસે બેસતા નથી. {alt} બરાબર રહેશે?',
    'ml-IN': '{doctor} അന്ന് ഇരിക്കില്ല. {alt} ശരിയാകുമോ?',
    'od-IN': '{doctor} ସେଦିନ ବସନ୍ତି ନାହିଁ। {alt} ଠିକ୍ ହେବ କି?'
  },
  notWorkingNoAlt: {
    'hi-IN': '{doctor} उस दिन नहीं बैठते जी। कोई और दिन बताइए?',
    'mr-IN': '{doctor} त्या दिवशी नसतात जी. दुसरा दिवस सांगाल का?',
    'en-IN': '{doctor} does not sit that day. Would another day suit you?',
    'kn-IN': '{doctor} ಆ ದಿನ ಇರುವುದಿಲ್ಲ ಜೀ. ಬೇರೆ ದಿನ ಹೇಳುತ್ತೀರಾ?',
    'pa-IN': '{doctor} ਉਸ ਦਿਨ ਨਹੀਂ ਬੈਠਦੇ ਜੀ। ਕੋਈ ਹੋਰ ਦਿਨ ਦੱਸੋਗੇ?',
    'ta-IN': '{doctor} அன்று இருக்க மாட்டார்கள். வேறு நாள் சொல்லுங்கள்?',
    'te-IN': '{doctor} ఆ రోజు ఉండరు జీ. వేరే రోజు చెప్పండి?',
    'bn-IN': '{doctor} সেদিন বসেন না। অন্য কোনো দিন বলবেন?',
    'gu-IN': '{doctor} તે દિવસે બેસતા નથી. બીજો દિવસ કહેશો?',
    'ml-IN': '{doctor} അന്ന് ഇരിക്കില്ല. വേറെ ദിവസം പറയാമോ?',
    'od-IN': '{doctor} ସେଦିନ ବସନ୍ତି ନାହିଁ। ଅନ୍ୟ ଦିନ କହିବେ କି?'
  },
  // ─── SOMEBODY ELSE HAS THAT SLOT ──────────────────────────────────────────
  // The only case where "that time is taken" is literally true.
  slotTaken: {
    'hi-IN': 'वो समय अभी-अभी किसी और ने ले लिया जी। {alt} ठीक रहेगा?',
    'mr-IN': 'ती वेळ आत्ताच दुसऱ्या कोणीतरी घेतली जी. {alt} चालेल का?',
    'en-IN': 'That time was just taken by someone else. Would {alt} work?',
    'kn-IN': 'ಆ ಸಮಯವನ್ನು ಈಗಷ್ಟೇ ಬೇರೆಯವರು ತೆಗೆದುಕೊಂಡರು ಜೀ. {alt} ಸರಿಯಾಗುತ್ತದೆಯೇ?',
    'pa-IN': 'ਉਹ ਸਮਾਂ ਹੁਣੇ ਕਿਸੇ ਹੋਰ ਨੇ ਲੈ ਲਿਆ ਜੀ। {alt} ਠੀਕ ਰਹੇਗਾ?',
    'ta-IN': 'அந்த நேரத்தை இப்போதுதான் வேறொருவர் எடுத்துவிட்டார். {alt} சரியாக இருக்குமா?',
    'te-IN': 'ఆ సమయాన్ని ఇప్పుడే వేరొకరు తీసుకున్నారు జీ. {alt} సరిపోతుందా?',
    'bn-IN': 'ওই সময়টা এইমাত্র অন্য কেউ নিয়ে নিয়েছেন। {alt} ঠিক আছে?',
    'gu-IN': 'એ સમય હમણાં જ બીજા કોઈએ લઈ લીધો. {alt} બરાબર રહેશે?',
    'ml-IN': 'ആ സമയം ഇപ്പോൾ മറ്റൊരാൾ എടുത്തു. {alt} ശരിയാകുമോ?',
    'od-IN': 'ସେ ସମୟ ଏବେ ଅନ୍ୟ କେହି ନେଇଗଲେ। {alt} ଠିକ୍ ହେବ କି?'
  },
  slotNoAlt: {
    'hi-IN': 'उस समय उपलब्ध नहीं। कोई और समय बताइए?', 'mr-IN': 'त्या वेळी उपलब्ध नाहीत. दुसरी वेळ सांगाल का?',
    'en-IN': 'That time is not available. Could you suggest another time?',
    'kn-IN': 'ಆ ಸಮಯದಲ್ಲಿ ಲಭ್ಯವಿಲ್ಲ. ಬೇರೆ ಸಮಯ ಹೇಳುತ್ತೀರಾ?', 'pa-IN': 'ਉਸ ਸਮੇਂ ਉਪਲਬਧ ਨਹੀਂ ਹਨ। ਕੋਈ ਹੋਰ ਸਮਾਂ ਦੱਸੋਗੇ?',
    'ta-IN': 'அந்த நேரத்தில் இல்லை. வேறு நேரம் சொல்லுங்கள்?', 'te-IN': 'ఆ సమయంలో అందుబాటులో లేరు. వేరే సమయం చెప్పండి?',
    'bn-IN': 'ওই সময়ে পাওয়া যাবে না। অন্য কোনো সময় বলবেন?', 'gu-IN': 'એ સમયે ઉપલબ્ધ નથી. બીજો કોઈ સમય કહેશો?',
    'ml-IN': 'ആ സമയത്ത് ലഭ്യമല്ല. വേറെ സമയം പറയാമോ?', 'od-IN': 'ସେହି ସମୟରେ ଉପଲବ୍ଧ ନାହାଁନ୍ତି। ଅନ୍ୟ ସମୟ କହିବେ?'
  },
  bookingError: {
    'hi-IN': 'बुकिंग में थोड़ी दिक्कत आई, दोबारा बताइएगा?', 'mr-IN': 'बुकिंगमध्ये थोडी अडचण आली, पुन्हा सांगाल का?',
    'en-IN': 'There was a small issue with the booking — could you try once more?',
    'kn-IN': 'ಬುಕಿಂಗ್‌ನಲ್ಲಿ ಸ್ವಲ್ಪ ತೊಂದರೆ ಆಯಿತು, ಇನ್ನೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?', 'pa-IN': 'ਬੁਕਿੰਗ ਵਿੱਚ ਥੋੜ੍ਹੀ ਦਿੱਕਤ ਆਈ, ਦੁਬਾਰਾ ਦੱਸੋਗੇ?',
    'ta-IN': 'புக்கிங்கில் சிறு சிக்கல் வந்தது, மீண்டும் சொல்லுங்கள்?', 'te-IN': 'బుకింగ్‌లో చిన్న సమస్య వచ్చింది, మళ్ళీ చెప్పండి?',
    'bn-IN': 'বুকিং-এ একটু সমস্যা হয়েছে, আবার বলবেন?', 'gu-IN': 'બુકિંગમાં થોડી તકલીફ આવી, ફરી કહેશો?',
    'ml-IN': 'ബുക്കിംഗിൽ ചെറിയ പ്രശ്നം വന്നു, ഒന്നുകൂടി പറയാമോ?', 'od-IN': 'ବୁକିଂରେ ଟିକେ ଅସୁବିଧା ହେଲା, ପୁଣି କହିବେ?'
  },
  confirmBooking: {
    'hi-IN': 'क्या मैं आपकी अपॉइंटमेंट पक्की कर दूँ जी?', 'mr-IN': 'मी तुमची अपॉइंटमेंट पक्की करू का जी?',
    'en-IN': 'Shall I go ahead and confirm your appointment?',
    'kn-IN': 'ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಖಚಿತಪಡಿಸಲಾ ಜೀ?', 'pa-IN': 'ਕੀ ਮੈਂ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਪੱਕੀ ਕਰ ਦਿਆਂ ਜੀ?',
    'ta-IN': 'உங்கள் அப்பாயின்ட்மென்ட்டை உறுதி செய்யட்டுமா?', 'te-IN': 'మీ అపాయింట్‌మెంట్ ఖరారు చేయనా జీ?',
    'bn-IN': 'আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত করে দেব কি?', 'gu-IN': 'શું હું તમારી એપોઇન્ટમેન્ટ પાકી કરી દઉં?',
    'ml-IN': 'നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ഉറപ്പിക്കട്ടെ?', 'od-IN': 'ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ନିଶ୍ଚିତ କରିଦେବି କି?'
  },
  cancelled: {
    'hi-IN': 'हो गया जी, {doctor} जी के साथ आपकी अपॉइंटमेंट कैंसिल कर दी है.',
    'mr-IN': 'झालं जी, {doctor} यांच्यासोबतची तुमची अपॉइंटमेंट रद्द केली आहे.',
    'en-IN': 'Done — your appointment with {doctor} has been cancelled.',
    'kn-IN': 'ಆಯ್ತು ಜೀ, {doctor} ಅವರ ಜೊತೆಗಿನ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ರದ್ದು ಮಾಡಿದ್ದೇನೆ.',
    'pa-IN': 'ਹੋ ਗਿਆ ਜੀ, {doctor} ਜੀ ਨਾਲ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਰੱਦ ਕਰ ਦਿੱਤੀ ਹੈ।',
    'ta-IN': 'முடிந்தது, {doctor} அவர்களுடனான உங்கள் அப்பாயின்ட்மென்ட் ரத்து செய்யப்பட்டது.',
    'te-IN': 'అయిపోయింది, {doctor} గారితో మీ అపాయింట్మెంట్ రద్దు చేశాను.',
    'bn-IN': 'হয়ে গেছে, {doctor}-এর সঙ্গে আপনার অ্যাপয়েন্টমেন্ট বাতিল করে দিয়েছি।',
    'gu-IN': 'થઈ ગયું જી, {doctor} સાથે તમારી એપોઇન્ટમેન્ટ રદ કરી દીધી છે.',
    'ml-IN': 'ആയി, {doctor}-നൊപ്പമുള്ള നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കിയിട്ടുണ്ട്.',
    'od-IN': 'ହୋଇଗଲା, {doctor}ଙ୍କ ସହ ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ବାତିଲ୍ କରିଦେଇଛି।'
  },
  // Asked INSTEAD of a destructive write when several patients share the
  // handset and the caller has not said which of them they mean. hi/mr/en are
  // the languages this system is proven in; the rest follow the register of the
  // lines around them and want a native-speaker pass before a clinic in that
  // language goes live — flagged rather than quietly shipped.
  whichPatient: {
    'hi-IN': 'इस नंबर पर {names} — दोनों की अपॉइंटमेंट है जी. किसकी कैंसिल करनी है?',
    'mr-IN': 'या नंबरवर {names} — दोघांची अपॉइंटमेंट आहे जी. कोणाची रद्द करायची?',
    'en-IN': 'This number has appointments for {names}. Whose should I cancel?',
    'kn-IN': 'ಈ ನಂಬರ್‌ನಲ್ಲಿ {names} ಇಬ್ಬರ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಇದೆ ಜೀ. ಯಾರದನ್ನು ರದ್ದು ಮಾಡಬೇಕು?',
    'pa-IN': 'ਇਸ ਨੰਬਰ ਤੇ {names} — ਦੋਹਾਂ ਦੀ ਅਪਾਇੰਟਮੈਂਟ ਹੈ ਜੀ। ਕਿਸ ਦੀ ਰੱਦ ਕਰਨੀ ਹੈ?',
    'ta-IN': 'இந்த எண்ணில் {names} இருவருக்கும் அப்பாயின்ட்மென்ட் உள்ளது. யாருடையதை ரத்து செய்ய வேண்டும்?',
    'te-IN': 'ఈ నంబర్‌లో {names} ఇద్దరికీ అపాయింట్మెంట్ ఉంది జీ. ఎవరిది రద్దు చేయాలి?',
    'bn-IN': 'এই নম্বরে {names} — দুজনেরই অ্যাপয়েন্টমেন্ট আছে। কারটা বাতিল করব?',
    'gu-IN': 'આ નંબર પર {names} — બંનેની એપોઇન્ટમેન્ટ છે જી. કોની રદ કરવી છે?',
    'ml-IN': 'ഈ നമ്പറിൽ {names} — രണ്ടു പേരുടെയും അപ്പോയിന്റ്മെന്റ് ഉണ്ട്. ആരുടേത് റദ്ദാക്കണം?',
    'od-IN': 'ଏହି ନମ୍ବରରେ {names} — ଦୁହେଁଙ୍କର ଆପଏଣ୍ଟମେଣ୍ଟ ଅଛି। କାହାର ବାତିଲ୍ କରିବି?'
  },
  // ─── CALLBACK ─────────────────────────────────────────────────────────────
  // Spoken ONLY on a committed callbacks row, exactly like `cancelled`. The
  // whole point is that a "कॉलबैक लगा दिया" the patient hears is backed by
  // something a human at the clinic will actually see.
  callbackArranged: {
    'hi-IN': 'ठीक है जी, मैंने {specialty} के लिए कॉलबैक लगा दिया है — क्लिनिक से आपको कॉल आएगा.',
    'mr-IN': 'ठीक आहे जी, मी {specialty} साठी कॉलबॅक लावला आहे — क्लिनिकमधून तुम्हाला कॉल येईल.',
    'en-IN': "Done — I've logged a callback for {specialty}. The clinic will call you back.",
    'kn-IN': 'ಆಯಿತು ಜೀ, {specialty} ಗಾಗಿ ಕಾಲ್‌ಬ್ಯಾಕ್ ದಾಖಲಿಸಿದ್ದೇನೆ — ಕ್ಲಿನಿಕ್‌ನಿಂದ ಕರೆ ಬರುತ್ತದೆ.',
    'pa-IN': 'ਠੀਕ ਹੈ ਜੀ, ਮੈਂ {specialty} ਲਈ ਕਾਲਬੈਕ ਲਗਾ ਦਿੱਤਾ ਹੈ — ਕਲੀਨਿਕ ਤੋਂ ਕਾਲ ਆਵੇਗੀ.',
    'ta-IN': 'சரி, {specialty} க்கு கால்பேக் பதிவு செய்துவிட்டேன் — கிளினிக்கிலிருந்து அழைப்பு வரும்.',
    'te-IN': 'సరే జీ, {specialty} కోసం కాల్‌బ్యాక్ నమోదు చేశాను — క్లినిక్ నుండి కాల్ వస్తుంది.',
    'bn-IN': 'ঠিক আছে, {specialty} এর জন্য কলব্যাক রাখা হয়েছে — ক্লিনিক থেকে ফোন আসবে.',
    'gu-IN': 'ઠીક છે જી, {specialty} માટે કૉલબૅક નોંધ્યો છે — ક્લિનિકમાંથી ફોન આવશે.',
    'ml-IN': 'ശരി, {specialty} യ്ക്കായി കോൾബാക്ക് രേഖപ്പെടുത്തി — ക്ലിനിക്കിൽ നിന്ന് വിളി വരും.',
    'od-IN': 'ଠିକ ଅଛି, {specialty} ପାଇଁ କଲବ୍ୟାକ୍ ରଖାଯାଇଛି — କ୍ଲିନିକରୁ କଲ୍ ଆସିବ.'
  },
  // The write failed. Say something TRUE — never that a callback was arranged.
  callbackError: {
    'hi-IN': 'माफ़ कीजिए जी, अभी कॉलबैक दर्ज नहीं हो पाया. आप थोड़ी देर में फिर कॉल कर लीजिएगा.',
    'mr-IN': 'माफ करा जी, आत्ता कॉलबॅक नोंदवता आला नाही. थोड्या वेळाने पुन्हा कॉल करा.',
    'en-IN': "Sorry — I couldn't log the callback just now. Please call again in a little while.",
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಈಗ ಕಾಲ್‌ಬ್ಯಾಕ್ ದಾಖಲಿಸಲಾಗಲಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಕರೆ ಮಾಡಿ.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ ਜੀ, ਹੁਣੇ ਕਾਲਬੈਕ ਦਰਜ ਨਹੀਂ ਹੋ ਸਕਿਆ. ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਫਿਰ ਕਾਲ ਕਰੋ.',
    'ta-IN': 'மன்னிக்கவும், இப்போது கால்பேக் பதிவு செய்ய முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் அழைக்கவும்.',
    'te-IN': 'క్షమించండి, ఇప్పుడు కాల్‌బ్యాక్ నమోదు కాలేదు. కొద్దిసేపటి తర్వాత మళ్లీ కాల్ చేయండి.',
    'bn-IN': 'দুঃখিত, এখন কলব্যাক রাখা গেল না. একটু পরে আবার ফোন করুন.',
    'gu-IN': 'માફ કરશો, અત્યારે કૉલબૅક નોંધાયો નથી. થોડી વારે ફરી ફોન કરો.',
    'ml-IN': 'ക്ഷമിക്കണം, ഇപ്പോൾ കോൾബാക്ക് രേഖപ്പെടുത്താനായില്ല. കുറച്ച് കഴിഞ്ഞ് വീണ്ടും വിളിക്കൂ.',
    'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ଏବେ କଲବ୍ୟାକ୍ ରଖାଗଲା ନାହିଁ. ଟିକେ ପରେ ପୁଣି କଲ୍ କରନ୍ତୁ.'
  },
  cancelNothing: {
    'hi-IN': 'आपके नंबर पर कोई आने वाली अपॉइंटमेंट नहीं दिख रही जी. क्या नई बुक कर दूँ?',
    'mr-IN': 'तुमच्या नंबरवर कोणतीही येणारी अपॉइंटमेंट दिसत नाही जी. नवीन बुक करू का?',
    'en-IN': "I can't see any upcoming appointment on your number. Shall I book a new one?",
    'kn-IN': 'ನಿಮ್ಮ ನಂಬರ್‌ನಲ್ಲಿ ಯಾವುದೇ ಮುಂಬರುವ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಕಾಣಿಸುತ್ತಿಲ್ಲ ಜೀ. ಹೊಸದನ್ನು ಬುಕ್ ಮಾಡಲಾ?',
    'pa-IN': 'ਤੁਹਾਡੇ ਨੰਬਰ ਤੇ ਕੋਈ ਆਉਣ ਵਾਲੀ ਅਪਾਇੰਟਮੈਂਟ ਨਹੀਂ ਦਿਖ ਰਹੀ ਜੀ। ਨਵੀਂ ਬੁੱਕ ਕਰ ਦਿਆਂ?',
    'ta-IN': 'உங்கள் எண்ணில் வரவிருக்கும் அப்பாயின்ட்மென்ட் எதுவும் தெரியவில்லை. புதிதாக ஒன்று பதிவு செய்யட்டுமா?',
    'te-IN': 'మీ నంబర్‌లో రాబోయే అపాయింట్మెంట్ ఏదీ కనిపించడం లేదు జీ. కొత్తది బుక్ చేయనా?',
    'bn-IN': 'আপনার নম্বরে কোনো আসন্ন অ্যাপয়েন্টমেন্ট দেখা যাচ্ছে না। নতুন একটা বুক করে দেব?',
    'gu-IN': 'તમારા નંબર પર કોઈ આવનારી એપોઇન્ટમેન્ટ દેખાતી નથી જી. નવી બુક કરી દઉં?',
    'ml-IN': 'നിങ്ങളുടെ നമ്പറിൽ വരാനിരിക്കുന്ന അപ്പോയിന്റ്മെന്റ് ഒന്നും കാണുന്നില്ല. പുതിയത് ബുക്ക് ചെയ്യട്ടെ?',
    'od-IN': 'ଆପଣଙ୍କ ନମ୍ବରରେ କୌଣସି ଆଗାମୀ ଆପଏଣ୍ଟମେଣ୍ଟ ଦେଖାଯାଉନାହିଁ। ନୂଆ ବୁକ୍ କରିଦେବି କି?'
  },
  // ── reschedule (the cross-call path) ──────────────────────────────────────
  // Spoken ONLY on update_appointment success, exactly like `cancelled` — the
  // whole point is that a "बदल दिया" the patient hears is backed by a committed
  // row. {time} comes from the tool's own view of what it wrote, never from the
  // model's idea of what it asked for.
  rescheduled: {
    'hi-IN': 'हो गया जी, {doctor} जी के साथ आपकी अपॉइंटमेंट {time} कर दी है.',
    'mr-IN': 'झालं जी, {doctor} यांच्यासोबतची तुमची अपॉइंटमेंट {time} केली आहे.',
    'en-IN': 'Done — your appointment with {doctor} has been moved to {time}.',
    'kn-IN': 'ಆಯ್ತು ಜೀ, {doctor} ಅವರ ಜೊತೆಗಿನ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ {time} ಗೆ ಬದಲಾಯಿಸಿದ್ದೇನೆ.',
    'pa-IN': 'ਹੋ ਗਿਆ ਜੀ, {doctor} ਜੀ ਨਾਲ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ {time} ਕਰ ਦਿੱਤੀ ਹੈ।',
    'ta-IN': 'முடிந்தது, {doctor} அவர்களுடனான உங்கள் அப்பாயின்ட்மென்ட் {time}-க்கு மாற்றப்பட்டது.',
    'te-IN': 'అయిపోయింది, {doctor} గారితో మీ అపాయింట్మెంట్ {time}కి మార్చాను.',
    'bn-IN': 'হয়ে গেছে, {doctor}-এর সঙ্গে আপনার অ্যাপয়েন্টমেন্ট {time}-এ সরিয়ে দিয়েছি।',
    'gu-IN': 'થઈ ગયું જી, {doctor} સાથે તમારી એપોઇન્ટમેન્ટ {time} કરી દીધી છે.',
    'ml-IN': 'ആയി, {doctor}-നൊപ്പമുള്ള നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് {time}-ലേക്ക് മാറ്റിയിട്ടുണ്ട്.',
    'od-IN': 'ହୋଇଗଲା, {doctor}ଙ୍କ ସହ ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ {time}କୁ ବଦଳାଇ ଦେଇଛି।'
  },
  rescheduleError: {
    'hi-IN': 'समय बदलने में थोड़ी दिक्कत आई, ज़रा दोबारा बताइएगा?',
    'mr-IN': 'वेळ बदलताना थोडी अडचण आली, पुन्हा सांगाल का?',
    'en-IN': 'There was a small issue moving that — could you tell me once more?',
    'kn-IN': 'ಸಮಯ ಬದಲಾಯಿಸುವಲ್ಲಿ ಸ್ವಲ್ಪ ತೊಂದರೆ ಆಯಿತು, ಇನ್ನೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?',
    'pa-IN': 'ਸਮਾਂ ਬਦਲਣ ਵਿੱਚ ਥੋੜ੍ਹੀ ਦਿੱਕਤ ਆਈ, ਦੁਬਾਰਾ ਦੱਸੋਗੇ?',
    'ta-IN': 'நேரம் மாற்றுவதில் சிறு சிக்கல் வந்தது, மீண்டும் சொல்லுங்கள்?',
    'te-IN': 'సమయం మార్చడంలో చిన్న సమస్య వచ్చింది, మళ్ళీ చెప్పండి?',
    'bn-IN': 'সময় বদলাতে একটু সমস্যা হয়েছে, আবার বলবেন?',
    'gu-IN': 'સમય બદલવામાં થોડી તકલીફ આવી, ફરી કહેશો?',
    'ml-IN': 'സമയം മാറ്റുന്നതിൽ ചെറിയ പ്രശ്നം വന്നു, ഒന്നുകൂടി പറയാമോ?',
    'od-IN': 'ସମୟ ବଦଳାଇବାରେ ଟିକେ ଅସୁବିଧା ହେଲା, ପୁଣି କହିବେ?'
  },
  cancelError: {
    'hi-IN': 'कैंसिल करने में थोड़ी दिक्कत आई, ज़रा दोबारा बताइएगा?',
    'mr-IN': 'रद्द करताना थोडी अडचण आली, पुन्हा सांगाल का?',
    'en-IN': 'There was a small issue cancelling that — could you try once more?',
    'kn-IN': 'ರದ್ದು ಮಾಡುವಲ್ಲಿ ಸ್ವಲ್ಪ ತೊಂದರೆ ಆಯಿತು, ಇನ್ನೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?',
    'pa-IN': 'ਰੱਦ ਕਰਨ ਵਿੱਚ ਥੋੜ੍ਹੀ ਦਿੱਕਤ ਆਈ, ਦੁਬਾਰਾ ਦੱਸੋਗੇ?',
    'ta-IN': 'ரத்து செய்வதில் சிறு சிக்கல் வந்தது, மீண்டும் சொல்லுங்கள்?',
    'te-IN': 'రద్దు చేయడంలో చిన్న సమస్య వచ్చింది, మళ్ళీ చెప్పండి?',
    'bn-IN': 'বাতিল করতে একটু সমস্যা হয়েছে, আবার বলবেন?',
    'gu-IN': 'રદ કરવામાં થોડી તકલીફ આવી, ફરી કહેશો?',
    'ml-IN': 'റദ്ദാക്കുന്നതിൽ ചെറിയ പ്രശ്നം വന്നു, ഒന്നുകൂടി പറയാമോ?',
    'od-IN': 'ବାତିଲ୍ କରିବାରେ ଟିକେ ଅସୁବିଧା ହେଲା, ପୁଣି କହିବେ?'
  },
  confirmCancel: {
    'hi-IN': 'क्या मैं आपकी अपॉइंटमेंट कैंसिल कर दूँ जी?', 'mr-IN': 'मी तुमची अपॉइंटमेंट रद्द करू का जी?',
    'en-IN': 'Shall I go ahead and cancel your appointment?',
    'kn-IN': 'ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ರದ್ದು ಮಾಡಲಾ ಜೀ?', 'pa-IN': 'ਕੀ ਮੈਂ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਰੱਦ ਕਰ ਦਿਆਂ ਜੀ?',
    'ta-IN': 'உங்கள் அப்பாயின்ட்மென்ட்டை ரத்து செய்யட்டுமா?', 'te-IN': 'మీ అపాయింట్‌మెంట్ రద్దు చేయనా జీ?',
    'bn-IN': 'আপনার অ্যাপয়েন্টমেন্ট বাতিল করে দেব কি?', 'gu-IN': 'શું હું તમારી એપોઇન્ટમેન્ટ રદ કરી દઉં?',
    'ml-IN': 'നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് റദ്ദാക്കട്ടെ?', 'od-IN': 'ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ବାତିଲ୍ କରିଦେବି କି?'
  },
  // Spoken when the model CLAIMED a move without an UPDATE sentinel (agentMayCancel on).
  confirmMove: {
    'hi-IN': 'क्या आप अपनी अपॉइंटमेंट का समय बदलना चाहते हैं जी? नया दिन और समय बताइए।',
    'mr-IN': 'तुम्हाला अपॉइंटमेंटची वेळ बदलायची आहे का जी? नवीन दिवस आणि वेळ सांगा.',
    'en-IN': 'Would you like to change your appointment time? Please tell me the new day and time.',
    'kn-IN': 'ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಸಮಯ ಬದಲಾಯಿಸಬೇಕಾ ಜೀ? ಹೊಸ ದಿನ ಮತ್ತು ಸಮಯ ಹೇಳಿ.',
    'pa-IN': 'ਕੀ ਤੁਸੀਂ ਆਪਣੀ ਅਪਾਇੰਟਮੈਂਟ ਦਾ ਸਮਾਂ ਬਦਲਣਾ ਚਾਹੁੰਦੇ ਹੋ ਜੀ? ਨਵਾਂ ਦਿਨ ਅਤੇ ਸਮਾਂ ਦੱਸੋ।',
    'ta-IN': 'உங்கள் அப்பாயின்ட்மென்ட் நேரத்தை மாற்ற வேண்டுமா? புதிய நாள் மற்றும் நேரத்தைச் சொல்லுங்கள்.',
    'te-IN': 'మీ అపాయింట్‌మెంట్ సమయం మార్చాలా జీ? కొత్త రోజు మరియు సమయం చెప్పండి.',
    'bn-IN': 'আপনি কি অ্যাপয়েন্টমেন্টের সময় বদলাতে চান? নতুন দিন ও সময় বলুন।',
    'gu-IN': 'શું તમે તમારી એપોઇન્ટમેન્ટનો સમય બદલવા માંગો છો? નવો દિવસ અને સમય જણાવો.',
    'ml-IN': 'നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് സമയം മാറ്റണോ? പുതിയ ദിവസവും സമയവും പറയൂ.',
    'od-IN': 'ଆପଣ ଆପଏଣ୍ଟମେଣ୍ଟ ସମୟ ବଦଳାଇବାକୁ ଚାହୁଁଛନ୍ତି କି? ନୂଆ ଦିନ ଏବଂ ସମୟ କୁହନ୍ତୁ।'
  }
};
// An appointment time the caller can actually hear, in their language.
//
// Both reschedule paths formatted this for themselves and only one of them
// existed — :987 passed no time at all, and the other built its own en-IN
// string ("Mon, 5:00 pm") and spoke the ENGLISH weekday into an Indic voice.
// That is the same leak a609ae9 fixed for the model's free text, arriving by a
// route the fix never covered: a canned line, which skips processLeanRaw.
// One formatter, used by both, so a third path cannot invent a third format.
function speakableTime(iso, context) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const en = d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const lang = replyLanguage(context);
  const loc = localizeDateTime(en, lang);
  return (loc && typeof loc === 'object') ? loc.text : (loc || en);
}

// THE reply-language decision for anything deterministic Ritu says or rewrites.
// languageCode is null on every Hindi/Marathi call (the pair is decided by
// hindiInCall), so a consumer that reads languageCode alone — as localizeSpoken
// did — resolves to "unknown" for the two languages most calls are in.
function replyLanguage(context) {
  return (context && context.languageCode) || ((context && context.hindiInCall) ? 'hi-IN' : 'mr-IN');
}

function cannedLine(key, context, args = {}) {
  const lang = replyLanguage(context);
  const table = CANNED_LINES[key] || {};
  let s = table[lang] || table['hi-IN'] || '';
  for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(v);

  // ─── NOTHING IN BRACES IS EVER SPOKEN ──────────────────────────────────────
  // This substituted whatever it was handed and returned the remainder as-is, so
  // a call site that forgot an argument produced a sentence with the placeholder
  // still in it — and canned lines skip cleanResponse, while sanitizeForSpeech
  // has no brace rule, so it went straight to TTS. Live templates could say
  // "आपकी अपॉइंटमेंट {time} कर दी है". A missing detail is a small failure; a
  // caller hearing the word "time" in curly braces is the product visibly
  // breaking in their ear.
  //
  // Strip rather than throw: this runs inside a live call, and a slightly less
  // specific sentence beats an exception on the turn that confirms a booking.
  // The log names the key and the argument so it is findable, and the test
  // suite asserts the real call sites supply what their template needs — the
  // log is the net, not the plan.
  const unresolved = s.match(/\{[a-zA-Z_]+\}/g);
  if (unresolved) {
    console.error(`[CANNED] '${key}' (${lang}) had unfilled ${unresolved.join(', ')} — spoken without it. Pass it at the call site.`);
    s = s.replace(/\s*\{[a-zA-Z_]+\}\s*/g, ' ');
  }
  // An argument supplied as '' leaves the same hole without any braces —
  // "मैंने  के लिए कॉलबैक लगा दिया है" — so collapse whitespace either way.
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.।!?])/g, '$1').trim();
}

// The alternative slot, as the caller will HEAR it.
//
// This returned the tool's raw `day_name` + `suggested_time` — English weekday
// names, straight into cannedLine('slotAlt'/'notWorking'/'slotTaken'). Canned
// lines never pass through processLeanRaw, so a609ae9's datetime guard could
// not see them on EITHER path, streamed or not. "Thursday 17:00" spoken to a
// caller who speaks only Hindi was the original defect; this was a second door
// into the same room, still open.
//
// The `context` argument is required rather than optional on purpose: an
// optional one is how the first version got called with no language and
// silently emitted English.
function fmtAlt(alt, context) {
  if (!alt) return '';
  // alt: { date, day_name, suggested_time }
  const raw = `${alt.day_name || ''} ${alt.suggested_time || ''}`.trim();
  return localizeSpoken(raw, context);
}

// LLM generation ONLY — builds the same messages getLeanResponse always built
// and returns the raw completion text. NO parsing, NO booking, NO side effects.
// Split out so callHandler can run it SPECULATIVELY during the endpoint hold on
// non-streamed turns; the side-effectful half (processLeanRaw: sentinel parse →
// DB write → spoken text) runs only at dispatch, exactly where it runs today.
async function generateLeanRaw(conversationHistory, context = {}) {
  const rosterSlice = sliceRoster(conversationHistory, context);
  if (rosterSlice.sliced) console.log(`[LEAN] Roster slice: ${rosterSlice.specs.join('+')} → ${rosterSlice.count}/${rosterSlice.total} doctors in detail`);
  // Tell the call what happened. A flag set in Railway is a CLAIM about
  // production; this is the per-call RECORD of whether it actually fired —
  // the same gap that let languagePinned read null for six calls while
  // calls.language said Hindi. Callback, not a return value, because both
  // brain entry points are wrapped in speculation machinery and threading a
  // second value through it would be far more invasive than this is worth.
  if (typeof context.onRosterSlice === 'function') {
    try { context.onRosterSlice(rosterSlice); } catch { /* observation must never break a call */ }
  }
  const messages = [
    { role: 'system', content: buildSystemPrompt({ ...context, rosterSlice }) },
    ...conversationHistory
  ];
  // 150 is a VOICE budget — a one-sentence spoken reply. Text replies carry 2-3
  // lines and 2 slot windows (prompt deltas D2/D3), and Devanagari costs more
  // tokens per character, so the same cap truncates mid-sentence. Derived from
  // the same context.channel as the prompt deltas so the two cannot drift.
  const maxTokens = context.channel === 'whatsapp' ? 300 : 150;
  const response = await completeWithFailover(messages, { temperature: 0.5, maxTokens });
  // Same callback shape as onRosterSlice, same reason: this is the ONLY place a
  // non-streamed request's token usage is visible (the streamed path reports
  // it on its 'done' chunk). Before this line existed, only streamed replies
  // were metered — the speculation, the fallback re-run and every text-channel
  // turn were spent but never counted, and the per-call LLM cost sat at 41%
  // of the truth (usageReportedTurns 97 vs brainTurns 237 over 30 days).
  if (typeof context.onLlmUsage === 'function') {
    try { context.onLlmUsage(response.usage); } catch { /* observation must never break a call */ }
  }
  return response.content || '';
}

async function getLeanResponse(conversationHistory, context = {}) {
  let raw;
  try {
    raw = await generateLeanRaw(conversationHistory, context);
  } catch (err) {
    console.error('[LEAN] LLM call failed:', err.message);
    return { text: cannedLine('retry', context), canned: true, booked: false, endCall: false, patientName: null, reason: null, emergency: false };
  }
  return processLeanRaw(raw, context);
}

// Parse the raw completion and execute its side effects (the booking DB write),
// then return the result object callHandler post-processes. This is the ONLY
// place a lean booking executes — speculative generation can never book.
async function processLeanRaw(raw, context = {}) {
  let text = cleanResponse(raw).trim();
  const endCall = /END_CALL:true/.test(raw);
  const emergency = /EMERGENCY_DETECTED:true/.test(raw);
  const nameMatch = raw.match(/PATIENT_NAME:\s*(.+)/);
  // A caller who answers "आपका नाम?" by echoing "your name?" used to have that
  // written to their record and read back to them on every future call. Eight
  // rows say "Unknown", two say "your name". cleanPersonName returns null
  // rather than a placeholder: not learning a name is a normal outcome, and
  // writing a fake one is how those eight rows happened.
  const rawName = nameMatch ? nameMatch[1].trim().split('\n')[0] : null;
  const patientName = cleanPersonName(rawName);
  if (rawName && !patientName) {
    console.log(`[LEAN] rejected as a name: ${JSON.stringify(rawName).slice(0, 40)}`);
  }

  const book = extractSentinel(raw, 'BOOK_APPOINTMENT');
  // NOTE: no `!context.appointmentBooked` guard — bookAppointmentTool keeps ONE
  // row per (patient, doctor) and a different-time re-book MOVES that row
  // (action:'rescheduled'), so a second BOOK_APPOINTMENT is the reschedule path,
  // not a double-booking risk. The old guard silently ignored the sentinel while
  // the model's text claimed "पक्का कर दिया" — patient heard tomorrow 10am, DB
  // and WhatsApp said today 5pm (live call 2026-07-07).
  if (book) {
    const doctor = resolveDoctor(book.doctor);
    if (!doctor) {
      // ALWAYS override the model text here: it emitted BOOK_APPOINTMENT, so its
      // spoken line almost certainly claims success ("हो गया जी!") — but nothing
      // was booked. Never speak a confirmation for a booking that didn't happen.
      console.warn(`[LEAN] booking for unknown/ambiguous doctor "${book.doctor}" — refusing, asking again`);
      return {
        text: cannedLine('unknownDoctor', context),
        failKind: 'unknown_doctor',
        canned: true, booked: false, endCall: false, patientName,
        reason: reasonSupported(context.patientTextAll, book.reason) ? (book.reason || null) : null, emergency
      };
    }
    const reasonForRecord = reasonSupported(context.patientTextAll, book.reason) ? book.reason : null;
    if (book.reason && !reasonForRecord) {
      console.warn(`[LEAN] SAFETY: booking reason ${JSON.stringify(book.reason)} is not supported by anything the caller said — not written to the record`);
    }
    try {
      const result = await timedTool(context, () => bookAppointmentTool.execute(
        {
          patient_name: book.patientName || context.patientName || patientName,
          doctor_id: doctor.id,
          appointment_datetime: book.dateTime,
          // THE RECORD MUST NOT CARRY A COMPLAINT THE CALLER NEVER MADE. The
          // model's reason is written to appointments.reason and is the first
          // thing the doctor reads. If it names a specialty nothing the caller
          // said supports, it was invented — the booking proceeds, the reason
          // does not. A non-clinical reason ("checkup") has nothing to
          // contradict and is kept.
          reason: reasonForRecord
        },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone, channel: context.channel, callSid: context.callSid }
      ));
      // VERIFIED-THEN-SPEAK, taken literally: success is not the evidence, the ROW
      // is. Every genuine path out of bookAppointmentTool carries an
      // appointment_id — fresh insert (:327, :384) and idempotent re-read (:311) —
      // so success WITHOUT one means the tool believes it worked while offering
      // nothing that proves a row exists.
      // This branch used to accept bare `result.success` and go on to speak a
      // past-tense confirmation, which is precisely the defence-in-depth case
      // tests/test-false-confirmation-invariant.js exists to forbid: a spoken
      // booking claim with no committed row behind it. Fixing `booked` alone was
      // not enough — the FLAG was corrected but the SENTENCE was still spoken, and
      // the sentence is what the patient hears.
      // Treated as a booking failure rather than silently downgraded, because a
      // caller who is told nothing will call back, while a caller who is told
      // "बुक कर दी है" will simply arrive.
      if (result.success && !result.appointment_id) {
        console.error('[LEAN] SAFETY: bookAppointment returned success with NO appointment_id — refusing to confirm a booking with no row behind it');
        return {
          text: cannedLine('bookingError', context),
          failKind: 'no_appointment_id',
          canned: true, booked: false, endCall: false,
          patientName, reason: reasonForRecord || null, emergency
        };
      }
      if (result.success) {
        // The slot we just took is gone NOW, not in 45 seconds. Without this a
        // caller who books and then asks for a second appointment — or the next
        // caller inside the same TTL — gets offered the slot that was just
        // filled, which is the exact failure this list exists to prevent.
        // force:true, fire-and-forget: the confirmation must not wait on it.
        refreshTakenSlots({ force: true }).catch(() => {});
        // Verified-then-speak on the UTTERANCE too. The DB is committed, so the
        // spoken line must state the booking as DONE. The model sometimes emits
        // BOOK_APPOINTMENT (which books) yet phrases its own text as a QUESTION
        // ("…बुक करूँ?"), so Ritu asked "shall I book?" AFTER already booking and
        // the patient had to repeat "yes, do it" two or three times. If the model
        // gave no text or a future-tense booking-question, override with a warm
        // past-tense confirmation. (Only future-tense "shall I book" forms are
        // caught, so a proper "बुक कर दिया, और कुछ?" is kept as-is.)
        const isBookingQuestion =
          /बुक\s*करूँ|बुक\s*करूं|बुक\s*कर\s*दूँ|बुक\s*कर\s*दूं|book\s*kar(o|un|un ?ga)?\b|ಬುಕ್\s*ಮಾಡಲ|ਬੁੱਕ\s*ਕਰ\s*ਦ|ਪੱਕਾ\s*ਕਰ\s*ਦ|புக்\s*செய்யட்டுமா|బుక్\s*చేయ(నా|మంటారా)|বুক\s*করব|બુક\s*કરું|ബುക്ക്\s*ചെയ്യട്ടെ|ବୁକ୍\s*କରିବି/i.test(text || '') ||
          /(shall|should)\s+i\s+book/i.test(text || '');
        const isReschedule = result.action === 'rescheduled';
        // A SECOND ROW IN A CALL THAT ALREADY HOLDS ONE. Since migration 013 a
        // BOOK for the same doctor on a different day is a fresh INSERT, not a
        // move — a laser course is six sittings — so the call may now legitimately
        // hold two. But the model was, until today, told the system would MOVE,
        // and its own text will say so. Whatever it says, the caller must hear
        // the truth: a second appointment exists and the first one still stands.
        // Always canned on this branch; the model's text is the thing being
        // corrected.
        const first = context.bookedThisCall;
        const isSecond = !!(first && first.appointment_id && result.appointment_id
          && result.appointment_id !== first.appointment_id && !isReschedule && !result.idempotent);
        if (isSecond) console.log(`[LEAN] second appointment in this call — first ${first.appointment_id} stays; saying so`);
        // {time} is required by the `rescheduled` template and was not passed —
        // see the note where the shadowed duplicate used to live. `booked` takes
        // no time, so passing one is harmless there and keeps this one call.
        // The attribution gate below this block never sees a booking turn —
        // every branch here returns. An invented complaint in the model's own
        // confirmation ("आपको पेट दर्द की परेशानी है तो … बुक कर दिया") is
        // spoken through the canned confirmation instead, which carries none.
        const bookingDrift = !!(text && unsupportedAttributions(context.patientTextAll, text).length);
        if (bookingDrift) console.warn(`[LEAN] SYMPTOM DRIFT in a booking confirmation — canned line instead: "${text.slice(0, 80)}"`);
        const confirmText = isSecond
          ? cannedLine('bookedSecond', context,
              { doctor: doctor.name, time: speakableTime(result.appointment_time, context),
                firstTime: speakableTime(first.appointment_time, context) })
          : (!text || isBookingQuestion || bookingDrift)
            ? cannedLine(isReschedule ? 'rescheduled' : 'booked', context,
                { doctor: doctor.name, time: speakableTime(result.appointment_time, context) })
            : text;
        return {
          text: confirmText,
          canned: isSecond || !text || isBookingQuestion || bookingDrift, // hardcoded hi/mr override — not the model's language choice
          // booked answers the SAFETY question — "is there a committed appointment
          // behind what we just said?" — NOT the analytics question "did THIS turn
          // insert a row?". It was `!result.idempotent`, which conflated the two.
          //
          // LIVE CALL d487e311, 2026-07-27. The caller already had a booked 5pm
          // slot with Dr. Manoj Deo from the previous evening's call. The model
          // emitted BOOK_APPOINTMENT for that same doctor and time;
          // bookAppointmentTool correctly found the active row and returned
          // {success:true, idempotent:true} — no INSERT needed, and NO LOG LINE,
          // because every success path in that tool is silent. `booked` therefore
          // came back false while an appointment demonstrably existed, so:
          //   - callHandler never set appointmentBooked (no [BOOKING] line either)
          //   - crm.js skipped the WhatsApp confirmation — the patient was told
          //     "बुक कर दी है" on the phone and got NOTHING in writing
          //   - calls.outcome was written as 'inquiry_only' with appointment_id NULL
          //   - the call summary said booked:false
          // Ritu spoke the truth; the record contradicted her. An idempotent hit
          // is a CONFIRMED booking — the strongest possible evidence, since the row
          // was already there — and must be reported as one.
          // ...but "true" unconditionally was one step too far, and
          // tests/test-false-confirmation-invariant.js caught it: the
          // DEFENCE-IN-DEPTH case is a tool returning {success:true} with NO
          // appointment_id, where there is no evidence of a committed row at all.
          // Hardcoding true made a spoken confirmation stand on that, breaking the
          // one invariant this whole path exists to hold — a spoken booking claim
          // ⟺ a committed row.
          // Keying on the id keeps the d487e311 fix intact, because EVERY genuine
          // success path returns one: the fresh insert (bookAppointment.js:327,
          // :384) and the idempotent re-read (:311). So an idempotent hit still
          // reports booked=true — it has a row id, which is the strongest possible
          // evidence — while success-without-a-row now correctly reports false.
          booked: !!result.appointment_id,
          // Kept separate so analytics can still ask "did this turn create it?"
          // without that question ever leaking back into a safety decision.
          bookedThisTurn: !result.idempotent,
          booking: result, appointmentTime: book.dateTime,
          patientName: book.patientName || patientName,
          // The same vetting the appointment row got — calls.reason and the Sheet
          // read this field, and an invented complaint must reach neither.
          reason: reasonSupported(context.patientTextAll, book.reason) ? (book.reason || null) : null,
          endCall, emergency
        };
      }
      // ─── SEVEN REASONS, ONE SENTENCE — until 2026-08-15 ────────────────
      // bookAppointment can fail for seven distinct reasons and every one of
      // them was spoken as "उस समय उपलब्ध नहीं" (that time is not available)
      // and logged as failKind:'slot_unavailable'. Five of the seven are not
      // about availability at all:
      //
      //   on_call ......... the doctor takes callbacks, not appointments — and
      //                     tools/bookAppointment already returns
      //                     hint:'route_to_callback', which nothing read. We
      //                     built the callback path in 79f2677 and this branch
      //                     walked straight past it.
      //   not_working ..... the doctor is off that DAY. "Another time?" sends
      //                     the caller back with the same question; they need
      //                     another DAY. Live call fc3ba30a was offered a
      //                     Sunday, accepted, got the generic rejection, and
      //                     worked out the clinic was shut herself.
      //   slot_taken ...... the only case where the old sentence was true
      //   bad_input ....... our bug, not the clinic's
      //   no_such_doctor .. our bug
      //   state_changed ... a retry, not a refusal
      //
      // The tool now says which; this speaks accordingly. error_message stays
      // ENGLISH and stays in the LOG — a Marathi caller heard one of those on
      // 2026-08-12 (f00b16f) and the rule since then is that developer text
      // never reaches TTS.
      const alt = fmtAlt((result.alternatives || [])[0], context);
      const kind = result.fail_kind || 'slot_unavailable';
      const doctorName = (result && result.doctor_name) || (book && book.doctor) || '';

      if (kind === 'on_call') {
        // Not a refusal at all — the callback flow is the correct answer, and
        // it exists. Hand the turn back to the model with the instruction
        // rather than inventing a callback here: REQUEST_CALLBACK is
        // verified-then-speak and must go through its own path.
        console.log(`[LEAN] booking refused: on-call specialist — routing to callback (${doctorName})`);
        return {
          text: cannedLine('onCallUseCallback', context, { doctor: doctorName }),
          failKind: 'on_call', canned: true, booked: false, endCall: false,
          patientName, reason: book.reason || null, emergency
        };
      }
      if (kind === 'not_working' || kind === 'day_off' || kind === 'on_leave') {
        return {
          text: alt
            ? cannedLine('notWorking', context, { doctor: doctorName, alt })
            : cannedLine('notWorkingNoAlt', context, { doctor: doctorName }),
          failKind: kind, canned: true, booked: false, endCall: false,
          patientName, reason: book.reason || null, emergency
        };
      }
      if (kind === 'slot_taken') {
        return {
          text: alt ? cannedLine('slotTaken', context, { alt }) : cannedLine('slotNoAlt', context),
          failKind: 'slot_taken', canned: true, booked: false, endCall: false,
          patientName, reason: book.reason || null, emergency
        };
      }
      if (kind === 'bad_input' || kind === 'no_such_doctor' || kind === 'state_changed') {
        // Ours to fix, not the caller's to work around. Say the honest thing
        // and let them retry, rather than blaming the schedule.
        console.error(`[LEAN] booking failed for an ENGINEERING reason (${kind}): ${result.error_message}`);
        return {
          text: cannedLine('bookingError', context),
          failKind: kind, canned: true, booked: false, endCall: false,
          patientName, reason: book.reason || null, emergency
        };
      }
      return {
        text: alt ? cannedLine('slotAlt', context, { alt }) : cannedLine('slotNoAlt', context),
        // The clinic can ACT on this one — open more slots. Distinct from the
        // machinery failing, which is an engineering ticket.
        failKind: 'slot_unavailable',
        canned: true, booked: false, endCall: false, patientName,
        reason: reasonSupported(context.patientTextAll, book.reason) ? (book.reason || null) : null, emergency
      };
    } catch (err) {
      console.error('[LEAN] booking error:', err.message);
      // NEVER speak the model's text on a booking exception — it almost certainly
      // said "हो गया / booked", but the booking threw and NOTHING persisted. Only
      // the canned error is safe here (same false-confirmation guard, sentinel path).
      return { text: cannedLine('bookingError', context), failKind: 'threw', canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
    }
  }

  // ── RESCHEDULE, CROSS-CALL (find the caller's appointment, then MOVE it) ──
  //
  // WHY THIS EXISTS. Prompt rule 7 tells the model to reschedule by re-emitting
  // BOOK_APPOINTMENT with the new dateTime, and the upsert in bookAppointment
  // moves the row:
  //     ON CONFLICT (clinic_id, patient_id, doctor_id) WHERE status='booked'
  //     DO UPDATE SET appointment_time = EXCLUDED.appointment_time
  // That works, but ONLY inside the call that made the booking — because the
  // conflict key contains doctor_id, and only then does she know the doctor.
  //
  // A patient ringing back about an appointment made EARLIER is the entire
  // second-visit path, and there she has no doctor context. Both observed
  // outcomes were wrong, and non-deterministically so:
  //   · she guesses a doctor → different doctor_id → NO conflict → a SECOND
  //     appointment is created while the original stays live. The patient is now
  //     on the day sheet twice, in two specialties, and the reminder still fires
  //     for the slot they believe they moved.
  //   · she asks "किस डॉक्टर के साथ?" and keeps asking, because the answer is
  //     something the system can look up and she cannot.
  //
  // find_patient_appointment is phone-scoped and returns the doctor, so the one
  // fact blocking the move was already available — it was simply only ever wired
  // to the CANCEL sentinel. brain.js (the legacy non-lean brain) has had
  // UPDATE_APPOINTMENT since the beginning; production runs lean, and it was
  // never ported. brain-streaming.js has been watching for the sentinel all
  // along (line 50), waiting for an emitter that did not exist.
  //
  // Mirrors CANCEL exactly, including the rule that matters: the spoken
  // confirmation is CANNED and produced ONLY on result.success, so "बदल दिया"
  // can never outrun the committed row.
  const move = extractSentinel(raw, 'UPDATE_APPOINTMENT');
  // LAYER 2 of 3. The prompt no longer teaches this sentinel when the clinic
  // reserves rescheduling for its staff — but a model that was never taught a
  // token can still emit one, and "the prompt says not to" is a request rather
  // than a guarantee. Refuse here, say who does it, and log that it happened.
  if (move && !config.agentMayReschedule) {
    console.warn('[POLICY] UPDATE_APPOINTMENT suppressed — agentMayReschedule=false');
    // The line she speaks promises "I'll note your request, the clinic will
    // call you" — so the request must exist as a row before it is spoken.
    const noted = await noteStaffRequest('reschedule', move, context, patientName);
    if (!noted) {
      return { text: cannedLine('callbackError', context), canned: true, booked: false,
               cancelled: false, endCall: false, patientName, reason: null, emergency };
    }
    return { text: cannedLine(config.agentMayCancel ? 'moveStaffOnly' : 'cancelPolicy', context), canned: true, booked: false,
             cancelled: false, callbackRequested: true, endCall: false, patientName, reason: null, emergency };
  }
  if (move && move.dateTime) {
    try {
      const found = await timedTool(context, () => findPatientAppointmentTool.execute(
        { patient_name: move.patientName || context.patientName || patientName },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone, currentDatetime: context.currentDatetime, channel: context.channel, callSid: context.callSid }
      ));
      let appts = (found && found.appointments) || [];
      // Caller named a doctor and several appointments exist → prefer that one.
      if (move.doctor && appts.length > 1) {
        const d = resolveDoctor(move.doctor);
        if (d) { const only = appts.filter(a => a.doctor_id === d.id); if (only.length) appts = only; }
      }
      // A change of mind about a booking made IN THIS CALL targets that row,
      // not the soonest upcoming one — with a course on file the two differ.
      // Rule 7(a) now routes same-call changes here (013 made a cross-day BOOK
      // re-emit an insert), so this is the path that keeps "kal karo" a MOVE.
      if (context.bookedThisCall && context.bookedThisCall.appointment_id && appts.length > 1) {
        const own = appts.filter(a => a.appointment_id === context.bookedThisCall.appointment_id);
        if (own.length) appts = own;
      }
      if (!appts.length) {
        // Nothing to move. Say so and offer to book — NEVER silently create a new
        // appointment, which is the duplicate this whole path exists to prevent.
        return { text: cannedLine('cancelNothing', context), canned: true, booked: false, cancelled: false, endCall: false, patientName, reason: null, emergency };
      }
      // Same guard as the cancel path below — a MOVE is destructive too: the
      // wrong family member's visit silently changes date. The sentinel here is
      // `move`, so it is move.patientName (what the caller said) that counts,
      // never context.patientName (the newest-registered name on the handset).
      const registeredOnPhone = (found && found.distinct_patient_names) || [];
      if (!(move.patientName && String(move.patientName).trim()) && registeredOnPhone.length > 1) {
        console.log(`[RESCHEDULE] ambiguous — ${registeredOnPhone.length} patients on this number, asking which`);
        return { text: cannedLine('whichPatient', context, { names: registeredOnPhone.join(' / ') }),
                 canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
      }
      const target = appts[0];                    // soonest upcoming, or doctor-matched
      const result = await timedTool(context, () => updateAppointmentTool.execute(
        { appointment_id: target.appointment_id, new_datetime: move.dateTime },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone, currentDatetime: context.currentDatetime, channel: context.channel, callSid: context.callSid }
      ));
      if (result && result.success) {
        // Speak the time the TOOL wrote, not the time the model asked for. If
        // availability nudged it, the patient must hear where it actually landed.
        // Was a bare en-IN toLocaleString, so a Kannada caller was told their
        // appointment moved to "Mon, 5:00 pm" — an English weekday spoken by the
        // Kannada voice. Same formatter as the other reschedule path now.
        const when = speakableTime(result.new_appointment_time, context);
        console.log(`[BOOKING] rescheduled — ${result.doctor_name} to ${result.new_appointment_time} (appt ${target.appointment_id})`);
        // `booking` + `appointmentTime` are what callHandler records from a fresh
        // booking (appointmentTime/appointmentId → the call-end WhatsApp and the
        // calls row). A move used to return neither, so the closing WhatsApp
        // said "your scheduled time" with no time — module 6 follow-up 2026-09-17.
        return { text: cannedLine('rescheduled', context, { doctor: result.doctor_name, time: when }),
                 canned: true, booked: true, bookedThisTurn: false, rescheduled: true,
                 rescheduledAppointment: { ...target, new_appointment_time: result.new_appointment_time },
                 booking: { appointment_id: target.appointment_id, appointment_time: result.new_appointment_time, doctor_name: result.doctor_name || target.doctor_name || null },
                 appointmentTime: result.new_appointment_time,
                 endCall, patientName, reason: null, emergency };
      }
      // The tool refused (slot taken, past appointment, unavailable). Its
      // error_message is written to be spoken, so prefer it over a generic line.
      return { text: result && result.error_message ? result.error_message : cannedLine('rescheduleError', context),
               canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
    } catch (err) {
      console.error('[LEAN] reschedule error:', err.message);
      return { text: cannedLine('rescheduleError', context), canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
    }
  }

  // ── CANCEL (real cancellation — mirrors the booking path) ─────────────────
  // find_patient_appointment is phone-scoped (only THIS caller's future booked
  // appointments), then update_appointment sets status='cancelled'. We speak a
  // true confirmation ONLY on result.success — never a hallucinated "cancelled".
  // ─── CALLBACK (verified-then-speak, exactly like booking and cancel) ──────
  // brain-lean tells Ritu to promise a callback for an on-call specialist. Until
  // now there was no way to record one: the sentinel did not exist, so the
  // promise was pure speech. MEASURED 2026-08-11 — 11 active on-call doctors,
  // 0 rows in callbacks. A patient asked for a neurologist, heard "मैं कॉलबैक
  // लगा देती हूँ", hung up satisfied, and no human ever saw that they called.
  // Nothing errored and nothing logged, so the clinic could not discover it.
  const cb = extractSentinel(raw, 'REQUEST_CALLBACK');
  if (cb) {
    try {
      const res = await timedTool(context, () => requestCallbackTool.execute(
        {
          patient_name: cb.patientName || context.patientName || patientName || 'Unknown',
          specialty: cb.specialty || '',
          reason: cb.reason || null, // `reason` was an undeclared identifier → ReferenceError on every reason-less request (audit 2026-09-18)
        },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone }
      ));
      if (res && res.success) {
        console.log(`[CALLBACK] logged — ${res.specialty || cb.specialty} for ${context.callerPhone} (id ${res.callback_id || '?'})`);
        return { text: cannedLine('callbackArranged', context, { specialty: res.specialty || cb.specialty || '' }),
                 canned: true, booked: false, callbackRequested: true,
                 endCall, patientName, reason: null, emergency };
      }
      // The tool refused — an unknown specialty, a bad phone, or a duplicate.
      //
      // NEVER SPEAK error_message. I wrote "its error_message is written to be
      // spoken, so prefer it" here on 2026-08-11 and it was simply false: those
      // strings are English developer text. LIVE CALL a386bf99, 2026-08-12,
      // a Marathi conversation, twice in a row:
      //
      //   Ritu  Specialty "Oncologist" is not recognized as an on-call specialty.
      //
      // Then the caller hung up. The English goes to the LOG, where the person
      // who can fix it will read it; the patient hears the localised line in
      // the language they are speaking.
      console.warn(`[CALLBACK] refused — ${res && res.error_message}`);
      return { text: cannedLine('callbackError', context),
               canned: true, booked: false, callbackRequested: false,
               endCall: false, patientName, reason: null, emergency };
    } catch (err) {
      // NEVER speak "callback arranged" after a failed write. Same rule the
      // booking path follows: a spoken promise must have a committed row.
      console.error('[LEAN] callback error:', err.message);
      return { text: cannedLine('callbackError', context), canned: true, booked: false,
               callbackRequested: false, endCall: false, patientName, reason: null, emergency };
    }
  }

  const cancel = extractSentinel(raw, 'CANCEL_APPOINTMENT');
  // Layer 2, cancel side. See the note at UPDATE_APPOINTMENT above.
  if (cancel && !config.agentMayCancel) {
    console.warn('[POLICY] CANCEL_APPOINTMENT suppressed — agentMayCancel=false');
    const noted = await noteStaffRequest('cancel', cancel, context, patientName);
    if (!noted) {
      return { text: cannedLine('callbackError', context), canned: true, booked: false,
               cancelled: false, endCall: false, patientName, reason: null, emergency };
    }
    return { text: cannedLine(config.agentMayReschedule ? 'cancelStaffOnly' : 'cancelPolicy', context), canned: true, booked: false,
             cancelled: false, callbackRequested: true, endCall: false, patientName, reason: null, emergency };
  }
  if (cancel) {
    try {
      const found = await timedTool(context, () => findPatientAppointmentTool.execute(
        { patient_name: cancel.patientName || context.patientName || patientName },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone, currentDatetime: context.currentDatetime, channel: context.channel, callSid: context.callSid }
      ));
      let appts = (found && found.appointments) || [];
      // If the caller named a doctor and several appointments exist, prefer that one.
      if (cancel.doctor && appts.length > 1) {
        const d = resolveDoctor(cancel.doctor);
        if (d) { const only = appts.filter(a => a.doctor_id === d.id); if (only.length) appts = only; }
      }
      if (!appts.length) {
        // Nothing to cancel — honest line, NEVER a false "cancelled".
        return { text: cannedLine('cancelNothing', context), canned: true, booked: false, cancelled: false, endCall: false, patientName, reason: null, emergency };
      }
      // ─── NEVER GUESS WHICH FAMILY MEMBER ────────────────────────────────
      // patients is UNIQUE (clinic_id, phone, name) and db.js says why: "a
      // later real name creates a distinct row (family-friendly)". Several
      // people per handset is a designed-for state, and shared phones are the
      // norm in Indian clinics. appts is ordered appointment_time ASC, so
      // appts[0] cancels whoever is due SOONEST — the worst possible tie-break,
      // because the family member about to be seen is the one who loses the slot.
      //
      // THE TEST IS "DID THE CALLER NAME SOMEONE", not findPatientAppointment's
      // `ambiguous` flag. That flag requires patient_name to be EMPTY, and the
      // dangerous case is a name that is present and WRONG: context.patientName
      // comes from getReturningPatientName (db.js:56) = ORDER BY created_at DESC
      // LIMIT 1, the most recently REGISTERED name on the handset, not whoever
      // is on the line. So Ritu can greet Papa as "Rahul जी", narrow the lookup
      // to '%rahul%', cancel the son's appointment, and report ambiguous=false.
      // cancel.patientName is different: it is what the MODEL heard the CALLER
      // say. Only that counts as the caller choosing.
      //
      // Nothing downstream would have caught it. confirmCancel asks "क्या मैं
      // आपकी अपॉइंटमेंट कैंसिल कर दूँ जी?" and `cancelled` interpolates only
      // {doctor} — for a family sharing a GP that is right for BOTH people.
      const registeredOnPhone = (found && found.distinct_patient_names) || [];
      const callerNamedSomeone = !!(cancel.patientName && String(cancel.patientName).trim());
      if (!callerNamedSomeone && registeredOnPhone.length > 1) {
        console.log(`[CANCEL] ambiguous — ${registeredOnPhone.length} patients on this number, asking which`);
        return { text: cannedLine('whichPatient', context, { names: registeredOnPhone.join(' / ') }),
                 canned: true, booked: false, cancelled: false, endCall: false,
                 patientName, reason: null, emergency };
      }
      const target = appts[0]; // soonest upcoming (or the doctor-matched one)
      const result = await timedTool(context, () => updateAppointmentTool.execute(
        { appointment_id: target.appointment_id, cancel: true },
        { pool: db.pool, clinicId: context.clinicId || config.clinicId, patientPhone: context.callerPhone, currentDatetime: context.currentDatetime, channel: context.channel, callSid: context.callSid }
      ));
      if (result && result.success) {
        return { text: cannedLine('cancelled', context, { doctor: target.doctor_name }), canned: true, booked: false, cancelled: true, cancelledAppointment: target, endCall, patientName, reason: null, emergency };
      }
      return { text: cannedLine('cancelError', context), canned: true, booked: false, cancelled: false, endCall: false, patientName, reason: null, emergency };
    } catch (err) {
      console.error('[LEAN] cancel error:', err.message);
      return { text: cannedLine('cancelError', context), canned: true, booked: false, cancelled: false, endCall: false, patientName, reason: null, emergency };
    }
  }

  // SAFETY — false-confirmation guard. No BOOK_APPOINTMENT sentinel fired, so
  // NOTHING was booked. But a weak model (3.1-flash-lite) sometimes still SPEAKS a
  // done-confirmation ("हो गया / बुक कर दिया") — which would leave the patient
  // thinking they're booked when they are not. NEVER let that stand: suppress it
  // and re-ask; the model reliably emits the sentinel on the next clean "yes".
  // CANCEL guard FIRST — a cancel phrase ("अपॉइंटमेंट कैंसिल कर दी") also trips the
  // booking regex on "कर दी", so check cancel before booking to re-ask with the
  // CORRECT intent. Model claimed a cancellation but emitted no CANCEL_APPOINTMENT
  // sentinel → nothing was cancelled. Suppress the false confirmation + re-ask.
  // Detector regexes live in confirmGuards.js (PURE module) so the immune
  // suite replays the LIVE patterns — no stale copies. Fixed 2026-07-22
  // against the frozen 46-item corpus: 46/46 agreement (was 36/46 — added the
  // भेज-दी/sent class, mr निश्चित-केली, kn sandhi ಖಚಿತವಾಗಿದೆ, the 28-char
  // appointment window; future कर-दूंगी and negative बुक-झाली-नाही /
  // "not cancelled" no longer overtrigger).
  if (text && claimsCancelled.test(text)) {
    console.warn('[LEAN] SAFETY: model claimed a CANCELLATION WITHOUT a CANCEL_APPOINTMENT sentinel — suppressing, re-asking');
    return { text: cannedLine('confirmCancel', context), canned: true, booked: false, cancelled: false, endCall: false, patientName, reason: null, emergency };
  }
  // Skip once the appointment genuinely exists: post-booking, a truthful "जी हाँ,
  // बुक हो गया है" reaffirmation is CORRECT — suppressing it into "shall I confirm?"
  // created a confusing re-confirm loop. (claimsCancelled still fires post-booking:
  // a cancel needs its own sentinel.)
  // A MOVE claim is never licensed without an UPDATE/BOOK sentinel in the
  // same turn, and this branch only runs when no sentinel acted. Unlike
  // claimsBooked it must fire post-booking too — that is exactly when moves
  // are claimed ("kal karo" → "बदल दिया है", nothing moved).
  if (text && claimsMoved.test(text)) {
    console.warn(`[LEAN] FALSE MOVE CLAIM — no sentinel acted: "${text.slice(0, 80)}"`);
    const key = config.agentMayReschedule ? 'confirmMove' : (config.agentMayCancel ? 'moveStaffOnly' : 'cancelPolicy');
    return { text: cannedLine(key, context), canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
  }
  if (text && !context.appointmentBooked && claimsBooked.test(text)) {
    console.warn('[LEAN] SAFETY: model claimed a booking WITHOUT a BOOK_APPOINTMENT sentinel — suppressing the false confirmation, re-asking');
    return { text: cannedLine('confirmBooking', context), canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
  }
  // ─── A COMPLAINT THE CALLER NEVER STATED IS NOT SPOKEN AS FACT ─────────
  // Live call b2045aa9: the caller asked whether a doctor was in and until
  // when; Ritu said "पेट दर्द की परेशानी है तो डॉ. दिव्या साने …" and booked a
  // gastroenterologist. The guard that catches this ran once, at call end,
  // into diagnostics. It now runs here, on the narrow frame "X की परेशानी है"
  // (measured: 24 of 748 real turns carry the frame, exactly one unsupported —
  // that call). First time in a call: ask what the trouble is. After that,
  // strip the clause rather than loop.
  const invented = unsupportedAttributions(context.patientTextAll, text);
  if (text && invented.length) {
    console.warn(`[LEAN] SAFETY: reply asserts a complaint the caller never stated (${invented.map((x) => x.fragment + '→' + x.specialty).join(', ')}) — ${context.driftReasked ? 'stripping the clause' : 'asking instead'}`);
    if (!context.driftReasked) {
      return { text: cannedLine('askComplaint', context), canned: true, booked: false, endCall: false,
               patientName, reason: null, emergency, symptomDrift: invented };
    }
    for (const x of invented) text = assertedClauses(text).filter((c) => !c.includes(x.fragment)).join(' ');
  }
  // Send-claims ("मैंने WhatsApp पर भेज दी हैं") are the same tense-discipline
  // violation: nothing is sent until the post-booking confirmation actually
  // fires. Pre-booking, suppress + steer back to booking. [fc06/07/40]
  if (text && !context.appointmentBooked && claimsSent.test(text)) {
    console.warn('[LEAN] SAFETY: model claimed a SEND without any committed action — suppressing, re-asking');
    return { text: cannedLine('confirmBooking', context), canned: true, booked: false, endCall: false, patientName, reason: null, emergency };
  }
  // ─── NO MACHINE DATES REACH THE SPEAKER ────────────────────────────────
  // LIVE CALL c394b280c4808227d8e28c957d231a8d, 2026-08-13, a Hindi call:
  //     RITU  उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?
  // An English weekday and a 24-hour clock, read aloud by an Indic TTS voice to
  // a caller who had spoken only Hindi. Same class as the REQUEST_CALLBACK
  // sentinel a patient heard two days earlier (42cb33f) — machine-shaped text
  // reaching a human ear because nothing stood between the model and the
  // speaker.
  //
  // Applied to the FREE-TEXT return only. Canned lines are already written in
  // all 11 languages and cannot leak this; running the pass over them would be
  // work with no defect behind it. The prompt already asks for the caller's
  // language and the model almost always complies — but "almost always" is not
  // testable, and this is the second rare formatting choice in three days to
  // reach a patient's ear.
  return { text: localizeSpoken(text, context), booked: false, endCall, patientName, reason: book?.reason || null, emergency };
}

// ─── THE DATETIME LOCALISER, ON EVERY PATH THAT REACHES A VOICE ─────────────
// a609ae9 stopped "Thursday 17:00" being spoken to a Hindi-only caller, and
// wired the fix at exactly ONE call site: here, inside processLeanRaw. The
// STREAMED path never passes through processLeanRaw — getLeanResponseStream
// yields sentences straight to speakStream — so on the path production actually
// takes, the guard did not exist. The mutation test that proved a609ae9 was
// "unwire it from processLeanRaw", which passes whether or not streaming is
// covered.
//
// One function, used by all three emit points (non-streamed reply, streamed
// sentence, streamed tail), so a fourth cannot quietly skip it.
function localizeSpoken(text, context) {
  if (!text) return text;
  const loc = localizeDateTime(text, replyLanguage(context));
  if (loc.leaks.length) {
    console.warn(`[LEAN] machine date/time in a spoken reply (${replyLanguage(context)}): ${loc.leaks.join(', ')}${loc.changed ? ' — rewritten' : ' — NO table for this language, left as-is'}`);
  }
  return loc.text;
}

// Streamed-path false-confirmation detector — the SAME detector as the
// non-streamed path, derived from claimsBooked|claimsCancelled|claimsSent in
// confirmGuards.js. It used to be a looser regex of its own, and the gap between
// the two let a bare "हो गया जी!" — the exact opening the prompt's rule 5 asks
// for — stream out with no row behind it, twice. See confirmGuards.js.
const { claimsCancelled, claimsBooked, claimsSent, STREAMED_FALSE_CONFIRM, claimsMoved } = require('./confirmGuards');

// Streaming variant of getLeanResponse for callHandler.speakStream(): yields the
// reply sentence-by-sentence so TTS starts on sentence 1 while gemini is still
// generating the rest — this is what makes the warm 2-sentence replies latency-free.
// BOOKING SAFETY (load-bearing): booking must stay verified-then-speak, so the moment
// a BOOK_APPOINTMENT sentinel appears we hand off ('fallback-required') and the caller
// re-runs the non-streaming getLeanResponse (DB write, THEN speak). Same yield contract
// + reused sentence/sentinel helpers as brain-streaming.getResponseStream. The caller
// (callHandler) also pre-routes the actual confirm turn away from streaming, so this
// backstop almost never fires.
async function* getLeanResponseStream(conversationHistory, context = {}) {
  const rosterSlice = sliceRoster(conversationHistory, context);
  if (rosterSlice.sliced) console.log(`[LEAN] Roster slice: ${rosterSlice.specs.join('+')} → ${rosterSlice.count}/${rosterSlice.total} doctors in detail`);
  // Tell the call what happened. A flag set in Railway is a CLAIM about
  // production; this is the per-call RECORD of whether it actually fired —
  // the same gap that let languagePinned read null for six calls while
  // calls.language said Hindi. Callback, not a return value, because both
  // brain entry points are wrapped in speculation machinery and threading a
  // second value through it would be far more invasive than this is worth.
  if (typeof context.onRosterSlice === 'function') {
    try { context.onRosterSlice(rosterSlice); } catch { /* observation must never break a call */ }
  }
  const messages = [
    { role: 'system', content: buildSystemPrompt({ ...context, rosterSlice }) },
    ...conversationHistory
  ];
  let accumulated = '', emittedIndex = 0, ttftMs = null, provider = null, model = null, sawBooking = false;
  // Token usage rides on the TERMINAL chunk only. Captured before the break so
  // it reaches the caller — without this the streamed path spends tokens that
  // nothing counts, which is exactly how a caching conclusion got built on a
  // missing log field. See llm/geminiProvider.js:138.
  let usage = null;
  try {
    for await (const chunk of streamWithFailover(messages, { temperature: 0.5, maxTokens: 200 })) {
      if (chunk.ttftMs && ttftMs === null) ttftMs = chunk.ttftMs;
      if (chunk.provider) provider = chunk.provider;
      if (chunk.model) model = chunk.model;
      if (chunk.done) { if (chunk.usage) usage = chunk.usage; break; }
      if (!chunk.content) continue;
      accumulated += chunk.content;

      // Booking = verified-then-speak → never stream a booking turn.
      if (!sawBooking && scanForBookingIntent(accumulated)) {
        sawBooking = true;
        yield { kind: 'fallback-required', reason: 'booking_intent_detected' };
        return;
      }
      // A spoken booking/cancel CONFIRMATION with no sentinel is a hallucination —
      // do NOT stream it. Hand off to the non-streamed path, where the false-
      // confirmation guard suppresses it and re-asks. This check runs on the
      // accumulation BEFORE any sentence is yielded, which is the only place a
      // claim in sentence one can be stopped: a yielded sentence is audio on the
      // wire and cannot be taken back.
      if (!sawBooking && STREAMED_FALSE_CONFIRM.test(accumulated)) {
        sawBooking = true;
        yield { kind: 'fallback-required', reason: 'false_confirmation_no_sentinel' };
        return;
      }
      // A complaint attributed to the caller that they never stated — same
      // handoff, same reason it must happen before the first yield.
      if (!sawBooking && unsupportedAttributions(context.patientTextAll, accumulated).length) {
        sawBooking = true;
        yield { kind: 'fallback-required', reason: 'symptom_drift' };
        return;
      }

      const spoken = spokenRegion(accumulated);
      let next;
      while ((next = nextSentence(spoken, emittedIndex)) !== null) {
        emittedIndex += next.rawLen;
        if (next.cleaned) yield { kind: 'sentence', text: localizeSpoken(next.cleaned, context), ttftMs, provider, model };
      }
    }

    // Flush trailing spoken text with no ending punctuation.
    const spoken = spokenRegion(accumulated);
    const tail = cleanResponse(spoken.slice(emittedIndex)).trim();
    if (tail) yield { kind: 'sentence', text: localizeSpoken(tail, context), ttftMs, provider, model };

    const nameMatch = accumulated.match(/PATIENT_NAME:\s*(.+)/);
    yield {
      kind: 'done',
      // Rides alongside result, not inside it — result is the spoken outcome and
      // is consumed by the confirm guards; usage is accounting and must not
      // widen a contract those guards depend on.
      usage,
      result: {
        text: cleanResponse(accumulated).trim(),
        booked: false,
        endCall: /END_CALL:true/.test(accumulated),
        emergency: /EMERGENCY_DETECTED:true/.test(accumulated),
        // cleanPersonName, SAME AS THE NON-STREAMING PATH. It was missing here,
        // and this is the path production takes: brain-lean.js:882 guards the
        // name and even logs what it rejected, while this one wrote whatever
        // the model emitted straight through. MEASURED on production rows —
        // "your name" x2, "[Patient Name]", "Unknown" x8 — every one of which
        // cleanPersonName already returns null for.
        //
        // Two calls make it plain that the STT was not the problem:
        //     "मेरा नाम अतुल है।"   -> stored "your name"
        //     "मेरा नाम अब्दुल है।"  -> stored "your name"
        // The transcript was perfect; the model echoed the question and nothing
        // between it and the database disagreed. Fourth instance of one rule
        // living in two places in this file's history — see SENTINEL_NAMES.
        patientName: cleanPersonName(nameMatch ? nameMatch[1].trim().split('\n')[0] : null),
        reason: null,
        provider, model, ttftMs
      }
    };
  } catch (err) {
    console.error('[LEAN-stream] error, requesting fallback:', err.message);
    yield { kind: 'fallback-required', reason: `stream_error: ${err.message}` };
  }
}

module.exports = { takeTurnToolMs, replyLanguage, localizeSpoken, getLeanResponse, generateLeanRaw, processLeanRaw, getLeanResponseStream, preloadRoster, refreshRoster, refreshTakenSlots, firstFreeSlot, buildSystemPrompt, resolveDoctor, sliceRoster, specialtyMatches, doctorLine, liveAvailability, soonestTodayLine, _istNow, STREAMED_FALSE_CONFIRM, _roster: () => ROSTER, _treatments: () => TREATMENTS, _setRosterForTest: (r) => { ROSTER = r; _takenFetchedAt = Date.now(); }, cannedLine, speakableTime };
