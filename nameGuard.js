// ═══════════════════════════════════════════════════════════════════════════
// IS THIS ACTUALLY SOMEBODY'S NAME?
//
// WHAT THE PRODUCTION DATABASE HAS IN patients.name, TODAY:
//
//     "Unknown"  x8      "your name"  x2     "Patient"  x2
//     "ಅಪರಿಚಿತ"   x2      "."          x1     "Webhook Probe"  x1
//
// "your name" is the one that explains the rest. Ritu asks "आपका नाम क्या है?"
// and the caller answers by echoing the question — "your name?" — either
// misunderstanding, or checking they heard right. The LLM dutifully returns it
// as the value, and it is written to the patient record. That patient is now
// greeted as "your name जी" on their next call, forever.
//
// THE GUARD ALREADY EXISTED. brain.js has isValidFieldValue() and a
// FIELD_FRAGMENTS list, and it is careful work — it rejects "naam", "मेरा नाम",
// "pata nahi", "not received yet". It has never run in production for a single
// call, because production runs CLINIC_MODE=lean and brain-lean.js extracts the
// name with a bare regex and no validation at all:
//
//     const patientName = nameMatch ? nameMatch[1].trim().split('\n')[0] : null;
//
// A guard in the path the product does not take is not a guard. This module is
// the shared one, so there is exactly one list and both brains consult it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not try to decide whether a string
// "looks like an Indian name" — that is a filter that would reject real people,
// and there is no version of it that fails safely. It rejects only strings we
// have POSITIVE evidence are not names: question echoes, placeholder tokens the
// model emits when it has nothing, and punctuation. Everything else is somebody.
//
// No imports: this file must stay reachable from every path without touching
// the callHandler → crm → whatsapp cycle.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// Every entry is either OBSERVED in production or a direct translation of one.
// Compared lowercased and whitespace-collapsed.
const NOT_A_NAME = new Set([
  // ── the question, echoed back ──────────────────────────────────────────
  'your name', 'yourname', 'my name', 'my name is', 'name', 'name is',
  'naam', 'naam hai', 'mera naam', 'mera naam hai', 'aapka naam',
  'aapka naam kya hai', 'tumhara naam', 'naam kya hai', 'what is your name',
  'नाम', 'मेरा', 'मेरा नाम', 'मेरा नाम है', 'आपका नाम', 'आपका नाम क्या है',
  'तुमचं नाव', 'तुमचे नाव', 'नाव', 'नाव काय',
  // ── placeholders a model emits when it has nothing ─────────────────────
  'unknown', 'patient', 'caller', 'user', 'test', 'testing', 'demo',
  'na', 'n/a', 'none', 'null', 'nil', 'not provided', 'not received',
  'not received yet', 'not given', 'not given yet', 'not yet', 'anonymous',
  'webhook probe', 'webhook', 'probe',
  'अज्ञात', 'रोगी', 'मरीज', 'ಅಪರಿಚಿತ', 'తెలియదు', 'অজানা', 'અજાણ્યું',
  // ── "I don't know" answers ─────────────────────────────────────────────
  'pata nahi', 'pata nahi hai', 'nahi pata', 'abhi nahi', 'nahi',
  'पता नहीं', 'नहीं मिला', 'नहीं मिला अभी तक', 'अभी तक नहीं', 'अभी नहीं',
  // ── bare acknowledgements the model sometimes hands back as a value ────
  // Template echoes. The model answers "आपका नाम?" with the QUESTION when it
  // has not heard one — "your name" reached the patients table twice, and
  // "Patient" once, on calls whose transcripts were perfect.
  'patient name', 'patient', 'naam bataiye', 'name please',
  'ji', 'haan', 'haan ji', 'hai', 'hain', 'sir', 'madam', 'ok', 'okay', 'yes',
  'जी', 'हाँ', 'हां', 'है', 'हैं', 'सर', 'मैडम', 'ठीक',
]);

// A name has to contain at least one letter in SOME script. This is the only
// shape rule here, and it exists to reject "." and "123" — not to judge names.
const HAS_LETTER = /[A-Za-zऀ-෿฀-๿]/;

/**
 * True when `value` may be stored as a person's name.
 *
 * Errs toward ACCEPTING. A rejected real name means a patient is greeted
 * generically — mildly worse service. An accepted non-name corrupts a clinical
 * record permanently and is read back to the caller as though it were theirs.
 * Those are not symmetrical, but the asymmetry does not license guessing at
 * what a name looks like; it licenses a specific, evidenced reject-list.
 */
// A TEMPLATE PLACEHOLDER IS NEVER A NAME. Live call 5b261b844e, 2026-08-14:
// the string "[Patient Name]" was written to the patients table as a human, on
// the same handset as the real caller, and became the third of three rows for
// one person. The reject-list above could not catch it — it is not a word
// anyone says, it is the PROMPT'S OWN placeholder leaking through the model.
//
// Shape-based, deliberately, and the one shape rule this file allows itself
// besides HAS_LETTER: anything wholly wrapped in brackets or braces. A real
// name is not "[...]" or "{{...}}" in any script, and the model emits these
// when it is echoing the template rather than answering from the call.
const IS_PLACEHOLDER = /^[[<{(].*[)}\]>]$/s;

function isValidPersonName(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim().replace(/\s+/g, ' ');
  if (raw.length < 2) return false;              // "." and single letters
  if (!HAS_LETTER.test(raw)) return false;       // "123", "---"
  if (IS_PLACEHOLDER.test(raw)) return false;    // "[Patient Name]", "{{name}}"
  if (NOT_A_NAME.has(raw.toLowerCase())) return false;
  return true;
}

/**
 * The value to store, or null. Callers should treat null as "we did not learn a
 * name this call" — never as a reason to write a placeholder, which is how
 * "Unknown" got into eight rows in the first place.
 */
function cleanPersonName(value) {
  if (!isValidPersonName(value)) return null;
  return String(value).trim().replace(/\s+/g, ' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE NAME THE CALLER ACTUALLY SAID
//
// MEASURED on 125 production calls, 2026-08-15: of the exchanges where a
// caller offered a name at all, 82% wrapped it in a carrier phrase — "मेरा नाम
// X है", "ನನ್ನ ಹೆಸರು X", "আমার নাম X", "ਮੇਰਾ ਨਾਮ X ਹੈ". And in 15 of those the
// name that reached patients.name DISAGREED with the name inside the phrase
// the caller had just spoken. 14 of 38 bad captures were ours, only 2 the
// STT's — the audio was fine and the transcript was fine; the extraction lost
// it downstream.
//
// THE CLEAREST INSTANCE, live call, first two turns:
//
//     PATIENT   ಹಲೋ, ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ.        ← spoken in KANNADA
//     patients.name   পৃথ্বী                    ← written in BENGALI
//
// Transcribed correctly, then re-rendered by the model into a script the
// caller never used, in a clinic whose staff read neither. The sentinel does
// not copy the name out of the transcript — it REGENERATES it, and generation
// is where scripts, spellings and whole identities drift.
//
// SO THE CARRIER PHRASE WINS WHEN IT IS PRESENT. It is the caller's literal
// bytes, sliced out by position; the sentinel is a model's recollection of
// them. This does not replace the sentinel — 5 of 28 callers gave a bare name
// with no phrase around it, and those still need the LLM. It orders them.
//
// WHY NOT "मैं X हूँ" ("I am X"). It is a real carrier and it is deliberately
// absent: "मैं ठीक हूँ" / "मैं दर्द में हूँ" are far more common than a name in
// that frame, and a wrong name is written to a clinical record and read back
// to the caller forever. Only frames containing the WORD for "name" are here.
// ═══════════════════════════════════════════════════════════════════════════

// ─── "NOT", IN ELEVEN LANGUAGES, IN ONE PLACE ──────────────────────────────
// Lives here because nameGuard imports nothing and everything can import it —
// callHandler uses it for the meds/allergy clause splitter and for this file's
// name denial, so the two cannot drift the way four sentinel lists and three
// transliterators did.
//
// INDIC SCRIPTS HAVE NO \b. JavaScript word boundaries are ASCII-shaped, so a
// negation word that is a PREFIX of a common ordinary word matches inside it.
// MEASURED 2026-08-16, in code shipped the previous day: Kannada ಇಲ್ಲಿ ("here")
// contains ಇಲ್ಲ ("no"), so "ಇಲ್ಲಿ penicillin ಅಲರ್ಜಿ ಇದೆ" — there IS an allergy
// here — was read as a denial and the allergen DROPPED. A missed allergy is the
// dangerous direction. The lookaheads below are that fix, and each one names
// the word it is protecting.
const NEGATED_RE = new RegExp([
  'नहीं', 'नही', 'नाही', 'नाहीये',                 // hi / mr
  'ಇಲ್ಲ(?!ಿ)', 'ಅಲ್ಲ(?!ಿ)',                          // kn — ಇಲ್ಲಿ "here", ಅಲ್ಲಿ "there"
  'இல்லை', 'அல்ல',                                 // ta
  'లేదు', 'కాదు',                                   // te
  'নেই', 'নয়', '(?<![ঀ-৿])না(?![ঀ-৿])',            // bn — না is the first syllable of নাম "name"
  'નથી', 'નહીં',                                    // gu
  'ഇല്ല', 'അല്ല',                                   // ml
  'ਨਹੀਂ', 'ਨਹੀ',                                     // pa
  'ନାହିଁ', 'ନୁହେଁ',                                   // od
  '\\bno\\b', '\\bnot\\b', '\\bnone\\b', "n't\\b", '\\bwrong\\b',
].join('|'), 'i');

// Each pattern ends just before the name. The optional copula covers both word
// orders — "मेरा नाम सिद्धार्थ है" and "मेरा नाम है सिद्धार्थ" both occur.
const NAME_CARRIERS = [
  /(?:मेरा|मेरे|मेरं|माझं|माझे|माझा|मझा)\s*(?:नाम|नाव)\s*(?:है|हैं|आहे)?\s*[:\-—]?\s*/,
  /ನನ್ನ\s*ಹೆಸರು\s*[:\-—]?\s*/,
  /আমার\s*নাম\s*[:\-—]?\s*/,
  /ਮੇਰਾ\s*ਨਾਮ\s*[:\-—]?\s*/,
  /என்\s*பெயர்\s*[:\-—]?\s*/,
  /నా\s*పేరు\s*[:\-—]?\s*/,
  /(?:મારું|મારુ)\s*નામ\s*[:\-—]?\s*/,
  /(?:എന്റെ|എന്റെ)\s*പേര[്‌]?\s*[:\-—]?\s*/,
  /ମୋ(?:ର)?\s*ନାମ\s*[:\-—]?\s*/,
  // Romanised — Sarvam returns Latin for code-mixed callers, and every one of
  // these appeared in a real transcript.
  /\b(?:mera|mere|maza|majhe)\s*(?:naam|nam|naav|nav)\s*(?:hai|he|ahe)?\s*[:\-—]?\s*/i,
  /\bmy\s*name\s*(?:is)?\s*[:\-—]?\s*/i,
  // BARE "name" REQUIRES A COPULA OR A COLON. Without one it matched the
  // QUESTION as readily as the answer: "May I have your name please" yielded
  // "please", and a transcript of Ritu's own English prompt yielded
  // "please हॅलो". Found 2026-08-16 by running this extractor over independent
  // transcripts of real calls — the same "your name" class of defect this file
  // was written to stop, arriving by a route it did not cover. "my name X" with
  // no copula stays permitted above: it is a strong signal and common Indian
  // English, whereas bare "name X" is mostly the question.
  /\bname\s+(?:is\s+|[:\-—]\s*)/i,
  /\bnanna\s*hesaru\s*[:\-—]?\s*/i,
  /\bamar\s*nam\s*[:\-—]?\s*/i,
];

// A name ends where one of these begins. Copulas ("है", "ಆಗಿದೆ"), the honorific
// the caller appends to their own name, and any conjunction that starts the
// next clause — "मेरा नाम सिद्धार्थ है और मुझे दांत में दर्द है" must yield
// "सिद्धार्थ", not the rest of the sentence.
// Three groups, all three MEASURED as necessary on the 2026-08-15 corpus:
//
//  (1) copulas and conjunctions — the ordinary end of a name.
//  (2) FIRST-PERSON PRONOUNS. "ನನ್ನ ಹೆಸರು ಪೃಥ್ವಿ ನನಗೆ ಕಾಲಲ್ಲಿ ಒಂದು ಚೂರು ನೋವಿದೆ"
//      is one breath with no punctuation — name, then symptom. Hindi मुझे was
//      here from the start so Hindi was safe; Kannada ನನಗೆ was not, and the
//      extractor returned "ಪೃಥ್ವಿ ನನಗೆ ಕಾಲಲ್ಲಿ ಒಂದು" as a person's name.
//  (3) SPEECH VERBS AND QUESTION WORDS. "आपने मेरा नाम बोला तो" — the caller is
//      talking ABOUT the name, not giving one, and the phrase fires anyway.
//      Same for "मेरा नाम क्या है?", where the slot holds the question.
const NAME_ENDS = new Set([
  // (1)
  'है', 'हैं', 'हूँ', 'हूं', 'हे', 'आहे', 'जी', 'और', 'से', 'का', 'की', 'को',
  'मुझे', 'मेरे', 'मेरा', 'बोल', 'बोलत', 'रहा', 'रही', 'हु',
  'ಆಗಿದೆ', 'ಇದೆ', 'ಅಂತ', 'ಜೀ', 'ಮತ್ತು',
  'এবং', 'ও', 'ਹੈ', 'ਜੀ', 'ਅਤੇ', 'ஆகும்', 'ఉంది', 'છે', 'અને', 'ആണ്', 'ଅଟେ',
  'hai', 'he', 'ahe', 'is', 'and', 'ji', 'sir', 'madam', 'aur', 'se',
  // (2) first person — where the name stops and the complaint starts
  'मैं', 'मैने', 'मैंने', 'मला', 'माझा', 'माझं',
  'ನಾನು', 'ನನಗೆ', 'ನನ್ನ', 'ನಮ್ಮ',
  'আমি', 'আমার', 'আমাকে',
  'ਮੈਂ', 'ਮੈਨੂੰ', 'ਮੇਰਾ',
  'நான்', 'எனக்கு', 'என்',
  'నేను', 'నాకు', 'నా',
  'હું', 'મને', 'મારું',
  'ഞാൻ', 'എനിക്ക്', 'എന്റെ',
  'ମୁଁ', 'ମୋତେ', 'ମୋ',
  'main', 'mujhe', 'mera', 'mala',
  // (3) talking about the name rather than giving one
  'बोला', 'बोली', 'बताया', 'बताई', 'पूछा', 'कहा', 'याद', 'पता', 'लिखा',
  'क्या', 'कौन', 'कैसे', 'काय', 'ಏನು', 'ಯಾರು', 'কি', 'কী', 'ਕੀ', 'என்ன',
  'ఏమి', 'શું', 'എന്ത്', 'କଣ',
  'kya', 'what', 'who', 'bola', 'bataya', 'poocha', 'kaha',
  // Politeness that trails the QUESTION, not the answer. "…your name please"
  // put "please" one word from becoming a patient's name.
  'please', 'plz', 'kripya', 'कृपया', 'ದಯವಿಟ್ಟು', 'দয়া', 'ਕਿਰਪਾ',
]);

/**
 * Pull the name out of a carrier phrase in the caller's own words, or null.
 *
 * Returns null rather than guessing whenever the phrase fired but the slot
 * after it is empty or unusable — live transcript "हेलो, मेरा नाम।" is the
 * caller being cut off mid-sentence, and there is no name in it to find.
 */
function extractNameFromSpeech(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  for (const carrier of NAME_CARRIERS) {
    const m = carrier.exec(raw);
    if (!m) continue;

    // Only what follows the phrase, and only up to the end of that clause — a
    // name never spans a sentence boundary.
    let rest = raw.slice(m.index + m[0].length);
    rest = rest.split(/[।.,!?;\n]/)[0];

    // ─── A DENIAL IS NOT A NAME ──────────────────────────────────────────
    // GROUND TRUTH, call e370519a, 2026-08-15 — the first call in this repo's
    // history with audio to check against. All three systems (Sarvam realtime,
    // gemini-3.5, gemini-2.5) heard the caller say:
    //
    //     "ಆಮೇಲೆ ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ"      "and my name is NOT Rajamma"
    //
    // This function returned "ರಾಜಮ್ಮ ಅಲ್ಲ" — the denied name plus the word
    // "not" — as a person. Exactly the inversion fixed for allergies the day
    // before, in the other module, because the rule had no shared home.
    if (NEGATED_RE.test(rest)) return null;

    const words = rest.split(/\s+/).filter(Boolean);
    const name = [];
    for (const w of words) {
      // Trailing punctuation clings to the last word ("सिद्धार्थ।").
      const bare = w.replace(/[।.,!?;:'"]+$/g, '');
      if (!bare) break;
      if (NAME_ENDS.has(bare.toLowerCase())) break;
      name.push(bare);
      // Three, not four. Every real name in the corpus is one or two words
      // ("अतुल", "আদিত্য ঝা"); the fourth slot only ever caught run-on clauses.
      if (name.length === 3) break;
    }

    // cleanPersonName is the same gate the sentinel's output passes, so a
    // carrier phrase cannot smuggle in "your name" by another door.
    const got = cleanPersonName(name.join(' '));
    if (got) return got;
  }
  return null;
}

/**
 * True when the caller said the name we have is WRONG.
 *
 * Distinct from "the extractor found nothing". A denial is positive evidence
 * that whatever is stored is incorrect, and it is the only signal strong enough
 * to overturn an already-captured name.
 *
 * WHY THIS IS NARROW, AND MUST STAY NARROW. patientName is FILL-ONLY by
 * measurement: on 7 production calls where a valid name was already recorded
 * and a later phrase disagreed, overriding would have been wrong every time —
 * 4 were the same name in another script (अतुल/Atul, আদিত্য ঝা/Aditya Jha), and
 * one was a garbled transcript the model had already repaired (सित्थात →
 * सिद्धार्थ). A disagreement is not evidence. "My name is NOT X" is.
 */
function deniesName(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  for (const carrier of NAME_CARRIERS) {
    const m = carrier.exec(raw);
    if (!m) continue;
    const rest = raw.slice(m.index + m[0].length).split(/[।.,!?;\n]/)[0];
    if (NEGATED_RE.test(rest)) return true;
  }
  return false;
}

module.exports = { isValidPersonName, cleanPersonName, extractNameFromSpeech, deniesName, NEGATED_RE, NOT_A_NAME };
