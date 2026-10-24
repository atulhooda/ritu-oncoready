// ═══════════════════════════════════════════════════════════════════════════
// SYMPTOM DRIFT — Ritu naming a complaint the patient never made.
//
// OBSERVED IN PRODUCTION, 2026-08-06 12:42, on a call that was then abandoned:
//     patient  हाँ hello यार लेकिन मेरे को ना book दर्द हो रहा है sir मैं।
//     ritu     समझ गई जी, पेट दर्द। ये तकलीफ़ आपको कब से है?
// The same caller said सर दर्द (HEAD pain) on every other call that day. The
// 8kHz line mangled सर into "book", and Ritu resolved the wreckage into पेट
// दर्द — STOMACH — and said it back with full confidence.
//
// WHY THIS NEEDED A NEW GUARD. The drug plane already refuses to do this:
// findUnresolvedMedToken exists precisely because a garbled drug name must
// trigger a re-ask rather than a guess, and read-back exists so an agreeable
// "हाँ" cannot ratify the wrong molecule. Symptoms had none of it — and a
// symptom is what routes the patient to a specialty and what the doctor reads
// first. A wrong body part is the same class of error as a wrong molecule.
//
// It is also NOT a lexicon problem. specialtiesForSymptom is a regex table; it
// cannot turn "book" into पेट. The MODEL invented it. So the guard belongs
// beside the false-confirmation guards, not in the symptom map.
//
// THE RULE: Ritu may only ASSERT a symptom the patient's own words support.
// Support is cumulative over the whole call — she may echo a complaint stated
// several turns ago — and it is a SUPERSET test, never equality: she says less
// than the patient did all the time, which is fine.
//
// ── the refinement that made it usable ──────────────────────────────────────
// The first version compared whole turns and fired on 5 of 8 real calls. FOUR
// were the same line:
//     "समझ गई। कोई दवाई चल रही है या कोई एलर्जी है जी?"
// the standard history question. एलर्जी is in the symptom table, so ASKING
// about allergies looked identical to CLAIMING one. Splitting into clauses and
// dropping interrogatives took it to 1 of 8 — the real bug, nothing else.
// That distinction is the whole guard: naming a symptom in a question is how
// you take a history; naming one in a statement is a claim about the patient.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { specialtiesForSymptom } = require('./tools/symptomMapping');

// Devanagari danda, western full stop, ? and ! all end a clause. Keeping the
// terminator (lookbehind split) is what lets the filter see the '?'.
const CLAUSE_SPLIT = /(?<=[?।.!])\s*/;

/**
 * Clauses Ritu ASSERTED — interrogatives dropped. Exported because the
 * assert/ask split is the entire basis of the guard and deserves its own test.
 */
function assertedClauses(text) {
  return String(text || '')
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter((c) => c && !/[?？]$/.test(c));
}

/**
 * Specialties Ritu asserted that nothing the patient said supports.
 * Empty array = clean. Never throws: this runs on the reply path.
 *
 * @param {string} patientTextAll every patient utterance so far, concatenated
 * @param {string} rituText       the reply about to be spoken
 */
function symptomDrift(patientTextAll, rituText) {
  try {
    const supported = new Set(specialtiesForSymptom(String(patientTextAll || '')));
    const drifted = new Set();
    for (const clause of assertedClauses(rituText)) {
      for (const s of specialtiesForSymptom(clause)) {
        if (!supported.has(s)) drifted.add(s);
      }
    }
    return [...drifted];
  } catch {
    return [];
  }
}

// ─── THE NARROW GATE: A SYMPTOM ASSERTED *ABOUT THE PATIENT* ────────────────
// symptomDrift above is the AUDIT. Measured on 748 real Ritu turns (30 days,
// 2026-08-29) it flags 10 — and eight of those are roster descriptions ("हड्डी
// के डॉक्टर हैं", "Dr. Anjali Deshmukh (Dentist)"), which map a specialty
// without asserting anything about the caller. Gating replies on the audit
// would re-ask on every one of them.
//
// What must never be spoken is narrower: a complaint attributed TO THE CALLER
// that the caller never stated — "पेट दर्द की परेशानी है तो …" to a man who rang
// to ask closing time (live call b2045aa9; "पेट दर्द" then became the reason on
// his appointment). These frames find exactly that shape. Same 748 turns: 24
// carry a frame, ONE is unsupported, and it is that call.
// Every script the lexicon does not carry natively is transliterated first —
// the guard was blind to Gujarati (the live clinic) because the frames and the
// mapping only saw Devanagari/Latin.
const { toDevanagari: _toDevanagari } = require('./translit');
const withDevanagari = (t) => { const s = String(t || ''); try { return s + ' ' + _toDevanagari(s); } catch { return s; } };

const ATTRIBUTION_FRAMES = [
  // Gujarati: "તમને X છે" / "X ની તકલીફ છે" / "X ની સમસ્યા છે" / "X નો પ્રોબ્લેમ છે"
  /તમને\s+([\p{L}\p{M}][\p{L}\p{M}\s]{1,30}?)\s+(?:છે|થાય\s+છે|રહે\s+છે)/gu,
  /([\p{L}\p{M}][\p{L}\p{M}\s]{1,30}?)\s+(?:ની\s+તકલીફ|ની\s+સમસ્યા|નો\s+પ્રોબ્લેમ|ની\s+પરેશાની)\s+છે/gu,
  /([\p{L}\p{M}][\p{L}\p{M}\s]{1,30}?)\s+(?:की\s+परेशानी|की\s+तकलीफ़?|की\s+समस्या|की\s+दिक्कत)\s+(?:है|हैं)/gu,
  /([\p{L}\p{M}][\p{L}\p{M}\s]{1,30}?)\s+(?:चा|ची|चं|चे)\s+त्रास\s+(?:आहे|असेल)/gu,
  /\byou\s+(?:have|are\s+having|'?ve\s+got)\s+([a-z][a-z ]{2,30})/gi,
  /आपको\s+([\p{L}\p{M}\s]{2,30}?)\s+(?:है|हो\s+रहा|हो\s+रही)/gu,
];
function attributedSymptoms(text) {
  const out = [];
  for (const re of ATTRIBUTION_FRAMES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(String(text || '')))) out.push(m[1].trim());
  }
  return out;
}
/** Attributed complaints in rituText whose specialty nothing the patient said supports. */
function unsupportedAttributions(patientTextAll, rituText) {
  try {
    const supported = new Set(specialtiesForSymptom(withDevanagari(patientTextAll)));
    const out = [];
    for (const fragment of attributedSymptoms(rituText)) {
      for (const s of specialtiesForSymptom(withDevanagari(fragment))) if (!supported.has(s)) out.push({ fragment, specialty: s });
    }
    return out;
  } catch { return []; }
}
/**
 * May this reason be written to the appointment? A reason that maps to no
 * specialty ("checkup", "consultation") has nothing to contradict and is kept.
 * One that maps to a specialty the caller's own words never supported was
 * invented, and an invented complaint is what the doctor reads first.
 */
function reasonSupported(patientTextAll, reason) {
  try {
    const claimed = specialtiesForSymptom(withDevanagari(reason));
    if (!claimed.length) return true;
    const supported = new Set(specialtiesForSymptom(withDevanagari(patientTextAll)));
    return claimed.every((s) => supported.has(s));
  } catch { return true; }
}

module.exports = { symptomDrift, assertedClauses, attributedSymptoms, unsupportedAttributions, reasonSupported };
