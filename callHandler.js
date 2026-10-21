const axios = require('axios');
const { textToSpeech, streamTTS, createStreamingSTT, detectLanguageCode, looksLikeHindi, pairLanguage, prewarmTTS, discardTTSPrewarm } = require('./sarvam');
const { renderBriskest } = require('./greetingTakes');
const { getResponse } = require('./brain');
const { getResponseStream } = require('./brain-streaming');
const { getResponseToolCalling, streamResponseToolCalling } = require('./brain-tools');
const { getLeanResponse, generateLeanRaw, processLeanRaw, getLeanResponseStream, cannedLine } = require('./brain-lean');
const { prewarmPrimary } = require('./llm');
const oncoready = require('./oncoreadyIntake');
const { completeWithFailover: intakeComplete } = require('./llm');
const { logCall } = require('./crm');
const { upsertPatient, saveConfirmedMedication, getPatientMedications, pool: dbPool } = require('./db');
const config = require('./config');
const { maskPhone, speech } = require('./redact');
const { classifyCall, REASON_LABEL } = require('./callOutcome');
const { TelephonyProbe } = require('./telephonyProbe');
const { extractNameFromSpeech, deniesName, NEGATED_RE } = require('./nameGuard');
const { detectEmergency, composeEmergencyProbe } = require('./emergencyDetector');
const { detectEmergencyV2 } = require('./emergencyDetectorV2'); // shadow-by-default (EMERGENCY_V2 env)

// ─── WHICH v2 CATEGORIES MAY ESCALATE ────────────────────────────────────────
// MEASURED 2026-08-05, re-run against today's code on the project's own
// fixtures. v1 — the detector live in production — catches 62 of 96 red-flag
// utterances. v2 catches 96. But v2 also produces 43 adversarial false
// positives that v1 does not, and the repo's own FP hunt concluded
// "BLOCK for EMERGENCY_V2=on (enforce)". That verdict is right, and it is right
// for a reason that all-or-nothing hides:
//
//     category     v1 MISSES    v2 adds FPs
//     selfharm        11            4
//     stroke          10            2
//     poisoning        2            0
//     cardiac          6            6
//     bleeding         1           11
//
// The over-trigger is concentrated in bleeding and cardiac — exactly the
// categories where v1 already works. Where v1 fails catastrophically, v2 costs
// almost nothing. So enforcement is per-category, and the categories are chosen
// by that table rather than by a single switch.
//
// WHAT THE REMAINING FALSE POSITIVES ACTUALLY ARE, all six of them:
//     "घुटने की वजह से जीना नहीं चढ़ पाता"   जीना = STAIRCASE, not "to live"
//     "जान है तो जहान है"                    a proverb
//     "...end of the day, fits my life schedule"
//     "aapki taraf se kaam nahi hua form ka"  paperwork, not hemiplegia (x2 langs)
// Their cost is that Ritu offers a helpline, or suggests 108, to somebody who
// did not need it. The cost of the other error is that eleven of twelve callers
// expressing suicidal intent are handed an appointment slot. Those are not
// comparable, and waiting for a perfect matcher is itself a decision with a
// body count.
//
// Default is EMPTY — behaviour identical to today until deliberately set.
// EMERGENCY_V2=on still means "every category", kept so the old switch works.
// One definition, shared with the WhatsApp guard — see emergencyDetectorV2.js.
const { v2Enforces: V2_ENFORCES } = require('./emergencyDetectorV2');
const { detectSensitiveProbe } = require('./sensitiveDataGuard');
const { detectMedicalAdvice, adviceGuardSuppressed } = require('./medicalAdviceGuard');
const { detectGarble, repeatPrompt, slotRepeatPrompt } = require('./garbleGuard');
const { findDrugMention, findAllDrugMentions, findUnresolvedMedToken, extractTimeExpression, readbackLine, stepReadback, classifyReply } = require('./readback');
// READ-BACK (S2/S5): confirm STT-captured medicines before they reach the
// doctor's notes. READBACK=shadow → log-only preview (what Ritu WOULD confirm);
// READBACK=on → the real confirmation turn (speak "Metformin — sahi?" and
// resolve the reply). Default OFF = byte-identical behavior.
// (READBACK_SHADOW=on is honored as the legacy spelling of READBACK=shadow.)
const READBACK_MODE = process.env.READBACK === 'on' ? 'on'
  : (process.env.READBACK === 'shadow' || process.env.READBACK_SHADOW === 'on') ? 'shadow' : 'off';
const { specialtiesForSymptom } = require('./tools/symptomMapping');
const { symptomDrift } = require('./symptomGuard');
const { runtimeConfig } = require('./runtimeConfig');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_CONVERSATION_HISTORY = 20;
const SILENCE_WARN_MS = 8000;
const SILENCE_HANGUP_MS = 15000;
// Rotated so a quiet caller doesn't hear the identical line every pause — that
// repetition was a top complaint. Cycled per prompt within a call.
const SILENCE_PROMPTS = {
  'mr-IN': [
    'हं, मी ऐकते आहे. बोला.',
    'हॅलो, तुम्हाला माझा आवाज ऐकू येतोय का?',
    'बोला जी, मी इथेच आहे.',
    'तुम्ही तिथे आहात का? बोला जी.',
  ],
  'hi-IN': [
    'जी, मैं सुन रही हूँ। बताइए।',
    'हैलो, क्या आप मुझे सुन पा रहे हैं?',
    'जी बोलिए, मैं यहीं हूँ।',
    'क्या आप वहाँ हैं? बताइए जी।',
  ],
  // Multilingual (flag-gated) — short, natural per-language lines. Missing
  // languages fall back to hi-IN at the lookup site.
  'en-IN': ['Yes, I am listening. Please go ahead.', 'Hello, can you hear me?'],
  'kn-IN': ['ಹೌದು, ನಾನು ಕೇಳುತ್ತಿದ್ದೇನೆ. ಹೇಳಿ.', 'ಹಲೋ, ನನ್ನ ಧ್ವನಿ ಕೇಳಿಸುತ್ತಿದೆಯೇ?'],
  'pa-IN': ['ਜੀ, ਮੈਂ ਸੁਣ ਰਹੀ ਹਾਂ। ਦੱਸੋ।', 'ਹੈਲੋ, ਕੀ ਤੁਸੀਂ ਮੈਨੂੰ ਸੁਣ ਸਕਦੇ ਹੋ?'],
  'ta-IN': ['சொல்லுங்கள், நான் கேட்டுக்கொண்டிருக்கிறேன்.', 'ஹலோ, என் குரல் கேட்கிறதா?'],
  'te-IN': ['చెప్పండి, నేను వింటున్నాను.', 'హలో, నా మాట వినిపిస్తుందా?'],
  'bn-IN': ['জি, আমি শুনছি। বলুন।', 'হ্যালো, আপনি কি আমাকে শুনতে পাচ্ছেন?'],
  'gu-IN': ['જી, હું સાંભળી રહી છું. બોલો.', 'હેલો, તમે મને સાંભળી શકો છો?'],
  'ml-IN': ['പറയൂ, ഞാൻ കേൾക്കുന്നുണ്ട്.', 'ഹലോ, എന്റെ ശബ്ദം കേൾക്കുന്നുണ്ടോ?'],
  'od-IN': ['ହଁ, ମୁଁ ଶୁଣୁଛି। କୁହନ୍ତୁ।', 'ହେଲୋ, ଆପଣ ମୋତେ ଶୁଣି ପାରୁଛନ୍ତି କି?'],
};

// ─── DETERMINISTIC PRE-VISIT HISTORY ────────────────────────────────────────
// The fast voice model reliably SKIPS the history questions on an obvious symptom
// (jumps straight to the doctor), which guts the "pre-visit history saves the
// doctor's time" value. So after a real symptom — unless the caller is rushing —
// we ask duration, then meds/allergies, DETERMINISTICALLY (canned, no LLM),
// before letting the model offer a doctor. Skipped for pure booking/inquiry.
// Words that appear in treatment names without identifying one. Matching on
// these turns the treatment probe into a word probe: "removal" alone would fire
// intake on any sentence containing it.
const GENERIC_TREATMENT_TOKENS = new Set([
  'removal', 'treatment', 'therapy', 'surgery', 'procedure', 'session',
  'sessions', 'consultation', 'checkup', 'clinic', 'skin', 'hair', 'laser',
]);

const HISTORY_ASK_DURATION = {
  'hi-IN': 'अच्छा। यह तकलीफ़ कब से है?',
  'mr-IN': 'बरं. ही तक्रार किती दिवसांपासून आहे?',
  'en-IN': 'I see. How long have you been having this?',
  'kn-IN': 'ಸರಿ. ಈ ತೊಂದರೆ ಎಷ್ಟು ದಿನಗಳಿಂದ ಇದೆ ಜೀ?',
  'pa-IN': 'ਠੀਕ ਹੈ। ਇਹ ਤਕਲੀਫ਼ ਕਦੋਂ ਤੋਂ ਹੈ ਜੀ?',
  'ta-IN': 'சரி. இந்த பிரச்சனை எத்தனை நாட்களாக இருக்கிறது?',
  'te-IN': 'సరే. ఈ సమస్య ఎన్ని రోజుల నుండి ఉంది జీ?',
  'bn-IN': 'আচ্ছা। এই সমস্যাটা কতদিন ধরে হচ্ছে?',
  'gu-IN': 'સારું. આ તકલીફ ક્યારથી છે જી?',
  'ml-IN': 'ശരി. ഈ ബുദ്ധിമുട്ട് എത്ര ദിവസമായി ഉണ്ട്?',
  'od-IN': 'ଠିକ୍ ଅଛି। ଏହି ଅସୁବିଧା କେବେଠାରୁ ହେଉଛି?',
};
const HISTORY_ASK_MEDS = {
  'hi-IN': 'समझ गई। कोई दवाई चल रही है या कोई एलर्जी है जी?',
  'mr-IN': 'समजलं. सध्या काही औषध चालू आहे का, किंवा काही एलर्जी?',
  'en-IN': 'Understood. Are you on any medicines, or do you have any allergies?',
  'kn-IN': 'ಸರಿ. ಯಾವುದಾದರೂ ಔಷಧಿ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದೀರಾ, ಅಥವಾ ಯಾವುದಾದರೂ ಅಲರ್ಜಿ ಇದೆಯೇ?',
  'pa-IN': 'ਸਮਝ ਗਈ। ਕੋਈ ਦਵਾਈ ਚੱਲ ਰਹੀ ਹੈ ਜਾਂ ਕੋਈ ਐਲਰਜੀ ਹੈ ਜੀ?',
  'ta-IN': 'புரிந்தது. ஏதேனும் மருந்து எடுத்துக்கொள்கிறீர்களா, அல்லது ஏதேனும் அலர்ஜி உண்டா?',
  'te-IN': 'అర్థమైంది. ఏదైనా మందు వాడుతున్నారా, లేదా ఏదైనా అలర్జీ ఉందా?',
  'bn-IN': 'বুঝলাম। কোনো ওষুধ চলছে, বা কোনো অ্যালার্জি আছে?',
  'gu-IN': 'સમજી ગઈ. કોઈ દવા ચાલુ છે કે કોઈ એલર્જી છે જી?',
  'ml-IN': 'മനസ്സിലായി. എന്തെങ്കിലും മരുന്ന് കഴിക്കുന്നുണ്ടോ, അല്ലെങ്കിൽ എന്തെങ്കിലും അലർജി ഉണ്ടോ?',
  'od-IN': 'ବୁଝିଲି। କୌଣସି ଔଷଧ ଚାଲୁଛି କି, କିମ୍ବା କୌଣସି ଆଲର୍ଜି ଅଛି?',
};

// Has the MODEL already asked a history question? (see _llmAlreadyAskedHistory)
// Broad, multi-script markers — matched only against assistant turns that are
// questions. Meds/allergy words across the 11 supported languages; duration
// phrasings ("कब से", "how long", "since when", …).
const HISTORY_MEDS_ASKED_RE = /दवा|दवाई|दवाइय|औषध|एलर्जी|अलर्जी|ऍलर्जी|allerg|medicine|medication|ಔಷಧ|ਦਵਾਈ|மருந்து|మందు|ওষুধ|દવા|മരുന്ന്|ଔଷଧ/i;
// Covers BOTH duration idioms the canned tables use: "since when" (कब से,
// ਕਦੋਂ ਤੋਂ, ક્યારથી, କେବେଠାରୁ, since when/how long) AND "how many days"
// (किती दिवसांपासून, ಎಷ್ಟು ದಿನಗಳಿಂದ, எத்தனை நாட்கள், ఎన్ని రోజుల, কতদিন,
// എത്ര ദിവസ…) — every entry below is checked against the live tables by
// tools/test-history-sync.js so a new language can't silently fall out.
const HISTORY_DURATION_ASKED_RE = /कब\s*से|कधी\s*पासून|कधीपासून|केव्हापासून|दिवसांपासून|how\s+long|since\s+when|ಯಾವಾಗಿನಿಂದ|ದಿನಗಳಿಂದ|ਕਦੋਂ\s*ਤੋਂ|எப்போதிருந்து|நாட்கள|ఎప్పటి\s*నుండి|రోజుల\s*నుండి|কবে\s*থেকে|কতদিন|ક્યારથી|എപ്പോൾ\s*മുതൽ|ദിവസമാ|କେବେଠାରୁ/i;

// Med-name re-ask — the LAST rung, not the first (reordered 2026-07-26).
//
// EVIDENCE: Oviatt, MacEachern & Levow (Speech Communication 1998) measured
// what people do after a recognition failure — they HYPERARTICULATE, and
// recognition gets WORSE, because the speech leaves the model's training
// distribution. Over 300 matched original/repeat pairs, pauses per multi-word
// utterance rose 0.49 → 1.06 (+116%). Compose that with Sarvam's N-of-M
// endpointing window and the repeat is MORE likely to be chopped than the
// original was. "Please say it again" is not a neutral fallback in this system;
// it is an active degradation step.
//
// So: the word "slowly" (धीरे से / हळू / ನಿಧಾನವಾಗಿ) is GONE from this copy —
// it explicitly instructs the caller to do the thing that breaks recognition.
// We ask only for the isolated name, which genuinely helps (one word has no
// mid-sentence endpointing risk), without inviting hyperarticulation.
const MED_NAME_REASK = {
  'hi-IN': 'दवाई का नाम मैं ठीक से समझ नहीं पाई — सिर्फ़ दवाई का नाम बताइएगा?',
  'mr-IN': 'औषधाचं नाव मला नीट समजलं नाही — फक्त औषधाचं नाव सांगाल का?',
  'kn-IN': 'ಔಷಧಿಯ ಹೆಸರು ನನಗೆ ಸರಿಯಾಗಿ ಅರ್ಥವಾಗಲಿಲ್ಲ — ಔಷಧಿಯ ಹೆಸರು ಮಾತ್ರ ಹೇಳುತ್ತೀರಾ?',
  'en-IN': "I didn't quite catch the medicine's name — could you just say the medicine name?",
  'pa-IN': 'ਦਵਾਈ ਦਾ ਨਾਮ ਮੈਨੂੰ ਠੀਕ ਤਰ੍ਹਾਂ ਸਮਝ ਨਹੀਂ ਆਇਆ — ਸਿਰਫ਼ ਦਵਾਈ ਦਾ ਨਾਮ ਦੱਸੋਗੇ?',
  'ta-IN': 'மருந்தின் பெயர் எனக்குச் சரியாகப் புரியவில்லை — மருந்தின் பெயரை மட்டும் சொல்வீர்களா?',
  'te-IN': 'మందు పేరు నాకు సరిగ్గా అర్థం కాలేదు — మందు పేరు మాత్రం చెబుతారా?',
  'bn-IN': 'ওষুধের নামটা আমি ঠিক বুঝতে পারিনি — শুধু ওষুধের নামটা বলবেন?',
  'gu-IN': 'દવાનું નામ મને બરાબર સમજાયું નહીં — ફક્ત દવાનું નામ કહેશો?',
  'ml-IN': 'മരുന്നിന്റെ പേര് എനിക്ക് ശരിക്ക് മനസ്സിലായില്ല — മരുന്നിന്റെ പേര് മാത്രം പറയാമോ?',
  'od-IN': 'ଔଷଧର ନାମ ମୁଁ ଠିକ୍ ବୁଝିପାରିଲି ନାହିଁ — କେବଳ ଔଷଧର ନାମ କହିବେ କି?',
};

// RUNG 1 (weak-guess yes/no) WAS HERE — DELETED 2026-07-27, along with
// MED_GUESS_CONFIRM and MED_GUESS_MAX_DIST = 0.47.
//
// The reasoning was sound and the evidence was not. A binary question IS more
// robust than re-articulating a drug name, and 0.47 WAS the knee of the sweep
// that justified it — 6/8 real garbles caught, 0/9 junk offered. But that sweep
// was run on hand-written misspellings of drugs already in our lexicon, which
// is not the population this rung meets on a live call.
//
// RE-MEASURED on real decodes (Eka corpus, the rows where the rung actually
// fires — nothing at 0.34, something at 0.47): 0 of 9 guesses were a gold
// molecule of that row. triglyceride → Nitroglycerin. pneumonia → Pancuronium.
// flavor → Flavoxate. sclerosing → Silodosin, three times. Across the whole
// corpus the 0.47 bar recovers 3 of the 206 resolvable mentions the 0.34 bar
// misses.
//
// So it bought 3 mentions in 814 while asking an agreeable caller to press 1
// confirming a molecule they are not taking — manufacturing the exact confident
// false record the read-back layer exists to prevent. The templates are deleted
// rather than left unused: a ready-made "press 1 to confirm this guess" string
// sitting beside the ladder is how it comes back.
//
// The lesson is the reusable part: a threshold swept against synthetic inputs
// is a claim about synthetic inputs. Sweep against the population the code will
// actually see, or do not ship the number.
// Rush signals — the caller wants to skip history and just book.
// A DENIAL OF THE PREMISE, not a symptom. Live 2026-08-08: Ritu asked "यह
// तकलीफ़ कब से है जी?", the caller answered "तकलीफ़ नहीं है बस मुझे अपना दांत
// दिखाना है" — there is NO problem, I want a check-up — and was asked the same
// question again, verbatim, because the reply contains दांत and दांत maps to
// Dental, so the symptom-restatement detector claimed it. The answer to "how
// NO \b IN THIS PATTERN. JavaScript's \b is ASCII-only, so it never matches
// after a Devanagari character — /तकलीफ़ नहीं\b/ tests FALSE against "तकलीफ़
// नहीं है". The first draft of this regex carried one and silently matched
// nothing; the driving test caught it, a source grep would not have.
// long has this been going on?" was "it hasn't", which is an ANSWER; it must
// advance the interview, not restart it. Routine check-ups are a normal reason
// to call a clinic.
// ─── AN ALLERGY IS NOT A PRESCRIPTION ──────────────────────────────────────
// The meds question asks two clinically OPPOSITE things in one slot — "कोई दवाई
// चल रही है या कोई एलर्जी है जी?" — and findAllDrugMentions is a bag-of-
// candidates scan with no polarity. VERIFIED live 2026-08-10:
//
//   "मुझे penicillin से allergy hai"  ->  ["Penicillin"]
//   Ritu: "आप Penicillin ले रहे हैं — मैंने सही सुना ना?"
//         ("You are TAKING Penicillin — did I hear that right?")
//
// The patient answers "हाँ" truthfully — she asked whether she heard the NAME
// right — and it is stored as a drug they take. patient_medications has no
// column that could say otherwise: `grep -rin allerg db/migrations` returns
// ZERO across all eight. Migration 007 calls `canonical` "the only field that
// should ever be treated as clinical" and indexes it as "current medications".
// So the pre-visit view tells a doctor this patient TOLERATES a beta-lactam.
// A stopped-drug row makes a doctor ask a question; this one makes them stop.
//
// It compounds too: the confirmed row returns as a matcher prior on the NEXT
// call at PRIOR_MAX_DIST 0.50 — twice the general bar — under a comment saying
// "the worst case is echoing back a molecule they really do take".
//
// CLAUSE-SCOPED, not utterance-scoped. Dropping the whole turn would lose a
// genuine current medication named in the same breath ("मैं Telma लेता हूँ।
// मुझे penicillin से एलर्जी है।" — live, that currently records BOTH), and that
// is a capture loss we do not have to take.
//
// NOT ROUTED TO THE ALLERGY READ-BACK, deliberately. readback.js already has
// the copy, already translated — `आपको ${v} से एलर्जी है — सही?` — and
// readbackLine already dispatches on entityType. Speaking it without a column
// to store the answer would be WORSE: the patient confirms "yes, I'm allergic"
// and it still persists as a medication. That copy stays unreachable until a
// migration gives it somewhere to land.
const ALLERGY_RE = /एलर्जी|अलर्जी|ऍलर्जी|अ‍ॅलर्जी|ॲलर्जी|allerg|ಅಲರ್ಜಿ|ਐਲਰਜੀ|அலர்ஜி|అలర్జీ|অ্যালার্জি|એલર્જી|അലർജി/i;
// Split on sentence enders AND the conjunctions an 8kHz transcript leaves
// unpunctuated, so "मैं Telma लेता हूँ और penicillin से एलर्जी है" separates.
// पर is the commonest Hindi "but" and was missing from the first draft, which
// made "मैं Telma लेता हूँ पर Telma से एलर्जी है" a SINGLE clause — so the
// contradiction filter below never ran and its test passed for the wrong
// reason. Caught by mutation, not by reading. लेकिन/मात्र/तरी added with it.
//
// THE COMMA WAS MISSING, AND SO WERE NINE LANGUAGES' CONJUNCTIONS. Live call
// aa545e2c, 2026-08-15, a Kannada caller answering the meds/allergy question:
//
//     PATIENT  ಒಂದು ಡೋಲೋ 650 ತಗೊಂಡಿದ್ದೆ, ಅಲರ್ಜಿ ಏನಿಲ್ಲ.
//              ("I took a Dolo 650, no allergy")
//     RITU     ನಿಮಗೆ Dolo ನಿಂದ ಅಲರ್ಜಿ ಇದೆ — ಸರಿಯೇ?
//              ("you are ALLERGIC to Dolo — correct?")
//     PATIENT  ಇಲ್ಲ, ಡೋಲೋ 650 ತಗೊಂಡೆ. ಆ ತರ ಏನು ಅಲರ್ಜಿ ಇಲ್ಲ ನನಗೆ.
//              ("no, I TOOK Dolo 650. I have no such allergy") → hung up
//
// The separator was a COMMA, which `[?।.!]` does not contain, and Kannada's
// conjunctions were not in the list either — so the whole sentence was ONE
// clause, ALLERGY_RE matched on ಅಲರ್ಜಿ, and the drug the patient TAKES was
// filed as a drug they REACT to. The exact inversion of the truth, spoken back
// to the caller and headed for the record the doctor reads before prescribing.
// The conjunction list was Hindi/Marathi/English only while the drug matcher
// had already been opened to nine scripts (be5e99d) — so every Indic language
// could reach this splitter and only two could be split correctly.
const ALLERGY_CLAUSE_SPLIT = /(?<=[?।.!,;、])\s*|\s+(?:और|आणि|पण|पर|लेकिन|परंतु|मात्र|तरी|but|and|ಮತ್ತು|ಆದರೆ|மற்றும்|ஆனால்|మరియు|కానీ|এবং|কিন্তু|ਅਤੇ|ਪਰ|અને|પણ|ഉം|പക്ഷെ|ଏବଂ|କିନ୍ତୁ)\s+/i;

// "NO allergy" IS NOT AN ALLERGY. ALLERGY_RE fires on the WORD, so a clause
// denying an allergy looked identical to one declaring it — "penicillin ಅಲರ್ಜಿ
// ಇಲ್ಲ" would file penicillin as an allergen. An inverted allergy record is not
// a smaller version of a missing one: it makes a doctor withhold a drug the
// patient tolerates, and it hides the drug they are actually taking.
//
// Scoped to the clause, never the whole utterance — "penicillin से एलर्जी है,
// और कोई दवा नहीं" carries a negation that belongs to the SECOND clause, and
// applying it to the first would drop a real allergy.
// ALLERGY_NEGATED_RE moved to nameGuard.NEGATED_RE — one home for "not" in
// eleven languages, shared with the name-denial check. The local copy also
// lacked the Indic lookaheads: Kannada ಇಲ್ಲಿ ("here") contains ಇಲ್ಲ ("no"), so
// "there IS an allergy here" was read as a denial and the allergen dropped.

// Split what the caller said into MEDICATIONS and ALLERGENS by clause. Returns
// null when no allergy is mentioned at all, so the ordinary path is untouched
// on the overwhelming majority of turns.
function _splitMedsAndAllergens(text, opts) {
  const probe = String(text || '');
  if (!ALLERGY_RE.test(probe + ' ' + toDevanagari(probe))) return null;
  const meds = [], allergens = [];
  for (const clause of probe.split(ALLERGY_CLAUSE_SPLIT)) {
    if (!clause || !clause.trim()) continue;
    const probeClause = clause + ' ' + toDevanagari(clause);
    const isAllergy = ALLERGY_RE.test(probeClause);
    // A DENIED allergy contributes to NEITHER bucket. Not to allergens (the
    // patient just said they do not react to it) and not to meds either — "no
    // penicillin allergy" is not a statement that they take penicillin.
    if (isAllergy && NEGATED_RE.test(probeClause)) continue;
    const bucket = isAllergy ? allergens : meds;
    for (const d of findAllDrugMentions(clause, opts)) {
      if (!bucket.some((k) => k.canonical === d.canonical)) bucket.push(d);
    }
  }
  // A molecule named in BOTH halves is an allergen. "मैं Telma लेता हूँ पर
  // Telma से एलर्जी है" is a contradiction, and the safe reading of a
  // contradiction about a drug is the one that withholds it.
  return { meds: meds.filter((m) => !allergens.some((a) => a.canonical === m.canonical)), allergens };
}

const HISTORY_DENIAL_RE = /(तकलीफ़?|तकलिफ़?|दर्द|दिक्कत|परेशानी|problem|pain|तक्रार|त्रास)\s*(तो\s*)?(कुछ\s*)?(नहीं|नही|नाही|नको|no|not)|^\s*(कोई|काही|कुछ)\s*(तकलीफ़?|दिक्कत|परेशानी|problem)\s*(नहीं|नही|नाही)|(no|koi)\s+problem|सिर्फ़?\s*(checkup|चेकअप|जांच)|just\s+a?\s*(check\s*-?up|checkup)/i;
const RUSH_RE = /जल्दी|jaldi|फटाफट|फ़टाफ़ट|तुरंत|turant|बस\s*बुक|बुक\s*कर\s*दो|book\s*(it|kar\s*do)|quickly|no\s+time|अभी\s*अभी|abhi\s*abhi/i;

// "You seem busy, I'll call later" — the silence-hangup goodbye, per language.
const BUSY_GOODBYE = {
  'hi-IN': 'लगता है आप व्यस्त हैं। मैं बाद में कॉल करती हूँ, धन्यवाद!',
  'mr-IN': 'तुम्ही व्यस्त आहात असं वाटतंय. मी नंतर कॉल करते, धन्यवाद!',
  'en-IN': 'It seems you are busy. I will call back later, thank you!',
  'kn-IN': 'ನೀವು ಬ್ಯುಸಿ ಇದ್ದೀರಿ ಅನಿಸುತ್ತದೆ. ನಾನು ನಂತರ ಕರೆ ಮಾಡುತ್ತೇನೆ, ಧನ್ಯವಾದಗಳು!',
  'pa-IN': 'ਲੱਗਦਾ ਹੈ ਤੁਸੀਂ ਰੁੱਝੇ ਹੋ। ਮੈਂ ਬਾਅਦ ਵਿੱਚ ਕਾਲ ਕਰਾਂਗੀ, ਧੰਨਵਾਦ!',
  'ta-IN': 'நீங்கள் பிஸியாக இருக்கிறீர்கள் போலும். நான் பிறகு அழைக்கிறேன், நன்றி!',
  'te-IN': 'మీరు బిజీగా ఉన్నట్టున్నారు. నేను తర్వాత కాల్ చేస్తాను, ధన్యవాదాలు!',
  'bn-IN': 'মনে হচ্ছে আপনি ব্যস্ত। আমি পরে কল করব, ধন্যবাদ!',
  'gu-IN': 'લાગે છે તમે વ્યસ્ત છો. હું પછી કૉલ કરીશ, આભાર!',
  'ml-IN': 'നിങ്ങൾ തിരക്കിലാണെന്ന് തോന്നുന്നു. ഞാൻ പിന്നീട് വിളിക്കാം, നന്ദി!',
  'od-IN': 'ଆପଣ ବ୍ୟସ୍ତ ଥିବା ପରି ଲାଗୁଛି। ମୁଁ ପରେ କଲ୍ କରିବି, ଧନ୍ୟବାଦ!',
};

// The "sorry, could you say that again?" degenerate-reply fallback, per language.
const FALLBACK_LINE = {
  'hi-IN': 'माफ़ कीजिए, ज़रा फिर से बताइएगा?',
  'mr-IN': 'माफ करा, पुन्हा सांगाल का?',
  'en-IN': 'Sorry, could you please say that again?',
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਦੱਸੋਗੇ?',
  'ta-IN': 'மன்னிக்கவும், மீண்டும் ஒருமுறை சொல்லுங்களா?',
  'te-IN': 'క్షమించండి, దయచేసి మళ్ళీ చెప్తారా?',
  'bn-IN': 'দুঃখিত, আবার একটু বলবেন কি?',
  'gu-IN': 'માફ કરશો, ફરી એકવાર કહેશો?',
  'ml-IN': 'ക്ഷമിക്കണം, ഒന്നുകൂടി പറയാമോ?',
  'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ପୁଣି ଥରେ କହିବେ କି?',
};

// ─── ADAPTIVE ENDPOINTING ─────────────────────────────────────────────────────
// Callers pause mid-thought (especially in Hindi). If their utterance ENDS on a
// hanging conjunction/preposition ("...तो", "...और", "...कि", "...आणि", "...म्हणजे")
// it's almost certainly unfinished — so we hold a beat longer for the rest instead
// of cutting them off. A COMPLETE utterance keeps the snappy 300ms debounce, so this
// adds latency ONLY where the caller is clearly still talking. Tunable from logs.
// Covers Hindi + English AND Marathi (this is a Marathi-FIRST call, so Marathi
// conjunctions/clause-starters must be here or the fast paths could cut a Marathi
// caller mid-thought). Over-inclusion only costs a little latency; under-inclusion
// risks a cutoff — so we lean generous on the Marathi side.
const ENDPOINT_HOLD_MS = parseInt(process.env.ENDPOINT_HOLD_MS || '1100', 10);
// Hold-extend (live 2026-07-24 call 2a962ec6): when ANY hold expires while the
// caller is STILL mid-utterance (VAD START_SPEECH seen, no END_SPEECH yet),
// re-arm briefly instead of dispatching the half-sentence. Capped so a noisy
// line can never starve dispatch (max adds ~2.1s once per turn).
// How long a keypad answer to a read-back is still honoured after the SPOKEN
// answer came back unclear. Live 2026-07-26: the caller pressed 1 nineteen
// seconds after Ritu's question, by which point the pending read-back had
// already been cleared by a stray fragment. 45s covers a caller who reaches
// for the keypad only once they realise speech is not getting through.
const READBACK_DTMF_GRACE_MS = parseInt(process.env.READBACK_DTMF_GRACE_MS || '45000', 10);
// Silence-ghost floor. Real speech on this line peaks in the thousands; the
// quietest genuine turn we have measured is ~215, and clear speech runs
// 2,000-10,000. 120 sits well under any real voice while still catching the
// RMS-13 hallucinations. Only SHORT transcripts are dropped — a long one at low
// amplitude is a quiet caller, not a ghost.
const GHOST_RMS_FLOOR = parseInt(process.env.GHOST_RMS_FLOOR || '120', 10);
const GHOST_MAX_TOKENS = parseInt(process.env.GHOST_MAX_TOKENS || '2', 10);
const HOLD_EXTEND_MS = parseInt(process.env.HOLD_EXTEND_MS || '700', 10);
const HOLD_EXTEND_MAX = parseInt(process.env.HOLD_EXTEND_MAX || '3', 10);
// NOTE: bare clause-final POSTPOSITIONS (का/के/को/में/से/पे/पर/की/मी/मला) were removed —
// they legitimately END elliptical questions ("किस डॉक्टर से?", "कौन से?") and were paying
// a needless 1100ms hold ON TOP of the ~1s VAD floor (the 2.8s worst-case). Only CONJUNCTIONS
// remain (और/तो/कि/लेकिन/क्योंकि/आणि/म्हणजे…) which almost never end a finished utterance.
// The quiet-pause case stays protected by the soft-hold below. (Same trim as 1c06a17.)
const INCOMPLETE_TAIL = /(?:^|\s)(और|या|तो|कि|अगर|क्योंकि|लेकिन|मगर|मतलब|यानी|जो|एक|एक्चुअली|मैंने|उन्होंने|हमने|आपने|इन्होंने|आणि|आणी|किंवा|पण|म्हणून|म्हणजे|कारण|तर|जर|आम्ही|तुम्ही|आपण|त्याने|तिने|यांनी|ಮತ್ತು|ಆದರೆ|ಅಥವಾ|ਅਤੇ|ਪਰ|ਜਾਂ|மற்றும்|ஆனால்|அல்லது|మరియు|కానీ|లేదా|এবং|কিন্তু|আর|અને|પણ|અથવા|പിന്നെ|എന്നാൽ|അല്ലെങ്കിൽ|ଏବଂ|କିନ୍ତୁ|ଅଥବା|but|and|so|because|actually|like|that|to)\s*[।.!?,…]*\s*$/i;
function looksIncomplete(text) {
  return INCOMPLETE_TAIL.test((text || '').trim());
}

// Approximate transliteration of any Indic-script text to Devanagari. The nine
// Brahmic Unicode blocks share one 128-codepoint layout (क at +0x15 in every
// block), so a per-block offset shift maps ಪಂಜಾಬಿ→पंजाबि, தமிழ்→तमिऴ्. Lossy at
// script-specific letters — callers must use vowel-tolerant patterns. Used by
// the language-request detector so "पंजाबी में बात करो" is caught even when a
// kn/ta/te-pinned STT session writes it in that session's script.
// MOVED to translit.js so the WhatsApp path can normalise typed text before
// running the same detectors, without importing callHandler.
const { toDevanagari } = require("./translit");
// NOTE: translit.js and devanagari.js BOTH export toDevanagari and they agree
// today (verified across all nine scripts, 2026-08-15) — a seventh copy of one
// rule in this repo. Not merged here because a transliteration change is not
// something to land unrehearsed; it is on the backlog.
const { toSpeakableScriptWords } = require('./devanagari');
const { SCRIPT_BLOCK } = require('./spokenLanguages');

// Per-language script ranges for the reply-sync dominance gate (hi/mr share
// Devanagari; the rest are the same blocks INDIC_BLOCKS shifts from).
const SCRIPT_CHARS = {
  'hi-IN': /[ऀ-ॿ]/g, 'mr-IN': /[ऀ-ॿ]/g,
  'bn-IN': /[ঀ-৿]/g, 'pa-IN': /[਀-੿]/g,
  'gu-IN': /[઀-૿]/g, 'od-IN': /[଀-୿]/g,
  'ta-IN': /[஀-௿]/g, 'te-IN': /[ఀ-౿]/g,
  'kn-IN': /[ಀ-೿]/g, 'ml-IN': /[ഀ-ൿ]/g,
};

const BARGE_IN_MIN_CHARS = 4;

// Garble guard: on a heavily-degraded line, ask the caller to repeat instead of
// feeding noise into booking/clinical capture. Deterministic, fail-open, and
// validated at 0 false-positives on 49 real clean/telephony transcripts + 7/7
// integration checks. OPT-IN (GARBLE_GUARD=on) so the code ships inert and is
// only activated after a dress-rehearsal call. Capped so it can never loop.
const GARBLE_GUARD_ENABLED = process.env.GARBLE_GUARD === 'on';
const GARBLE_MAX_REPROMPTS = 2;
const TRANSCRIPT_MIN_CHARS = 2;
const TRANSCRIPT_DEBOUNCE_MS = 300;
// Short-burst hold: a LOUD caller who pauses mid-thought ("मेरा पेट" … "दर्द हो
// रहा है") gets cut on Sarvam's ~1s silence boundary, and the rest then barges in.
// When a finalized turn is very SHORT, not a backchannel, AND was loud (the actual
// cutoff signature), hold a beat longer so the continuation coalesces into one turn
// instead of fragmenting. The loudness gate is what keeps a normal-volume short
// answer ("कल", "मंगलवार") snappy — only loud short bursts pay the hold.
// Flag-gated (ENABLE_SHORT_HOLD) + A/B-tunable from the turn-peak-RMS logs.
const ENABLE_SHORT_HOLD = process.env.ENABLE_SHORT_HOLD === 'true';
const SHORT_HOLD_MS = parseInt(process.env.SHORT_HOLD_MS || '900', 10);
const SHORT_HOLD_MAX_WORDS = parseInt(process.env.SHORT_HOLD_MAX_WORDS || '2', 10);
// Peak RMS above which a short burst counts as "loud" enough to likely be a
// mid-sentence pause. Normal speech peaks ~1500-3500; the confirmed cutoffs ran
// 6000-10485. 4500 sits clear of normal and catches the loud bursts. Tune from logs.
const SHORT_HOLD_MIN_PEAK = parseInt(process.env.SHORT_HOLD_MIN_PEAK || '4500', 10);
// Soft-speaker hold (ENABLE_SOFT_HOLD, default ON): a QUIET turn (low peak RMS) gets
// endpointed PREMATURELY by Sarvam's VAD — quiet speech reads as near-silence, so the
// VAD fires END_SPEECH mid-sentence and Ritu cuts the caller off (observed live: a
// low-voiced tester was repeatedly interrupted where his louder brother was not). Hold
// a beat longer so the quiet continuation coalesces. This touches NO audio and NO VAD
// setting → zero ghost-transcript risk; it only costs latency on genuinely-quiet turns
// (far better than interrupting them). Skips backchannels. The mirror of SHORT_HOLD:
// loud-short bursts AND quiet turns both get room; normal-volume turns stay snappy.
const ENABLE_SOFT_HOLD = process.env.ENABLE_SOFT_HOLD !== 'false';
const SOFT_HOLD_MS = parseInt(process.env.SOFT_HOLD_MS || '900', 10);
// 2500 (was 1300): covers the normal-to-quiet band, not just very-quiet callers — this
// is the group fast-endpoint could otherwise cut off on a pause. Loud/confident speakers
// (>2500) keep the snappy fast path; everyone softer gets room to finish.
const SOFT_HOLD_MAX_PEAK = parseInt(process.env.SOFT_HOLD_MAX_PEAK || '2500', 10);
// Fast endpoint (ENABLE_FAST_ENDPOINT, default ON): when the final
// transcript arrives right after a Sarvam END_SPEECH, Sarvam has ALREADY proven the
// caller stopped (it waited ~1s of silence) and delivered the COMPLETE final as one
// message — so the usual 300ms coalesce debounce is mostly redundant "did they stop?"
// dead air on top of silence Sarvam already measured. On those turns we trim to
// POST_ENDSPEECH_DEBOUNCE_MS. Guards: only when NOT looksIncomplete (incl. the new
// Marathi tails), only within POST_ENDSPEECH_WINDOW_MS of the last speech-end (so a
// mid-speech PARTIAL — stale _lastSpeechEndAt — keeps the full 300ms), and never
// below 150ms (split-final fragments >150ms apart would dispatch separately). A/B it
// from logs: each fast dispatch prints, so fragmentation is visible.
// DEFAULT ON: callers barge in when they wait too long, so favour speed. The cut-in
// risk this carries is for soft/slow speakers whose pauses read as END_SPEECH — and
// those are now caught by the (widened) soft-hold below, which holds quiet turns. Loud,
// confident speakers (who get the fast 150ms) rarely pause mid-sentence. Set
// ENABLE_FAST_ENDPOINT=false to trade the ~150ms back if cut-ins reappear.
const ENABLE_FAST_ENDPOINT = process.env.ENABLE_FAST_ENDPOINT !== 'false';
const POST_ENDSPEECH_DEBOUNCE_MS = parseInt(process.env.POST_ENDSPEECH_DEBOUNCE_MS || '150', 10);
const POST_ENDSPEECH_WINDOW_MS = parseInt(process.env.POST_ENDSPEECH_WINDOW_MS || '600', 10);
const ECHO_BLANKING_MS = 500;
const RMS_LOG_EVERY_N_CHUNKS = 25;
// Safety cap on opening-greeting protection: normally cleared by the greeting's
// ritu_done mark (~5s of audio), but if that mark is ever lost we must not drop
// patient input forever. The cached greeting is ~5.3s, so 9s is safe headroom.
const GREETING_PROTECT_MAX_MS = 9000;

// Drop short non-backchannel transcripts that arrive within this window of
// Ritu finishing a non-question turn — they are almost always echo or VAD
// hallucinations. If Ritu's last turn ended with a question mark, this
// filter is bypassed (the patient may be answering with a short reply
// like "kal subah" or "haan main"). Tunable via env so we can adjust
// from real call data without redeploying.
const GHOST_TRANSCRIPT_WINDOW_MS = parseInt(process.env.GHOST_TRANSCRIPT_WINDOW_MS || '2000', 10);
const GHOST_TRANSCRIPT_MAX_TOKENS = 3;
const CRITICAL_ERROR_MESSAGE = {
  'mr-IN': 'माफ करा, काही तांत्रिक अडचण आली. कृपया थोड्या वेळाने पुन्हा कॉल करा.',
  'hi-IN': 'माफ़ी चाहती हूँ, कुछ तकनीकी समस्या आ गई। कृपया थोड़ी देर में दोबारा कॉल करें।',
  'en-IN': 'I am sorry, we hit a technical issue. Please call again in a little while.',
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ತಾಂತ್ರಿಕ ಸಮಸ್ಯೆ ಬಂದಿದೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಕರೆ ಮಾಡಿ.',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਕੋਈ ਤਕਨੀਕੀ ਸਮੱਸਿਆ ਆ ਗਈ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕਾਲ ਕਰੋ।',
  'ta-IN': 'மன்னிக்கவும், தொழில்நுட்பக் கோளாறு ஏற்பட்டது. சிறிது நேரம் கழித்து மீண்டும் அழைக்கவும்.',
  'te-IN': 'క్షమించండి, సాంకేతిక సమస్య వచ్చింది. దయచేసి కాసేపటి తర్వాత మళ్ళీ కాల్ చేయండి.',
  'bn-IN': 'দুঃখিত, একটি প্রযুক্তিগত সমস্যা হয়েছে। অনুগ্রহ করে কিছুক্ষণ পরে আবার কল করুন।',
  'gu-IN': 'માફ કરશો, કોઈ ટેક્નિકલ સમસ્યા આવી. કૃપા કરીને થોડી વાર પછી ફરી કૉલ કરો.',
  'ml-IN': 'ക്ഷമിക്കണം, ഒരു സാങ്കേതിക പ്രശ്നം ഉണ്ടായി. ദയവായി കുറച്ച് കഴിഞ്ഞ് വീണ്ടും വിളിക്കൂ.',
  'od-IN': 'କ୍ଷମା କରନ୍ତୁ, କିଛି ଟେକ୍ନିକାଲ୍ ସମସ୍ୟା ଆସିଛି। ଦୟାକରି କିଛି ସମୟ ପରେ ପୁଣି କଲ୍ କରନ୍ତୁ।',
};

// PCM16 @ 8kHz: 2 bytes/sample × 8000 samples/sec ÷ 1000 = 16 bytes/ms.
// Silence sample value is 0 (0x00 bytes).
const PCM16_BYTES_PER_MS = 16;

// Exotel prefers outgoing audio chunk sizes that are multiples of 320 bytes
// (20ms frames at PCM16 8kHz). We slice TTS output to respect this.
const EXOTEL_CHUNK_BYTES = 320;
const EXOTEL_OUTGOING_CHUNK_BYTES = 3200; // 100ms at PCM16 8kHz

// Single-word acknowledgment tokens. The detector tokenizes the transcript
// and checks if ≥80% of tokens are in this set, so combined acknowledgments
// like "haan ji bilkul" or "हाँ ठीक है" match without requiring every
// possible combination to be enumerated. Single-token transcripts (e.g.
// "haan") match at 100%.
const BACKCHANNEL_TOKENS = new Set([
  // Latin (Hinglish/English)
  'haan', 'ha', 'hmm', 'hm', 'hmmm',
  'okay', 'ok', 'yes', 'yeah', 'right', 'sure',
  'achha', 'achchha', 'ji',
  'theek', 'thik', 'bilkul', 'sahi', 'matlab',
  'arre', 'bhai', 'bol', 'sir', 'madam', 'hai', 'hain',
  // Marathi (Latin)
  'ho', 'hoy', 'bara', 'barobar', 'chalel',
  // Devanagari (Hindi)
  'हाँ', 'हा', 'हम्म', 'हम्म्म', 'जी',
  'अच्छा', 'ठीक', 'बिल्कुल', 'सही', 'अरे', 'बोल', 'है', 'हैं',
  'श्योर', 'श्यूर', 'ओके', 'ओक', 'येस', 'राइट',
  // Devanagari (Marathi)
  'हो', 'होय', 'बरं', 'बरा', 'बरोबर', 'चालेल', 'व्हय',
  // Multilingual (2026-07-09 systematic-audit fix): a Kannada caller's
  // "ಹೌದು ಹೌದು" murmur registered as a BARGE-IN and aborted Ritu's sentence
  // mid-word on a live call — every supported language needs its
  // acknowledgment murmurs here, same as hi/mr.
  // Kannada
  'ಹೌದು', 'ಹೂಂ', 'ಹಾಂ', 'ಹ್ಞೂ', 'ಸರಿ', 'ಆಯ್ತು', 'ಆಯಿತು', 'ಓಕೆ', 'ಅಚ್ಚಾ',
  // Punjabi
  'ਹਾਂ', 'ਹਾਂਜੀ', 'ਹੂੰ', 'ਠੀਕ', 'ਅੱਛਾ', 'ਸਹੀ', 'ਜੀ', 'ਓਕੇ',
  // Tamil
  'ஆமா', 'ஆமாம்', 'ஆம்', 'சரி', 'ஓகே', 'ம்ம்', 'ஹூம்',
  // Telugu
  'అవును', 'సరే', 'సరి', 'ఓకే', 'హా', 'ఊ', 'హూ',
  // Bengali
  'হ্যাঁ', 'হুম', 'হু', 'আচ্ছা', 'ঠিক', 'জি', 'ওকে',
  // Gujarati
  'હા', 'હં', 'સારું', 'ઠીક', 'બરાબર', 'જી', 'ઓકે',
  // Malayalam
  'അതെ', 'ശരി', 'ഉം', 'ഉവ്വ്', 'ഓകെ', 'ആ',
  // Odia
  'ହଁ', 'ହଉ', 'ଠିକ୍', 'ଆଚ୍ଛା', 'ଓକେ'
]);

// Multi-word phrases that don't decompose cleanly into individual backchannel
// tokens. Checked as exact-match before the per-token ratio.
const BACKCHANNEL_PHRASES = new Set([
  'sun raha hu', 'sun raha hun', 'sun rahi hu', 'sun rahi hun',
  'theek thak', 'thik thak'
]);

// Telephony recording disclosure ("This call is now being recorded") plays at
// the start of every recorded call and leaks into STT — we saw it transcribed
// phonetically ("दिस कॉल इज नाउ बीइंग रिकॉर्डेड") and answered as if the patient
// said it. Drop it. Matches a record-word + a call/being/in-progress word, but
// NOT a genuine patient question about recording (those carry क्या or '?').
function isRecordingAnnouncement(text) {
  const t = (text || '').toLowerCase();
  // Gujarati added 2026-08-26: Skin Essence announces recording (RECORDING_NOTICE),
  // so OUR OWN notice can now echo back through STT and must be droppable — while
  // a caller genuinely ASKING must still reach the model, hence શું beside क्या.
  if (!/रिकॉर्ड|रेकॉर्ड|record|રેકોર્ડ|રિકોર્ડ/.test(t)) return false;
  if (/क्या|શું|\?/.test(t)) return false; // "is this call being recorded?" — let it through
  return /कॉल|call|बीइंग|being|हो रही|की जा रही|किया जा रह|रहा है|रही है|કૉલ|કોલ|થાય છે|થઈ રહ્યો/.test(t);
}

// Detect MODEL-DEGENERATE output before it reaches TTS. llama-4-scout (and weak
// models generally) sometimes emit reasoning/markdown scaffolding — e.g. "## Step 1:"
// repeated ~30x until the token cap — which we then spoke ALOUD for 15s on a live
// call. A real Ritu reply is a short conversational Hindi/Marathi line; these
// signatures never appear in one.
function isDegenerateReply(raw, cleaned) {
  const r = String(raw || '');
  // a) Chat-template / role-token leakage — the model dumped its own scaffolding
  //    ("assistant\n# No.1\n1.\nassistant…"). A real Hindi/Marathi reply never
  //    contains these English role/template tokens.
  if (/(^|\s)(assistant|system|user)(\s|$)/i.test(r)) return true;
  if (/<\|?(im_start|im_end|eot_id|eot|start_header|end_header)\|?>/i.test(r)) return true;
  // b) Markdown the model should never emit as speech.
  if (/^#{1,6}\s/m.test(r)) return true;                          // header
  if (/```/.test(r)) return true;                                  // code fence
  // c) "Step N" reasoning scaffolding repeated.
  if ((r.match(/step\s*\d+/gi) || []).length >= 2) return true;
  // d) Numbered-list dump (3+ "N." / "N)" line-starts) — never a spoken reply.
  if ((r.match(/^\s*\d+[.)]\s/gm) || []).length >= 3) return true;
  // e) A short fragment repeated many times → low unique-word ratio.
  const words = String(cleaned || '').split(/\s+/).filter(Boolean);
  if (words.length >= 10 && new Set(words).size <= Math.ceil(words.length * 0.3)) return true;
  // f) Absurdly long for a single spoken turn (hard backstop).
  if (String(cleaned || '').length > 400) return true;
  return false;
}

// Strip markdown the model should never speak, then reject degenerate output.
// Returns a clean speakable line, or `fallback` when the output is garbage.
// ─── A WHOLE UTTERANCE IN BRACKETS IS NARRATION, NOT SPEECH ────────────────
// LIVE, spoken aloud to callers:
//
//     (பெங்காலியில் பேச நான் தயார்).                    "(I am ready to speak in Bengali)"
//     (ਤੁਸੀਂ ਚਾਹੋ ਤਾਂ ਹੁਣ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰ ਸਕਦੇ ਹੋ, ਜੀ!)  "(You can speak in Punjabi now, ji!)"
//
// The model narrating its own state instead of talking. Both read perfectly
// well WITHOUT the brackets, so they are unwrapped rather than dropped —
// dropping would leave the caller with silence on a turn they are waiting on.
//
// ONLY THE WHOLE UTTERANCE. MEASURED across every Ritu turn in production,
// 2026-08-15: 2 whole-utterance parentheticals, and 63 INLINE ones — every one
// of those a doctor's specialty, "(Orthopedic Surgeon)", "(MD Medicine)",
// "(Gynecologist)". A blanket strip would have silently deleted the specialty
// from 63 real offers to fix 2 stage directions. callHandler already strips
// parens wholesale elsewhere (the history-matching path), which is correct
// THERE because nothing is spoken — copying that rule here would have been the
// wrong fix arrived at honestly.
//
// SQUARE AND CURLY BRACKETS ARE DIFFERENT: "[Patient Name]", "{{time}}" are
// template scaffolding leaking through the model, not a sentence with brackets
// around it. Those are degenerate — speak the fallback instead.
function unwrapWholeParenthetical(s) {
  const t = String(s).trim();
  if (t.length < 3 || t[0] !== '(') return null;
  // The opening bracket must close at the very end — "(a) and (b)" is two
  // parentheticals in a sentence, not one wrapper, and unwrapping it would
  // produce "a) and (b".
  let depth = 0, end = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const trailing = t.slice(end + 1).trim();
  if (trailing && !/^[।.!?,;]+$/.test(trailing)) return null;   // real text after the close
  const inner = t.slice(1, end).trim();
  return inner || null;
}

function sanitizeForSpeech(raw, fallback) {
  if (!raw) return raw;
  {
    const s = String(raw).trim();
    if (/^[[{<].*[\]}>][।.!?]?$/s.test(s)) return fallback;   // template scaffolding
    const unwrapped = unwrapWholeParenthetical(s);
    if (unwrapped) raw = unwrapped;
  }
  let t = String(raw)
    .replace(/```[\s\S]*?```/g, ' ')        // code fences
    .replace(/^#{1,6}\s*/gm, '')             // ## headers
    .replace(/`+/g, '')                       // inline code ticks
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold**
    .replace(/^\s*[-*+]\s+/gm, '')           // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '')         // "1. " / "1) " list markers
    .replace(/\bstep\s*\d+\s*:?/gi, '')      // "Step 1:" scaffolding
    // Time doubling: Sarvam TTS vocalizes a "HH:MM" clock time WITH the o'clock
    // word ("10:00" → "das vaje"), so when the model ALSO writes the word after
    // it ("10:00 ਵਜੇ") the patient hears it twice — "das vaje vaje" (live call
    // 2026-07-12, same class as the Kannada "hour hour"). Drop the redundant word
    // after a numeric time; TTS still speaks the unit once from the digits.
    .replace(/(\d{1,2}:\d{2})\s*(बजे|वजे|वाजता|वाजून|ਵਜੇ|ಗಂಟೆಗೆ|ಗಂಟೆ|மணிக்கு|மணி|గంటలకు|గంటలు|વાગ્યે|મણિ|o'?clock|baje|vaje)/giu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || isDegenerateReply(raw, t)) return fallback;
  return t;
}

const BACKCHANNEL_RATIO_THRESHOLD = 0.8;

function isBackchannel(text) {
  const normalized = text.toLowerCase().replace(/[।.,!?]+/g, '').trim();
  if (!normalized) return false;
  if (BACKCHANNEL_PHRASES.has(normalized)) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const matched = tokens.filter(t => BACKCHANNEL_TOKENS.has(t)).length;
  return (matched / tokens.length) >= BACKCHANNEL_RATIO_THRESHOLD;
}

// Terminal short answers — हां / ठीक है / नहीं / बुक करो etc. These are COMPLETE by
// definition: nobody is mid-sentence after "हां जी", so they must NOT pay the
// soft-speaker / loud-short hold even when spoken quietly. Skipping the hold here is
// what kills the "theek hai → extra 900ms" lag that hit EVERY confirmation turn (logs:
// "हां, करते" peak 2443, "ना" peak 1148 → 900ms soft-hold). The quiet-speaker
// cut-off protection stays for every NON-terminal utterance. Flag-gated (default ON).
const ENABLE_TERMINAL_FASTPATH = process.env.ENABLE_TERMINAL_FASTPATH !== 'false';
const TERMINAL_WORDS = new Set([
  // thanks/bye/colloquial confirms — multilingual parity (audit 2026-07-09):
  // a soft Tamil "நன்றி" paid the 900ms hold a Hindi "धन्यवाद" skips.
  'ಧನ್ಯವಾದ', 'ಧನ್ಯವಾದಗಳು', 'ಆಗಲಿ', 'ಥ್ಯಾಂಕ್ಸ್', 'ಬಾಯ್',
  'ਧੰਨਵਾਦ', 'ਸ਼ੁਕਰੀਆ', 'ਥੈਂਕਸ', 'ਬਾਏ',
  'நன்றி', 'ஓகே', 'பை',
  'ధన్యవాదాలు', 'థాంక్స్', 'బై', 'సరేనండి',
  'ধন্যবাদ', 'বাই', 'আচ্ছা',
  'આભાર', 'બાય', 'સારું',
  'നന്ദി', 'ബൈ',
  'ଧନ୍ୟବାଦ', 'ବାଏ', 'ହଉ',
  'हां','हाँ','हा','जी','हो','होय','ठीक','थीक','है','ओके','ओक','ok','okay','हम्म',
  'नहीं','नही','ना','नको','नाही','नाय','बुक','करो','करें','करा','कर','दो','द्या',
  'करते','करतो','चालेल','बस','झालं','done','धन्यवाद','थँक्यू','थैंक्यू','बाय','bye',
  // Multilingual confirms/declines — the terminal fast-path + booking gate for
  // pinned new-language calls. Latency/routing only: a word missing here just
  // means the turn takes a longer hold or streams (sentinel backstop still
  // guards booking correctness).
  'yes','no','sure','confirm','cancel','thanks',
  'ಹೌದು','ಸರಿ','ಮಾಡಿ','ಬೇಡ','ಇಲ್ಲ','ಆಯ್ತು',                    // Kannada
  'ਹਾਂ','ਹਾਂਜੀ','ਠੀਕ','ਨਹੀਂ','ਕਰੋ','ਅੱਛਾ',                      // Punjabi
  'சரி','ஆமாம்','ஆம்','வேண்டாம்','இல்லை','செய்யுங்கள்',        // Tamil
  'సరే','అవును','వద్దు','కాదు','చేయండి',                        // Telugu
  'হ্যাঁ','ঠিক','আচ্ছা','না','করুন',                              // Bengali
  'હા','બરાબર','ના','કરો','ઠીક',                                 // Gujarati
  'ശരി','അതെ','വേണ്ട','ചെയ്യൂ',                                  // Malayalam
  'ହଁ','ଠିକ୍','ନା','କରନ୍ତୁ'                                       // Odia
]);
// ─── DID RITU JUST OFFER A BOOKING? ─────────────────────────────────────────
// The turn after "…बुक करूँ?" is a confirm-or-decline turn whatever words the
// caller uses for yes. The pre-route below used to decide that from the CALLER's
// words alone — a word list holding करते/करतो/करो but not करता, ठीक but not चल —
// and two callers said "हां जी, करता।" and "चल ठीक है।", streamed, and heard a
// booking confirmation with no booking (calls 34f1c281, f98508df). A list of
// every way to say yes in eleven languages is not a thing anyone can finish.
//
// Anchored on the LAST SENTENCE of Ritu's last turn ending in a question mark,
// so a fees reply that mentioned booking three sentences ago does not match —
// that was the objection to keying on Ritu's line at all, and it was right
// about substring matching. Over-matching costs one turn its streaming; the
// sentinel + the unified streamed guard now hold correctness either way.
const OFFER_QUESTION_RE = /(बुक|पक्क|कन्फर्म|निश्चित|ठरव|book|confirm|ಬುಕ್|ಖಚಿತ|ਬੁੱਕ|ਪੱਕ|புக்|உறுதி|బుక్|ఖరారు|বুক|নিশ্চিত|બુક|પાક|ബുക്ക്|ഉറപ്പ|ବୁକ୍|ନିଶ୍ଚିତ)/i;
function lastRituTurnWasOffer(lastRituText) {
  const t = String(lastRituText || '').trim();
  if (!t) return false;
  const sentences = t.split(/(?<=[।?？!])\s+/).filter(Boolean);
  const last = (sentences[sentences.length - 1] || '').trim();
  return /[?？]$/.test(last) && OFFER_QUESTION_RE.test(last);
}

function isTerminalConfirmation(text) {
  const norm = String(text || '').toLowerCase().replace(/[।.,!?…'"]+/g, ' ').trim();
  if (!norm) return false;
  const toks = norm.split(/\s+/).filter(Boolean);
  if (toks.length === 0 || toks.length > 3) return false;
  return toks.every(t => TERMINAL_WORDS.has(t));
}

// ─── SPECULATIVE LLM (Phase B latency, flag ENABLE_SPECULATIVE_LLM) ──────────
// The endpoint holds (150–1100ms) and the lean LLM call (~700–900ms to first
// sentence) run in SERIES today. Speculation overlaps them: the moment an STT
// FINAL arrives we start getLeanResponseStream against a SNAPSHOT of the history
// and buffer its chunks — no audio, no side effects (the lean stream generator
// never books; it hands off on any BOOK_APPOINTMENT sentinel). When the debounce
// timer commits the turn with the SAME transcript, the buffered chunks replay
// into the existing speakStream() and the live tail continues — so every safety
// check (generation id, sentinel handoff, fallback re-run) applies unchanged.
// If the patient keeps talking (new FINAL), the speculation is cancelled and a
// new one starts on the grown transcript — capped at 3 starts per turn, so a
// fragmenting utterance wastes at most a few flash-lite calls; never a wrong or
// premature utterance. Speculative failures DO feed the shared LLM failover
// stats/breaker (a 429 is a real quota signal either way). Booking-confirm
// turns are never speculated (same gate as lean streaming): verified-then-speak
// stays intact. Known accepted edge: the system prompt bakes the date at
// speculation start, so a commit straddling midnight could word a relative date
// against the old day — booking turns re-derive fresh, so no wrong bookings.
const ENABLE_SPECULATIVE_LLM = process.env.ENABLE_SPECULATIVE_LLM === 'true';

// ─── MULTILINGUAL (flag ENABLE_MULTILINGUAL, default OFF) ────────────────────
// OFF → byte-identical to today: STT pinned hi-IN, the battle-tested Marathi/
// Hindi voice machinery (_hindiInCall + looksLikeHindi) runs unchanged.
// ON → the call OPENS with saaras:v3 auto-detect (language-code=unknown,
// validated live 2026-07-08: kn/pa/hi/mr all detected correctly incl. short
// confirms). The first substantive utterance PINS the call: a supported
// non-hi/mr language (config.languageNames) sets this.callLanguage and repins
// the STT to it (reliable short-confirm transcription for the rest of the
// call); hi/mr pin back to the legacy hi-IN session and the existing machinery
// takes over; STT-only languages (Assamese/Urdu/Nepali/…) pin hi-IN and Ritu
// replies in Hindi ("understands 23, converses in 11"). Voice per language
// comes from config.speakerForLang; reply language is steered via the lean
// prompt (context.languageCode).
const ENABLE_MULTILINGUAL = process.env.ENABLE_MULTILINGUAL === 'true';

// ─── FORCED CALL LANGUAGE (flag FORCE_LANG, default unset) ───────────────────
// Demo / single-language deployments: FORCE_LANG=kn-IN pins EVERY call to that
// language from the first byte — greeting pre-cached in that language at boot,
// STT opens already pinned (no auto-detect), voice locked for the whole call
// (no mid-call speaker changes — live bug 2026-07-19: Kannada sentences spoken
// by the Hindi voice mid-call), and the brain steered to reply in it. Overrides
// ENABLE_MULTILINGUAL's auto-detect. Unset → byte-identical to today.
const FORCE_LANG = (() => {
  const raw = (process.env.FORCE_LANG || '').trim();
  if (!raw) return null;
  if (!config.languageNames[raw]) {
    console.warn(`[CONFIG] FORCE_LANG='${raw}' has no TTS support (see config.languageNames) — ignoring, normal language behavior`);
    return null;
  }
  console.log(`[CONFIG] FORCE_LANG=${raw} — every call pinned to ${config.languageNames[raw]}; greeting/voice/STT locked, no mid-call switching`);
  return raw;
})();

class LeanSpeculation {
  constructor(transcript, genId, expectedHistoryLen, lastEntryRef, makeStream) {
    this.transcript = transcript;
    this.genId = genId;
    // History snapshot length (incl. this user turn). At commit the live
    // history must have exactly this length. Length ALONE is defeatable —
    // a late assistant push followed by _trimHistory is length-neutral once
    // history sits at MAX_CONVERSATION_HISTORY — so lastEntryRef additionally
    // pins the IDENTITY of the last history entry at snapshot time: at commit,
    // the entry just before the freshly-pushed user turn must still be that
    // same object, else the history mutated under the speculation.
    this.expectedHistoryLen = expectedHistoryLen;
    this.lastEntryRef = lastEntryRef;
    this.startedAt = Date.now();
    this.cancelled = false;
    this.committed = false;
    this._chunks = [];
    this._doneProducing = false;
    this._waiters = [];
    this._producerDone = this._produce(makeStream()).catch(() => {});
  }

  async _produce(stream) {
    try {
      for await (const chunk of stream) {
        if (this.cancelled) break; // break → stream.return() → generator winds down
        this._chunks.push(chunk);
        this._notify();
        // Mirror speakStream's terminal contract — nothing follows these.
        if (chunk.kind === 'done' || chunk.kind === 'fallback-required') break;
      }
    } catch (err) {
      // The generator converts its own errors to fallback-required; this catches
      // anything beyond that so a committed replay still terminates cleanly
      // (speakStream sees fallback → proven non-streaming re-run).
      this._chunks.push({ kind: 'fallback-required', reason: `speculation_error: ${err.message}` });
    } finally {
      this._doneProducing = true;
      this._notify();
    }
  }

  _notify() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  cancel() {
    this.cancelled = true;
    this._notify();
  }

  sentencesBuffered() {
    return this._chunks.filter((c) => c.kind === 'sentence').length;
  }

  // Replay buffered chunks, then continue live — same yield contract as
  // getLeanResponseStream, so speakStream() consumes it unchanged.
  async *commitStream() {
    this.committed = true;
    try {
      let i = 0;
      for (;;) {
        while (i < this._chunks.length) yield this._chunks[i++];
        if (this._doneProducing) return;
        await new Promise((resolve) => this._waiters.push(resolve));
      }
    } finally {
      // Consumer bailed early (barge-in/emergency mid-replay) or finished —
      // either way stop the producer; nothing else will read it.
      this.cancelled = true;
      this._notify();
    }
  }
}

// Speculative COMPLETION for the turns that take the NON-streamed lean path —
// booking confirms/declines (isBookingLikelyTurn) and every post-booking turn.
// Those turns paid the full serial LLM (~0.9-1.4s) AFTER dispatch; this starts
// generateLeanRaw (pure text generation, NO parsing, NO booking) at STT-final
// time and buffers ONE raw string. The side-effectful half (processLeanRaw:
// sentinel parse → DB write → spoken text) runs ONLY at dispatch inside the
// serialized processing chain — exactly where it runs today. Speculation moves
// WHEN the LLM call starts, never what gets booked or spoken. Same validity
// pins as LeanSpeculation (exact transcript, generation id, history length,
// last-entry identity).
class CompletionSpeculation {
  constructor(transcript, genId, expectedHistoryLen, lastEntryRef, run) {
    this.transcript = transcript;
    this.genId = genId;
    this.expectedHistoryLen = expectedHistoryLen;
    this.lastEntryRef = lastEntryRef;
    this.startedAt = Date.now();
    this.cancelled = false;
    // Resolves to the raw completion text, or null on LLM failure — the taker
    // then falls back to a fresh getLeanResponse (same UX as today). A
    // cancelled speculation is simply never read; worst case one wasted
    // flash-lite call, identical to the streaming speculation's cost model.
    this.rawPromise = run().catch((err) => {
      console.warn(`[LEAN] completion speculation failed: ${err.message}`);
      return null;
    });
  }

  cancel() {
    this.cancelled = true;
  }
}

function computeRMS(pcm16Buffer) {
  if (!pcm16Buffer || pcm16Buffer.length < 2) return 0;
  const samples = pcm16Buffer.length >> 1;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm16Buffer.readInt16LE(i * 2);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

// Downward soft-clip LIMITER for inbound PCM16. Samples below ~92% of full-scale
// are copied byte-for-byte unchanged; only peaks above the threshold are pulled
// down with a smooth tanh knee toward (not past) the ±32767 rail. There is NO
// upward/makeup gain, so quiet or normal callers are untouched and line noise is
// never amplified. It cannot un-clip audio the carrier already flat-topped — it
// only rounds hot near-rail peaks before they reach the STT. Flag-gated; off by
// default. Returns the ORIGINAL buffer when nothing crossed the threshold.
const LIMITER_THRESHOLD = Math.round(0.92 * 32767); // ~30145
function softLimitPcm16(buf) {
  if (!buf || buf.length < 2) return buf;
  const n = buf.length >> 1;
  const T = LIMITER_THRESHOLD;
  const RANGE = 32767 - T;
  let out = null; // lazily allocated only if a peak needs limiting
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > T) {
      if (!out) out = Buffer.from(buf); // copy-on-write; never mutate the source
      const comp = T + RANGE * Math.tanh((a - T) / RANGE);
      out.writeInt16LE((s < 0 ? -1 : 1) * Math.min(32767, Math.round(comp)), i * 2);
    }
  }
  return out || buf;
}

// ─── PRE-CACHED GREETING ──────────────────────────────────────────────────────
// Marathi-first: the opening greeting is in Marathi (Ritu voice). The call
// stays Marathi until the patient deliberately speaks/asks Hindi — see
// _currentSpeaker() + looksLikeHindi().
// A stored "name" that is really a placeholder ("Unknown", "Patient", ಅಪರಿಚಿತ,
// अपरिचित…) must NEVER be spoken as the caller's name — greeting "namaskar Unknown
// ji" reads terribly. When the saved name is one of these, fall through to the
// generic greeting that ASKS for the name instead.
const PLACEHOLDER_NAME = /^\s*(unknown|patient|guest|caller|anonymous|n\/?a|user|customer|अपरिचित|अज्ञात|अनजान|मरीज़?|अनोळखी|ಅಪರಿಚಿತ|ರೋಗಿ|అపరిచిత|తెలియని|రోగి|অজানা|রোগী|અજાણ|દર્દી|അജ്ഞാത|രോഗി|ਅਣਜਾਣ|ਮਰੀਜ਼?|ଅଜଣା|ରୋଗୀ)\s*(जी|जि|ji|ಜೀ|జీ|ஜி|জি|જી|ജി|ਜੀ|ଜୀ)?\s*$/i;

// Per-language greeting templates (generic asks-for-name form + the returning-
// patient personalized form). mr-IN is the default; FORCE_LANG selects another.
// THE NAME QUESTION USED TO BE THE LAST SENTENCE OF EACH GREETING, AND ALMOST
// NOBODY ANSWERED IT. MEASURED on 125 production calls, 2026-08-15, looking at
// what the caller's FIRST utterance actually was:
//
//     answered with their name    14  (11%)
//     said something else        111  (89%)  — overwhelmingly their symptom
//
// A patient dials a clinic because something hurts. Asked two questions in one
// breath they answer the one they called about, so we spent the opening line —
// the one moment we have their full attention — on a question 9 in 10 walk past,
// and then asked it again later anyway.
//
// AND IT COSTS NOTHING TO MOVE. The worry was that the symptom turn would be too
// short to pin the STT language (the evidence gate needs >=4 tokens). Measured
// the other way: the 111 non-name openers pin at 73% with a MEDIAN OF 6 TOKENS,
// against 5 for the name answers. A symptom is a sentence; a name is a word.
// Asking the reason first pins the language SOONER, so the name — asked next
// turn — is decoded by a pinned model instead of an unpinned one. That is
// exactly backwards from how it was.
const GREETING_TEXTS = {
  'mr-IN': `नमस्कार! मी ऋतू, ${config.greetingClinicName} मधून — बोला, काय त्रास होतोय?`,
  'hi-IN': `नमस्ते! मैं ऋतू, ${config.greetingClinicName} से — बताइए, क्या तकलीफ़ है?`,
  'kn-IN': `ನಮಸ್ಕಾರ! ನಾನು ಋತು, ${config.greetingClinicName} ಇಂದ — ಹೇಳಿ, ಏನು ತೊಂದರೆ?`,
  // Gujarati opens with "how can I help" rather than "what is the trouble".
  // The three above are GP openers and a skin clinic's callers are not ill —
  // asking a caller enquiring about a hydrafacial what is wrong with them is
  // both wrong and slightly insulting. It still invites a SENTENCE, which is
  // what the 89% pin finding above actually depends on; the symptom framing was
  // never the mechanism, sentence length was.
  // gu-IN MEASURED 2026-09-14 (pooja, pace 1.05, 8 kHz): the previous closing question made the
  // cached intro 10.8–12.1 s; this wording is 8.7 s with the full clinic title and the recording notice kept.
  'gu-IN': `નમસ્તે! હું ઋતુ, ${config.greetingClinicName} માંથી — બોલો, કેવી રીતે મદદ કરું?`,
  // English opening (2026-09-15, founder ask): GREETING_LANG=en-IN used to fall
  // back to Marathi because no English line existed. Auto-detect still pins the
  // caller's language after this; the recording notice splits at the first ". ".
  'en-IN': `Hello! This is Ritu from ${config.greetingClinicName}. How can I help you today?`,
};
const RETURNING_GREETING_TEXTS = {
  'mr-IN': name => `नमस्कार ${name} जी! मी ऋतू, ${config.greetingClinicName} मधून. बोला, आज मी तुमची कशी मदत करू?`,
  'hi-IN': name => `नमस्ते ${name} जी! मैं ऋतू, ${config.greetingClinicName} से। बताइए, आज मैं आपकी कैसे मदद करूँ?`,
  'kn-IN': name => `ನಮಸ್ಕಾರ ${name} ಅವರೇ! ನಾನು ಋತು, ${config.greetingClinicName} ಇಂದ. ಹೇಳಿ, ಇವತ್ತು ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?`,
  'gu-IN': name => `નમસ્તે ${name}! હું ઋતુ, ${config.greetingClinicName} માંથી. બોલો, કેવી રીતે મદદ કરું?`,
  'en-IN': name => `Hello ${name}! This is Ritu from ${config.greetingClinicName}. How can I help you today?`,
};

// ─── "THIS CALL IS RECORDED", WHEN THE CLINIC ASKS FOR IT ───────────────────
// Skin Essence's setup form answers YES to announcing recording (Q72). Other
// clinics already running never agreed to it, and a greeting is the one line
// every single caller hears — so this is OPT-IN per deploy rather than a fleet
// change. RECORDING_NOTICE=on.
//
// It is folded INTO the greeting string, not spoken as a second utterance: one
// TTS call, one cached buffer, no added latency on the first turn. _lastRituText
// therefore covers it for echo suppression like any other greeting words.
//
// Also worth saying plainly: this is a disclosure line, not consent, and it is
// not a retention policy. Nothing here decides how long the audio is kept.
const RECORDING_NOTICES = {
  'mr-IN': 'हा कॉल रेकॉर्ड केला जातो.',
  'hi-IN': 'यह कॉल रिकॉर्ड की जा रही है।',
  'kn-IN': 'ಈ ಕರೆ ರೆಕಾರ್ಡ್ ಆಗುತ್ತಿದೆ.',
  'gu-IN': 'આ કૉલ રેકોર્ડ થાય છે.',
  'en-IN': 'This call is being recorded.',
};
// One definition, in config.js — runtimeConfig records the same resolved value.
const RECORDING_NOTICE_ON = config.recordingNotice;
function withRecordingNotice(text, lang) {
  if (!RECORDING_NOTICE_ON) return text;
  const notice = RECORDING_NOTICES[lang];
  if (!notice) {
    console.warn(`[CONFIG] RECORDING_NOTICE=on but no notice text for ${lang} — greeting sent without it`);
    return text;
  }
  // After the identification, before the question: a caller who hears "this is
  // recorded" as the very first words has not yet been told who they reached.
  // Every greeting separates those two halves with an em-dash or a full stop,
  // so the notice replaces that separator and becomes its own sentence — the
  // alternative left "...from the clinic this call is recorded. — tell me,"
  // which is what the first version of this actually produced.
  const m = text.match(/\s+—\s+|।\s+|\.\s+/);
  if (!m) return `${text} ${notice}`;
  const at = text.indexOf(m[0]);
  const head = text.slice(0, at).trim();
  const tail = text.slice(at + m[0].length).trim();
  const stop = /।\s*$/.test(m[0]) ? '।' : '.';
  return `${head}${stop} ${notice} ${tail}`;
}
// GREETING_LANG env decouples the OPENING language from the full call lock:
// set GREETING_LANG=kn-IN *without* FORCE_LANG and Ritu opens in Kannada but
// stays fully multilingual — auto-detect still pins the caller's language and
// explicit "English mein bolo" switching still works (the investor-demo shape).
const GREETING_LANG = (() => {
  const req = (process.env.GREETING_LANG || '').trim() || FORCE_LANG;
  if (!req) return 'mr-IN';
  if (!GREETING_TEXTS[req]) {
    console.warn(`[CONFIG] ${process.env.GREETING_LANG ? 'GREETING_LANG' : 'FORCE_LANG'}=${req} has no greeting template — greeting stays Marathi (add one to GREETING_TEXTS)`);
    return 'mr-IN';
  }
  // A language can pass the check above and still be half-added. The returning
  // greeting falls back to Marathi on its own, so a caller whose language IS
  // supported would be greeted correctly the first time and in Marathi on their
  // second call — the defect the Gujarati work was written to fix, reappearing
  // one table over. Loud at boot rather than on the call.
  if (!RETURNING_GREETING_TEXTS[req]) {
    console.warn(`[CONFIG] ⚠ ${req} has a greeting but NO returning-patient greeting — every returning caller will hear Marathi (add one to RETURNING_GREETING_TEXTS)`);
  }
  return req;
})();
// ─── ONE SCRIPT PER TTS REQUEST ─────────────────────────────────────────────
// LIVE CALL ed685d54, 2026-08-15. The caller's first second:
//
//     ನಮಸ್ಕಾರ পৃথ্বী ಅವರೇ! ನಾನು ಋತು, स्माईल मल्टीस्पेशालिटी क्लिनिक ಇಂದ...
//
// Three scripts, one Sarvam request, the Kannada speaker: a Kannada frame, the
// patient's name in BENGALI (whatever script their row happens to hold) and the
// clinic's name in DEVANAGARI (the configured string). An Indic TTS engine does
// not code-switch mid-utterance — it mispronounces or drops the foreign run,
// and here that run is the caller's own name.
//
// Off-script tokens are romanized; Latin is the one script every Indic voice
// handles, because loanwords and brand names arrive that way constantly. A
// same-script greeting (Devanagari clinic name on a Hindi call) is untouched.
//
// FOR THE CLINIC NAME THE REAL FIX IS CONFIG: set CLINIC_GREETING_NAME to
// "Smile Multispeciality Clinic" and it needs no transliteration at all —
// romanizing Devanagari gets "Smail Maltispeshaliti Klinik", which is
// pronounceable but not the name anyone would write.
const GREETING_TEXT = toSpeakableScriptWords(withRecordingNotice(GREETING_TEXTS[GREETING_LANG], GREETING_LANG), GREETING_LANG);
// ─── BOOT AUDIO PRE-CACHE, SKIPPABLE FOR TESTS ONLY ─────────────────────────
// Requiring this module makes FIVE Sarvam TTS calls before a single line of
// test code runs. MEASURED 2026-08-14: `node -e "require('./callHandler.js')"`
// takes 13.0 seconds, all of it network. Every test that touches CallHandler
// paid it, and tests/test-emergency-v2-enforcement.js paid it ELEVEN times —
// one child process per env configuration, because V2_ENFORCES is frozen at
// require time. That single file was 139s of a 158s suite.
//
// It also made the suite depend on Sarvam being reachable to answer questions
// that have nothing to do with speech, which is the wrong thing for a deploy
// gate to be able to fail on.
//
// Production is untouched: the pre-cache is what keeps the first greeting and
// the emergency line off live TTS, and it still runs unless a caller opts out
// explicitly. Only tools/run-tests.js sets this.
const SKIP_BOOT_AUDIO = process.env.SKIP_BOOT_AUDIO === '1';

let GREETING_AUDIO = null;

async function preloadGreeting() {
  try {
    console.log(`[CALL] Pre-caching greeting audio (PCM16 8kHz, ${GREETING_LANG})...`);
    // Rendered GREETING_TAKES times in parallel; the briskest take is cached.
    // One draw was a tempo lottery (MEASURED 2026-09-14: 8.8–12.3 s for the
    // same line at the same pace) — see greetingTakes.js.
    const take = await renderBriskest({
      takes: config.greetingTakes,
      synth: () => textToSpeech(GREETING_TEXT, 0, {
        speaker: config.speakerForLang(GREETING_LANG),
        // languageCode passed only for a non-default greeting language — the
        // Marathi path stays byte-identical (detectLanguageCode infers mr).
        ...(GREETING_LANG !== 'mr-IN' ? { languageCode: GREETING_LANG } : {})
      })
    });
    GREETING_AUDIO = take.audio;
    console.log(`[CALL] ✓ Greeting audio pre-cached (${GREETING_LANG}, voice=${config.speakerForLang(GREETING_LANG)}, takes ${take.seconds.map((s) => s.toFixed(1) + 's').join('/')} → kept ${take.keptSeconds.toFixed(1)}s${take.failed ? `, ${take.failed} failed` : ''}, ${GREETING_AUDIO.length} bytes PCM16)`);
  } catch (e) {
    console.error('[CALL] Failed to pre-cache greeting:', e.message);
  }
}

if (!SKIP_BOOT_AUDIO) preloadGreeting();

// ─── PRE-CACHED EMERGENCY MESSAGE ────────────────────────────────────────────
// Played by handleEmergency() when the deterministic detector fires. Cached
// at startup like the greeting so emergency response is instant (no LLM,
// no live TTS round-trip) — that latency budget matters most precisely
// when the patient is in distress.
// Per-language so the emergency line matches the call's locked voice (Marathi
// by default, Hindi once the caller switched). Pre-cached in both, like fillers.
// MOVED to safetyText.js — see the header there. Re-exported below unchanged.
const { EMERGENCY_TEXTS } = require("./safetyText");
// Self-harm / suicidal ideation gets a DIFFERENT message — a warm handoff to the
// national mental-health helpline, never "dial 108 / go to hospital".
// Tele-MANAS 14416 (toll-free 1-800-891-4416) is the government 24×7 line in 20
// languages. KIRAN (1800-599-0019) was REMOVED 2026-07-16: it has been merged
// into Tele-MANAS and is being phased out — quoting a dying number to a caller
// in crisis wastes the seconds that matter (S4 audit, digitalhealthnews.com
// govt-integrates-kiran-mental-health-helpline-with-telemanas). All 11 languages
// covered (was 6 with hi-IN fallback). Not pre-cached (rare) — uses live TTS.
// MOVED to safetyText.js so non-voice channels can reach it without requiring
// callHandler (that require would break the crm.js cycle — see safetyText.js).
const { SELF_HARM_TEXTS } = require("./safetyText");
const EMERGENCY_AUDIO = {};

// Pre-cache emergency audio for the legacy pair only (hi/mr) — 11 sequential
// TTS calls would add ~50s to boot for audio that plays maybe once a month.
// A pinned new-language call that hits an emergency uses the existing
// live-TTS fallback branch in handleEmergency (correct language, ~1s slower).
const EMERGENCY_PRECACHE_LANGS = ['mr-IN', 'hi-IN'];
// Forced- or greeting-language deployments pre-cache that language too — a kn
// demo must never pay live-TTS on the emergency line (silent-hangup risk, S4).
for (const l of [FORCE_LANG, GREETING_LANG]) {
  if (l && l !== 'mr-IN' && !EMERGENCY_PRECACHE_LANGS.includes(l)) EMERGENCY_PRECACHE_LANGS.push(l);
}

async function preloadEmergency() {
  for (const [lang, text] of Object.entries(EMERGENCY_TEXTS).filter(([l]) => EMERGENCY_PRECACHE_LANGS.includes(l))) {
    try {
      EMERGENCY_AUDIO[lang] = await textToSpeech(text, 0, { speaker: config.speakerForLang(lang) });
      console.log(`[CALL] ✓ Emergency audio pre-cached (${lang}, voice=${config.speakerForLang(lang)}, ${EMERGENCY_AUDIO[lang].length} bytes PCM16)`);
    } catch (e) {
      console.error(`[CALL] Failed to pre-cache emergency audio (${lang}):`, e.message);
    }
  }
}

if (!SKIP_BOOT_AUDIO) preloadEmergency();

// ─── PRE-CACHED "THINKING" FILLER ────────────────────────────────────────────
// A short, neutral backchannel played the instant a tool fires (flag-gated),
// so the patient hears Ritu within ~1s instead of waiting out the silent
// tool+LLM round. Pre-cached per language like the greeting (zero TTS round-trip
// at play time). The Marathi text carries the "आहे" marker so detectLanguageCode
// renders it in the Marathi voice (mr-IN), not Hindi.
const FILLER_TEXTS = {
  'hi-IN': 'जी, एक मिनट…', 'mr-IN': 'एक मिनिट, बघते आहे…',
  'en-IN': 'One moment, let me check…',
  'kn-IN': 'ಒಂದು ನಿಮಿಷ, ನೋಡುತ್ತೇನೆ…', 'pa-IN': 'ਇੱਕ ਮਿੰਟ ਜੀ, ਦੇਖਦੀ ਹਾਂ…',
  'ta-IN': 'ஒரு நிமிடம், பார்க்கிறேன்…', 'te-IN': 'ఒక్క నిమిషం, చూస్తున్నాను…',
  'bn-IN': 'এক মিনিট, দেখছি…', 'gu-IN': 'એક મિનિટ, જોઉં છું…',
  'ml-IN': 'ഒരു നിമിഷം, നോക്കട്ടെ…', 'od-IN': 'ଗୋଟିଏ ମିନିଟ୍, ଦେଖୁଛି…'
};
// Boot pre-caches only hi/mr (boot already spends ~20s on TTS); the other
// languages synthesize in the background at pin time — see _ensureFillerFor.
const FILLER_BOOT_LANGS = ['hi-IN', 'mr-IN'];
for (const l of [FORCE_LANG, GREETING_LANG]) {
  if (l && !FILLER_BOOT_LANGS.includes(l)) FILLER_BOOT_LANGS.push(l);
}
const FILLER_AUDIO = {};

async function preloadFillers() {
  for (const lang of FILLER_BOOT_LANGS) {
    const text = FILLER_TEXTS[lang];
    try {
      // Cache each filler in the voice that matches its language, so it lines up
      // with the call's locked voice (mr-IN filler → Ritu, hi-IN filler → Suhani).
      FILLER_AUDIO[lang] = await textToSpeech(text, 0, { speaker: config.speakerForLang(lang) });
      console.log(`[CALL] ✓ Filler audio pre-cached (${lang}, voice=${config.speakerForLang(lang)}, ${FILLER_AUDIO[lang].length} bytes PCM16)`);
    } catch (e) {
      console.error(`[CALL] Failed to pre-cache filler (${lang}):`, e.message);
    }
  }
}
if (!SKIP_BOOT_AUDIO) preloadFillers();

// Synthesize + cache a language's filler/emergency audio in the background at
// pin time (once per process per language). Failures are non-fatal — the
// existing fallbacks (hi filler / live emergency TTS) still apply.
const _fillerInFlight = new Set();
function _ensureFillerFor(lang) {
  if (FILLER_AUDIO[lang] || !FILLER_TEXTS[lang] || _fillerInFlight.has(lang)) return;
  _fillerInFlight.add(lang);
  textToSpeech(FILLER_TEXTS[lang], 0, { speaker: config.speakerForLang(lang), languageCode: lang })
    .then(buf => { FILLER_AUDIO[lang] = buf; console.log(`[CALL] ✓ Filler cached on pin (${lang}, ${buf.length} bytes)`); })
    .catch(err => { _fillerInFlight.delete(lang); console.error(`[CALL] filler cache failed (${lang}):`, err.message); });
}
const _emergencyInFlight = new Set();
function _ensureEmergencyFor(lang) {
  if (EMERGENCY_AUDIO[lang] || !EMERGENCY_TEXTS[lang] || _emergencyInFlight.has(lang)) return;
  _emergencyInFlight.add(lang);
  textToSpeech(EMERGENCY_TEXTS[lang], 0, { speaker: config.speakerForLang(lang), languageCode: lang })
    .then(buf => { EMERGENCY_AUDIO[lang] = buf; console.log(`[CALL] ✓ Emergency audio cached on pin (${lang}, ${buf.length} bytes)`); })
    .catch(err => { _emergencyInFlight.delete(lang); console.error(`[CALL] emergency cache failed (${lang}):`, err.message); });
}

// Delay + serialize the on-pin background synth (live 2026-07-24 call
// 2a962ec6): both HTTP cache calls fired the instant English was pinned and
// competed with the live reply's TTS stream for Sarvam-side capacity — the
// caller's FIRST reply in their new language paid 3.2-3.8s first-byte. These
// caches only serve LATER turns: give the live stream a head start, then run
// the two synth calls one after the other instead of in parallel. The
// existing fallbacks (hi-IN filler / live emergency TTS) cover the delay
// window, and the in-flight guards dedupe repeat queueing.
//
// ORDER (panel 2026-07-24): the EMERGENCY line is synthesized FIRST — it is the
// safety asset (its live-TTS fallback is a documented silent-hangup risk, S4),
// so it gets the shorter cold window; the cosmetic filler waits behind it. A
// mid-call language SWITCH cancels the previous language's pending queue so a
// stale synth can't land inside the new language's live-reply window.
// Timers are stored PER-CALL on `owner` (never module-global): the process
// caches are shared, but a concurrent call pinning a different language must
// not cancel THIS call's pending queue.
const LANG_CACHE_DELAY_MS = parseInt(process.env.LANG_CACHE_DELAY_MS || '4000', 10);
function _queueLangCaches(lang, owner) {
  if (owner._langCacheTimers) for (const t of owner._langCacheTimers) clearTimeout(t);
  owner._langCacheTimers = [];
  owner._langCacheTimers.push(setTimeout(() => {
    _ensureEmergencyFor(lang); // safety asset first
    owner._langCacheTimers.push(setTimeout(() => _ensureFillerFor(lang), LANG_CACHE_DELAY_MS));
  }, LANG_CACHE_DELAY_MS));
}

// Trim a PCM16 buffer to the nearest multiple of EXOTEL_CHUNK_BYTES.
function padOrTrimToChunkBoundary(buffer) {
  const remainder = buffer.length % EXOTEL_CHUNK_BYTES;
  if (remainder === 0) return buffer;
  const padded = Buffer.alloc(buffer.length + (EXOTEL_CHUNK_BYTES - remainder), 0x00);
  buffer.copy(padded, 0);
  return padded;
}

// ─── CALL HANDLER ─────────────────────────────────────────────────────────────
class CallHandler {
  constructor(callSid, callerPhone, ws, callSource = 'exotel', isReturning = false, returningName = null) {
    this.callSid = callSid;
    this.callerPhone = callerPhone;
    this.ws = ws;
    this.callSource = callSource;
    this.isReturning = isReturning;
    // Saved name for a known caller (null for new callers). When present,
    // Ritu greets by name and skips asking — no STT name capture needed.
    this.returningName = returningName;
    this.languageDetected = 'Hindi';
    this.doctorName = 'Doctor SID';
    this.bookingFailureReason = null;
    this.slotAttempts = 0;
    this.conversionTimeSec = null;
    this.durationSeconds = 0;
    this.emergencyDetected = false;

    this.patientName = null;
    // THIS CALLER'S PREVIOUSLY CONFIRMED MOLECULES — the strongest prior the
    // matcher can have, and it has never been wired up. db.js has exported
    // getPatientMedications() since migration 007 and nothing has ever called
    // it, which is the same failure that migration existed to fix one layer
    // down. Fetched once, off the hot path (see _loadPriorMeds), because a
    // database round trip must never sit inside a turn.
    this._priorMeds = [];
    // ─── STEP-1 INSTRUMENTATION: measure before optimising ──────────────────
    // Three quantities decide three proposed projects, and none of them had a
    // number. Recorded per call so a change can be scored against a baseline
    // taken by the identical instrument, not against a belief.
    //   · speech  — characters spoken. TTS is billed per character and is 54%
    //               of per-call cost, so this IS the cost lever.
    //   · tts     — cold dials vs sentences. If ~1 cold dial per call, socket
    //               reuse buys nothing and must not be built.
    //   · llm     — tokens per turn, and how many were cached. Absent stays
    //               distinguishable from zero: null means the provider said
    //               nothing, 0 means it said nothing was cached.
    this._speechChars = 0;
    this._speechReplies = 0;
    this._ttsSentences = 0;
    this._ttsColdDials = 0;
    this._llmTurns = 0;
    this._llmPromptTokens = 0;
    this._llmCompletionTokens = 0;
    this._llmCachedTokens = 0;
    this._llmUsageReportedTurns = 0;
    this._llmCachedReportedTurns = 0;
    this.reason = null;
    this.appointmentTime = null;
    this.appointmentBooked = false;
    this._historyStage = 0; // 0=none, 1=asked duration, 2=asked meds/allergy, 3=done/skipped (deterministic pre-visit history)
    this.eventId = null;
    this.appointmentId = null;     // booked appointment UUID → links the calls row (provenance)
    // The FIRST appointment booked in this call, kept even when a second is
    // made. Since migration 013 a same-doctor different-day BOOK is a new row,
    // so a call may hold two; the brain uses this to (a) tell the caller the
    // first one still stands and (b) aim a same-call UPDATE at the right row.
    this._bookedThisCall = null;
    this.transcript = [];
    this.conversationHistory = [];
    this.startTime = Date.now();
    // ── Latency instrumentation (per-turn dead-air timing; observational only) ──
    this._turnT = null;            // current turn's timing marks {eos,dispatch,replyReady,firstAudio}
    this._lastSpeechEndAt = null;  // when the patient last stopped speaking
    this._turnLatencies = [];      // eos→first-audio per turn → p50/p95 at call end
    // THE SPLIT, persisted rather than only logged. MEASURED 6 Aug from the
    // first six real calls: dead-air p50 ~1.3s and p95 ~2.0s, against a ~1.0-1.2s
    // target — but the telephony probe accounted for only 63ms of it, so the
    // remaining ~1.28s was unattributed and console.log lived on a Railway
    // instance nobody reads after the fact. Three arrays and a counter make the
    // next call answer "which stage" from the database.
    this._sttMs = [];             // eos → dispatch      (endpointing + debounce)
    this._llmMs = [];             // dispatch → reply     (LLM + tool calls)
    this._ttsMs = [];             // reply → first audio  (TTS first byte)
    this._toolMs = [];            // inside the turn: tool executions (book/move/find/callback)
    this._llmOnlyMs = [];         // dispatch → reply minus tool time
    // ROSTER SLICE, observed per call rather than assumed from a Railway flag.
    // ENABLE_ROSTER_SLICE was measured on 2026-08-07 as 11/12 vs 9/12 at
    // production scale, and turned on. Whether it FIRES on a given call depends
    // on more than the flag — sliceRoster returns the full roster when the
    // roster is <= 3, when no symptom has been stated yet, or when no doctor
    // matches the symptom. Without this record, "the slice is on" is a claim
    // about an environment variable, not about the call the patient just had.
    this._rosterSliceTurns = 0;   // turns where the slice actually narrowed the roster
    this._rosterBrainTurns = 0;   // turns that consulted the brain at all
    this._rosterSliceLast = null; // {specs, count, total} of the most recent slice
    this._fillerTurns = 0;        // turns where a filler masked the wait — the
                                  // split is meaningless there, and counting
                                  // them stops p50 reading better than reality
    // ── WHY THIS CALL ENDED ──────────────────────────────────────────────────
    // Set at every terminal path. Without it endCall() can only say "the system
    // ended it" or "the patient did", which collapses a happy goodbye, a silence
    // timeout and OUR OWN redeploy into two indistinguishable strings. See
    // callOutcome.js.
    this._endTrigger = null;
    // Utterances that arrived and were FILTERED (echo / ghost / garble). The
    // difference between "nobody spoke" and "we could not hear them" — same row
    // today, opposite fixes.
    this._droppedUtterances = 0;
    // Exceptions that killed a turn. Today a crash is indistinguishable from a
    // bored patient.
    this._criticalErrors = 0;
    // Why a booking attempt failed, when one was made at all.
    this._bookFailKind = null;
    // The telephony leg — the only part of a caller's wait we have never
    // measured. See telephonyProbe.js.
    this._telephony = new TelephonyProbe(callSid);
    this._fillerPlayedThisTurn = false; // gate: one thinking-filler per turn
    this.streamSid = null;
    this.isSpeaking = false;
    this.stt = null;
    this._ended = false;
    this._processingChain = Promise.resolve();
    this.shouldEndCall = false;
    this.conversationPhase = 'greeting';
    // True only while the opening cached greeting is still playing — transcripts
    // that arrive over it are dropped (see _onTranscript) so line noise can't
    // become the patient's name. Cleared on the greeting's ritu_done mark.
    this._greetingProtected = false;
    // TTS voice is locked per call. Marathi-FIRST: default voice (Ritu / Marathi)
    // until the patient DELIBERATELY speaks or asks for Hindi; then we switch to
    // the Hindi voice (Suhani) and STAY there — no per-sentence flipping. See
    // _currentSpeaker() + looksLikeHindi().
    this._hindiInCall = false;
    // Set by an EXPLICIT request ("हिंदी में बोलो", "मराठीत बोलू शकता?"). While
    // set, the per-turn text decision for the Devanagari pair stands down: the
    // caller said what they want, and their next mixed sentence must not undo it.
    this._langRequested = null;
    // The voice for THIS reply when the model answers in the other member of
    // the pair. Transient — it never touches _hindiInCall, because the model's
    // slip into Hindi is not evidence about the patient (it is how call
    // 82a3d38c locked itself to Hindi).
    this._replyVoiceLang = null;
    // Set once the reply-path symptom guard has re-asked in this call; the
    // second drift strips the clause instead of asking again.
    this._driftReasked = false;
    // Multilingual overlay (flag-gated): null → legacy hi/mr behavior above;
    // a language code ('kn-IN', 'pa-IN', …) once the auto-detect pin fires.
    // Single source for the call's language is _langCode(), never this field
    // directly. Pinned once per call (like the voice) — no oscillation.
    this.callLanguage = null;
    this._langPinned = false; // auto-detect pin decision made (multilingual only)
    this._weakLangCandidate = null; // last weak-evidence language tag, awaiting a second agreeing one
    this._patientTextAll = ''; // every patient utterance, call-lifetime — roster slice reads this, never the trimmed history
    this._silenceTimer = null;
    this._silenceHangupTimer = null;
    this._silencePromptIdx = 0; // rotates SILENCE_PROMPTS so the line varies
    this._awaitingSilenceHangup = false; // set after a silence PROMPT so its own onRituDone arms the hangup, not another prompt

    // Carries the sub-frame-sized remainder of Sarvam TTS chunks across
    // sends so we never inject 0x00 padding mid-waveform (that caused the
    // audible crackle/jitter in streamed audio).
    this._ttsTail = Buffer.alloc(0);

    // Echo detection: track the last thing Ritu said so we can discard
    // transcripts that are just the caller's phone echoing Ritu's audio.
    this._lastRituText = '';

    // Drop transcripts that arrive within ECHO_BLANKING_MS after Ritu's
    // playback finishes (mark roundtrip), to suppress residual echo.
    this._echoBlankingUntil = 0;

    // Generation counter — incremented on barge-in. processIntent() compares
    // its own generation to this value before speaking; mismatch means the
    // patient interrupted while the LLM was still thinking, so the response
    // should be discarded instead of spoken over the new turn.
    this._generationId = 0;

    // Transcript debouncing: coalesce rapid STT fragments into one LLM call.
    this._pendingTranscript = '';
    this._debounceTimer = null;

    // Speculative LLM (Phase B, flag-gated): the in-flight LeanSpeculation for
    // the pending transcript, or null. See the class doc above.
    this._speculation = null;
    // Speculative completion for NON-streamed turns (booking-likely +
    // post-booking) — the CompletionSpeculation for the pending transcript.
    this._completionSpec = null;
    // Wasted-call bound: a fragmenting utterance (several FINALs in one turn)
    // supersedes the spec on each fragment. Cap starts per turn so a fragment
    // storm can't multiply gemini volume unbounded. Shared by both spec kinds.
    this._specStartsThisTurn = 0;
    // SPECULATION, observed rather than assumed. config.speculativeLlm=true says
    // the feature is ENABLED; it does not say it fires, and it does not say the
    // result was USED. A speculation that starts and is then cancelled costs an
    // LLM call and saves nothing, which would look identical to "on and working"
    // from the outside. Dead air sat at ~1.1s across two calls with speculation
    // enabled the whole time, so which of those two it is decides whether the
    // LLM leg is even the right target.
    this._specStarted = 0;    // speculative generations launched
    this._specClaimed = 0;    // ...that the turn actually used
    this._specCancelled = 0;  // ...thrown away (stale, mismatched, superseded)
    // WHY they were thrown away. MEASURED on a real call 2026-08-07:
    // started=6 claimed=3 cancelled=2 — half the speculative LLM calls bought
    // nothing, and each discard is a paid generation. The total said HOW MANY
    // died; it could not say which of the five death paths did it, so there was
    // nothing to fix. This is the same gap the roster slice and languagePinned
    // had: a number that proves a problem exists and cannot locate it.
    this._specCancelReasons = Object.create(null);
    this._garbleSpokeThisCall = false;

    // RMS sampling counter (logging only, no gating yet).
    this._rmsCounter = 0;
    this._lastRms = 0;             // most-recent inbound-audio RMS (loudness)
    this._turnPeakRms = 0;         // peak RMS during the current speaking turn
    this._ghostDrops = 0;          // turns discarded for being too quiet
    this._ghostDropRms = [];       // ...and how loud each one actually was
    this._rmsFloor = [];           // background RMS, sampled when NOBODY is speaking
    this._rmsSpeech = [];          // per-turn peak RMS, one entry per finished turn
    this._lastTurnPeakRms = 0;     // peak RMS of the just-finished turn (for short-burst hold)

    // Active TTS streaming handle. On barge-in we call .abort() on this
    // to close the WebSocket and stop forwarding any further audio chunks
    // to Exotel. _clearAudio() alone only flushes Exotel's playback buffer
    // — it does not stop our pipeline from generating new audio.
    this._activeTTS = null;

    // Track when Ritu's last turn ended and whether it was a question.
    // Used by the ghost-transcript filter — short transcripts arriving
    // soon after a non-question turn are dropped as echo/VAD artifacts.
    this._lastRituTurnEndedAt = 0;
    this._lastRituTurnWasQuestion = false;

    // Deterministic emergency detector latch. Once an emergency is detected
    // and the cached message has started playing, ignore further transcripts
    // — we are committed to ending the call. Prevents a second detection
    // from re-firing handleEmergency() while the first response is still
    // streaming, and prevents normal LLM turns from continuing once the
    // emergency exit message has been queued.
    this._emergencyTriggered = false;
    this._garbleReprompts = 0; // capped count of "line unclear, please repeat" prompts
    // OncoReady pre-visit intake session (oncoreadyIntake.js), set by index.js
    // before start(). null on every clinic call — then nothing below changes.
    this.intake = null;
  }

  // ─── STT CALLBACKS ──────────────────────────────────────────────────────────

  _onSpeechStart() {
    console.log(`[CALL ${this.callSid}] Patient speaking...`);
    this._patientTalking = true; // hold-extend reads this at hold expiry
    this._turnPeakRms = 0; // fresh turn — start tracking this utterance's loudness
    // The caller is making sound NOW — kill any pending silence prompt. Measure
    // silence from "caller stopped", not "Ritu stopped": otherwise a turn whose
    // transcript gets filtered (echo-blank / backchannel / ghost — all early-return
    // BEFORE the debounce resets the timer) leaves the 8s countdown running and Ritu
    // prompts "मी ऐकते आहे, बोला" over a caller who DID answer (the dropped "हा हा").
    this._awaitingSilenceHangup = false; // caller is speaking — not awaiting a hangup
    this._clearSilenceTimers();
  }

  _onSpeechEnd() {
    // Log the PEAK loudness DURING the turn (not the instantaneous value at
    // end-of-speech, which is always silence). Correlating a high peak with calls
    // where the caller was cut off mid-sentence is how we CONFIRM the loud ->
    // early-cutoff theory before tuning Sarvam's VAD silence params.
    console.log(`[CALL ${this.callSid}] Patient finished speaking (turn-peak RMS ${Math.round(this._turnPeakRms)})`);
    this._patientTalking = false;
    // One entry per turn the caller actually finished — the speech side of the
    // SNR. Kept separate from _lastTurnPeakRms, which is consumed and reset.
    if (this._turnPeakRms > 0 && this._rmsSpeech.length < 200) this._rmsSpeech.push(this._turnPeakRms);
    this._lastTurnPeakRms = this._turnPeakRms; // stash for the debounce loudness gate (resets next)
    this._turnPeakRms = 0;
    this._lastSpeechEndAt = Date.now(); // start of the dead-air window we measure
    // Caller stopped — restart the silence countdown from HERE (their last sound),
    // so the prompt only fires after a real pause, never while/just-after they spoke.
    this._resetSilenceTimer();
    // Force STT to flush any buffered audio so the transcript arrives faster.
    if (this.stt && this.stt.flush) this.stt.flush();
  }

  // Called from the WS layer when the ritu_done mark roundtrips back
  // (audio has actually finished playing on the patient's phone). Starts
  // an echo-blanking window so residual phone-line echo doesn't get
  // transcribed and processed as a new turn.
  onRituDone() {
    this.isSpeaking = false;
    // Greeting has finished playing → the name question is fully out; start
    // accepting the patient's answer.
    this._greetingProtected = false;
    if (this._greetingProtectTimer) { clearTimeout(this._greetingProtectTimer); this._greetingProtectTimer = null; }
    this._echoBlankingUntil = Date.now() + ECHO_BLANKING_MS;
    this._lastRituTurnEndedAt = Date.now();
    // Question-mark heuristic: if Ritu's turn ends with a `?` she just
    // asked something, so a short patient reply is likely a real answer
    // and shouldn't be dropped. Otherwise (statement/confirmation) any
    // short transcript right after is more likely echo/noise.
    this._lastRituTurnWasQuestion = /\?\s*$/.test((this._lastRituText || '').trim());
    // If the audio that just finished was a SILENCE PROMPT, arm the hangup
    // countdown instead of restarting the prompt loop (the old unconditional
    // _resetSilenceTimer cleared the hangup timer → it never fired).
    if (this._awaitingSilenceHangup) {
      this._awaitingSilenceHangup = false;
      if (!this._ended && !this.shouldEndCall) this._armSilenceHangup();
      return;
    }
    this._resetSilenceTimer();
  }

  async _onTranscript(text, meta) {
    if (!text) return;
    const trimmed = text.trim();
    if (trimmed.length < TRANSCRIPT_MIN_CHARS) return;

    // ─── EMERGENCY LATCH ──────────────────────────────────────────────
    // Once handleEmergency() has fired, we're committed to playing the
    // cached message + ending the call. Drop everything else — including
    // an echo of the emergency message itself.
    if (this._emergencyTriggered) return;

    // ─── ECHO BLANKING WINDOW ─────────────────────────────────────────
    // For ECHO_BLANKING_MS after Ritu's audio finishes playing on the
    // patient's phone (mark roundtrip), drop transcripts. Catches the
    // residual echo that AEC didn't fully cancel.
    if (Date.now() < this._echoBlankingUntil) {
      // The window may only swallow ECHO — not a patient who starts talking
      // right as Ritu stops. Live drop 2026-07-17: "…में दर्द हो रहा है" (6
      // tokens, zero overlap with Ritu's line) was discarded here and the
      // patient had to repeat. Keep the drop ONLY when the transcript actually
      // looks like echo (word overlap with Ritu's last line) or is a 1-2-token
      // blip; longer no-overlap speech is real — let it through.
      const blankToks = trimmed.split(/\s+/).filter(Boolean);
      // 1-token blips or echo-overlap only — a 2-token demand like "हिंदी हिंदी"
      // is real speech (live drop 2026-07-20); the overlap check catches echo.
      if (blankToks.length <= 1 || this._isEcho(trimmed)) {
        this._droppedUtterances++;
        console.log(`[CALL ${this.callSid}] Echo blanking dropped: ${speech(trimmed)}`);
        return;
      }
      console.log(`[CALL ${this.callSid}] Echo blanking rescued real speech (${blankToks.length} tok, no overlap): ${speech(trimmed)}`);
    }

    // ─── RECORDING DISCLOSURE FILTER ──────────────────────────────────
    // The "this call is being recorded" announcement leaks into STT at call
    // start. Drop it so Ritu never treats it as patient speech (and never
    // captures a name/intent from it).
    if (isRecordingAnnouncement(trimmed)) {
      console.log(`[CALL ${this.callSid}] Recording-disclosure dropped: ${speech(trimmed)}`);
      return;
    }

    // ─── ECHO DETECTION (word overlap) ────────────────────────────────
    if (this.isSpeaking && this._lastRituText && this._isEcho(trimmed)) {
      this._droppedUtterances++;
        console.log(`[CALL ${this.callSid}] Echo detected (dropped): ${speech(trimmed)}`);
      return;
    }

    // ─── GHOST TRANSCRIPT FILTER ──────────────────────────────────────
    // Short transcripts arriving soon after Ritu finished a non-question
    // turn are almost always echo or VAD noise. Bypassed when the last
    // turn was a question (patient may be giving a short legitimate
    // answer like "kal subah" or "haan main").
    const sinceRituEnded = Date.now() - this._lastRituTurnEndedAt;
    if (
      this._lastRituTurnEndedAt > 0 &&
      sinceRituEnded < GHOST_TRANSCRIPT_WINDOW_MS &&
      !this._lastRituTurnWasQuestion &&
      !isBackchannel(trimmed)
    ) {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length <= GHOST_TRANSCRIPT_MAX_TOKENS) {
        // A patient QUESTION is never an echo of Ritu's non-question turn, and
        // multi-token speech with zero word-overlap is real. Live drop
        // 2026-07-17: "स्पेशलिटी क्या है?" was ghosted and the patient had to
        // ask again. Drop only 1-token blips or genuine echo-overlap.
        const isQuestion = /[?？]\s*$/.test(trimmed);
        if (tokens.length <= 1 || (!isQuestion && this._isEcho(trimmed))) {
          this._droppedUtterances++;
        console.log(`[CALL ${this.callSid}] Ghost transcript dropped (${tokens.length} tokens, ${sinceRituEnded}ms after non-question turn): ${speech(trimmed)}`);
          return;
        }
        console.log(`[CALL ${this.callSid}] Ghost filter rescued (${tokens.length} tok${isQuestion ? ', question' : ', no overlap'}): ${speech(trimmed)}`);
      }
    }

    // ─── SILENCE GHOST: a transcript with no audio behind it ───────────
    // Live 2026-07-26 (call 56d6db79): two turns came back as "Hello" with
    // turn-peak RMS of 215 and *13*. RMS 13 is the noise floor — nothing was
    // said. Both burned a turn: one triggered a 900ms soft-speaker hold, the
    // other a barge-in that cut Ritu off mid-sentence.
    // This is physical evidence, not a language judgement: a human voice on
    // this line cannot produce a word at that amplitude, so however confident
    // the transcript looks, there is no speech under it. Bounded deliberately —
    // only SHORT transcripts are dropped, because a long one at low amplitude
    // is a genuinely quiet caller (the soft-speaker hold exists for them) and
    // must never be discarded.
    if (this._lastTurnPeakRms > 0 && this._lastTurnPeakRms < GHOST_RMS_FLOOR &&
        trimmed.split(/\s+/).filter(Boolean).length <= GHOST_MAX_TOKENS) {
      // COUNTED, AND SEPARATELY. This branch returned without touching
      // _droppedUtterances, so the one filter most likely to eat a soft "हाँ"
      // left no trace in diagnostics at all. On 2026-08-13 a caller reported a
      // misbehaving call; its record read dropped=0 and I reasoned from that
      // that nothing had been discarded. It did not mean that — it only meant
      // nothing had been discarded by the four branches that bother to count.
      //
      // Its own counter, not the shared one: this drop is a LOUDNESS decision
      // and the others are content decisions (echo, backchannel, blank). Rolled
      // together they cannot answer "did we throw away a quiet answer?", which
      // is the entire question a noisy call asks. Peak RMS travels with it so
      // the threshold can be argued from the drops it actually made.
      this._ghostDrops = (this._ghostDrops || 0) + 1;
      (this._ghostDropRms = this._ghostDropRms || []).push(Math.round(this._lastTurnPeakRms));
      console.log(`[CALL ${this.callSid}] Silence ghost dropped (peak RMS ${Math.round(this._lastTurnPeakRms)} < ${GHOST_RMS_FLOOR}): ${speech(trimmed)}`);
      return;
    }

    // ─── BACKCHANNEL: acknowledgment, not interruption ────────────────
    if (this.isSpeaking && isBackchannel(trimmed)) {
      console.log(`[CALL ${this.callSid}] Backchannel ignored: ${speech(trimmed)}`);
      return;
    }

    // ─── DETERMINISTIC EMERGENCY DETECTION ─────────────────────────────
    // Runs BEFORE barge-in / debounce / LLM. If keywords match, skip
    // everything and play the cached emergency message. handleEmergency()
    // performs its own TTS cancellation + state cleanup; the latch above
    // prevents re-entry on subsequent transcripts.
    // What the detector sees is composed in ONE place — emergencyDetector.
    // composeEmergencyProbe (the text, its Devanagari transliteration, the
    // virama-less form, the romanized form, joined by ‖). WhatsApp, the tests
    // and the FP sweep call the same function; no caller composes its own.
    const emergency = detectEmergency(composeEmergencyProbe(trimmed));
    if (emergency) {
      // fire-and-forget; handleEmergency awaits internally but we don't
      // want to block _onTranscript on the audio playback.
      // Pass the STT-detected language of THIS utterance: the emergency check
      // runs before the language pin (line ~1050), so _langCode() would still
      // read the greeting language (e.g. mr-IN for a returning patient) even
      // though the patient just spoke Hindi. Answer 108 in the spoken language.
      const sttLang = meta && meta.languageCode;
      this.handleEmergency(emergency, sttLang).catch(err =>
        console.error(`[CALL ${this.callSid}] handleEmergency threw:`, err.message)
      );
      return;
    }

    // ─── EMERGENCY DETECTOR V2 (2026-07-21, S4 spec §2) ────────────────
    // Runs ONLY when v1 did not fire (v1 returned above — v1 stays
    // authoritative, no double path). Whole-utterance token-set matcher
    // covering v1's dead zones (snakebite, obstetric, stroke/self-harm in
    // all 11 languages, …). SHADOW by default: EMERGENCY_V2 unset/off →
    // log-only, prod behavior unchanged. EMERGENCY_V2=on → RED tier
    // escalates through the SAME handleEmergency path as v1; AMBER always
    // logs only. try/catch so v2 can never break the live call path.
    try {
      const v2 = detectEmergencyV2(trimmed, { lastRituText: this._lastRituText });
      if (v2) {
        if (V2_ENFORCES(v2.category) && v2.tier === 'RED') {
          console.log(`[EMERGENCY-V2] ENFORCE tier=${v2.tier} category=${v2.category} matched="${v2.matchedTerm}" lang=${v2.lang}`);
          // v1-shaped detection object; selfharm maps to v1's 'self_harm'
          // so handleEmergency routes it to the helpline text, not 108.
          const detection = {
            type: v2.category === 'selfharm' ? 'self_harm' : `v2_${v2.category}`,
            label: `v2:${v2.category}`,
            matched: v2.matchedTerm,
            pattern: 'emergencyDetectorV2'
          };
          const v2SttLang = meta && meta.languageCode;
          this.handleEmergency(detection, v2SttLang).catch(err =>
            console.error(`[CALL ${this.callSid}] handleEmergency (v2) threw:`, err.message)
          );
          return;
        }
        console.log(`[EMERGENCY-V2-SHADOW] tier=${v2.tier} category=${v2.category} matched="${v2.matchedTerm}" lang=${v2.lang}`);
      }
    } catch (err) {
      console.error(`[CALL ${this.callSid}] emergencyDetectorV2 threw (ignored, fail-open on v1):`, err.message);
    }

    // ─── OPENING-GREETING PROTECTION ──────────────────────────────────
    // The first cached greeting asks for the patient's name. If the patient
    // (or line noise) talks OVER it, that fragment used to barge in and become
    // the "name" — we saw a garbled "लिपर" lock in for a whole call and ride
    // into the booking. Let the greeting finish; the name is captured from the
    // clean turn that follows. Emergencies (checked above) still cut through.
    if (this._greetingProtected) {
      // Fragments and echo stay ignored (the original bug: garbage became the
      // caller's name). But a REAL sentence spoken over the greeting must be
      // heard — live 2026-07-20: an impatient caller's "आप हिंदी में बात तो बोल
      // सकते हैं" was eaten here, and it took them 4 attempts to get Hindi.
      const gpToks = trimmed.split(/\s+/).filter(Boolean);
      if (gpToks.length < 4 || this._isEcho(trimmed)) {
        console.log(`[CALL ${this.callSid}] Greeting-protected — ignoring over-greeting transcript: ${speech(trimmed)}`);
        return;
      }
      console.log(`[CALL ${this.callSid}] Greeting protection released early — real sentence over greeting (${gpToks.length} tok): ${speech(trimmed)}`);
      this._greetingProtected = false;
      if (this._greetingProtectTimer) clearTimeout(this._greetingProtectTimer);
    }

    // ─── BARGE-IN: patient interrupts while AI is speaking ────────────
    if (this.isSpeaking) {
      if (trimmed.length < BARGE_IN_MIN_CHARS) return;
      console.log(`[CALL ${this.callSid}] Barge-in detected: ${speech(trimmed)} — clearing audio`);
      this._clearAudio();
      // Close the in-flight TTS WebSocket so no more audio chunks get
      // generated and forwarded to Exotel after the clear event.
      if (this._activeTTS && typeof this._activeTTS.abort === 'function') {
        this._activeTTS.abort();
        console.log(`[CALL ${this.callSid}] Aborted in-flight TTS stream`);
      }
      this.isSpeaking = false;
      // Invalidate any in-flight LLM call — its response is now stale.
      this._generationId++;
    }

    this._clearSilenceTimers();

    // ─── GARBLE GUARD: line too degraded to trust → ask to repeat ─────
    // In healthcare a confident WRONG capture is worse than "sorry, didn't catch
    // that". If the transcript shows a severe garble signature (repetition loops,
    // near-empty-for-long-audio, or collapsed Sarvam confidence), re-prompt instead
    // of processing noise. Deterministic, fail-OPEN (any error → process normally),
    // and capped at GARBLE_MAX_REPROMPTS so a persistently-bad line still advances.
    // Runs AFTER emergency/greeting/backchannel/barge-in and BEFORE the transcript
    // is recorded, so garbled text never pollutes the LLM context or the summary.
    if (GARBLE_GUARD_ENABLED && this._garbleReprompts < GARBLE_MAX_REPROMPTS) {
      try {
        const g = detectGarble(trimmed, {
          languageProbability: meta && meta.languageProbability,
          audioDuration: meta && meta.audioDuration,
        });
        if (g.garbled) {
          // Repair ladder (S2 T7): re-ask for the SPECIFIC slot the line ate,
          // and count per-slot so a 2nd name-garble escalates to spell-out.
          const slot = this._currentSlot();
          const slotAttempt = (this._garbleBySlot && slot === this._garbleBySlot.slot)
            ? this._garbleBySlot.n : 0;
          this._garbleBySlot = { slot, n: slotAttempt + 1 };
          this._garbleReprompts++;
          const prompt = slotRepeatPrompt(slot, this._langCode(), slotAttempt);
          this._droppedUtterances++;
          console.log(`[CALL ${this.callSid}] Garble guard fired (${g.reasons.join(',')}) [${this._garbleReprompts}/${GARBLE_MAX_REPROMPTS}] slot=${slot || 'generic'} attempt=${slotAttempt} — targeted re-ask: ${speech(trimmed)}`);
          this._pendingTranscript = '';
          // THE MODEL MUST KNOW SHE SAID THIS. Observed 2026-08-06 12:24: the
          // guard spoke "माफ करा, आवाज नीट ऐकू येत नाहीये" (sorry, I cannot
          // hear you), the patient answered "Hello, मेरी आवाज़ आ रही है?" (can
          // you hear me?), and the model — with no record that anything had
          // been said — replied "जी, आपकी आवाज़ बिल्कुल साफ़ आ रही है" (your
          // voice is perfectly clear). The caller hung up two turns later.
          //
          // The guard used to speak(prompt) and return, so its utterance never
          // reached conversationHistory. Every deterministic line the product
          // says has to land in the record the model reads next, or the model
          // will contradict it — not from confusion, but because as far as it
          // knows the line never happened.
          this._garbleSpokeThisCall = true;
          await this._sayDeterministic(prompt);
          return;
        }
      } catch (_) { /* fail-open: never let the guard break a normal turn */ }
    }

    console.log(`[CALL ${this.callSid}] Patient said: ${speech(trimmed)}`);
    this.transcript.push({ role: 'patient', text: trimmed, time: new Date().toISOString() });

    // ─── THE NAME IN THE CALLER'S OWN WORDS ───────────────────────────────
    // MEASURED over 150 production transcripts, 2026-08-15: on 9 calls the
    // caller said "मेरा नाम X है" / "ನನ್ನ ಹೆಸರು X" plainly, the STT transcribed
    // it correctly, and patients.name still ended up "Unknown" or "your name".
    // The sentinel does not copy the name out of the transcript, it regenerates
    // it — and one Kannada caller's ಪೃಥ್ವಿ came back written in BENGALI.
    //
    // FILL ONLY, NEVER OVERRIDE, and that restriction is measured too. On the 7
    // calls where a valid name was already recorded and the phrase disagreed,
    // overriding would have been wrong or pointless every time: 4 were the same
    // name in a different script (अतुल/Atul, আদিত্য ঝা/Aditya Jha) and one was a
    // garbled transcript the model had already corrected (सित्थात → सिद्धार्थ).
    // So this only ever speaks when we would otherwise have had nothing.
    // ─── "MY NAME IS NOT X" MUST BE ABLE TO UNDO X ────────────────────────
    // GROUND TRUTH, call e370519a, 2026-08-15 — the first call in this repo's
    // history with audio to check the transcript against. All three systems
    // agreed the caller said "ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ" and then "ಚಂದ್ರಶೇಖರ್".
    // Sarvam heard it PERFECTLY. Ritu apologised and used the right name out
    // loud for the rest of the call — and the appointment is still filed under
    // ರಾಜಮ್ಮ, because patientName was already set and fill-only never releases.
    //
    // So the loss was entirely ours, on a turn where the STT was flawless. That
    // is the first measured split between vendor error and our error, and it
    // came out 0 / 1.
    //
    // Clearing rather than overwriting: the denial tells us the stored name is
    // wrong, not what the right one is. The next name offered — by this
    // extractor or by the LLM sentinel — then lands normally.
    if (this.patientName && deniesName(trimmed)) {
      console.log(`[CALL ${this.callSid}] 🪪 Caller denied the name on record — cleared, awaiting the correction`);
      this.patientName = null;
    }
    if (!this.patientName) {
      const spoken = extractNameFromSpeech(trimmed);
      if (spoken) {
        this.patientName = spoken;
        console.log(`[CALL ${this.callSid}] 🪪 Name taken from the caller's own words: ${speech(spoken)}`);
      }
    }

    // ─── MULTILINGUAL AUTO-DETECT PIN (flag-gated) ────────────────────
    // The call opened with language-code=unknown; this transcript's meta
    // carries Sarvam's own detection. Pin ONCE on the first substantive,
    // filter-surviving utterance (all echo/ghost/backchannel filters above
    // have already passed): a supported new language sets callLanguage and
    // re-pins the STT session to it; hi/mr re-pin to the legacy hi-IN session
    // (the battle-tested machinery below takes over); STT-only languages pin
    // hi-IN and Ritu replies in Hindi.
    // Explicit "speak X" request beats the auto-detect pin — switch the call's
    // language, repin the STT, and the pinned-language prompt rule makes the
    // very next reply come back IN X (in X's voice). Checked BEFORE the pin so
    // a first-utterance request doesn't dial an auto-detect socket only to
    // abandon it a millisecond later (live call 2026-07-08: orphan-socket
    // "closed before the connection was established" noise).
    if (ENABLE_MULTILINGUAL) {
      const requested = this._detectLanguageRequest(trimmed);
      if (requested && requested !== this._langCode()) {
        this._applyLanguageSwitch(requested, 'patient request');
      }
    }

    if (ENABLE_MULTILINGUAL && !this._langPinned && meta && meta.languageCode) {
      this._maybePinLanguage(meta.languageCode, trimmed, meta);
      // WEAK-DEFERRED EXOTIC TAG: the pin was deferred on weak evidence AND the
      // tag isn't a language this call plausibly speaks (greeting language, the
      // legacy pair, or English). The transcript's script can't be trusted, and
      // the LLM mirrors whatever script it sees — live 2026-07-20: garbled
      // Hindi tagged ml-IN made Ritu answer a Hindi speaker in MALAYALAM. Ask
      // to repeat in the call's current language instead (same philosophy as
      // the garble guard). A genuine speaker of that language still pins on
      // their repeat (two weak agreements) — this only costs them one turn.
      const expectedLangs = new Set(['hi-IN', 'mr-IN', 'en-IN', GREETING_LANG, this.callLanguage].filter(Boolean));
      if (!this._langPinned && this._weakLangCandidate && !expectedLangs.has(this._weakLangCandidate)) {
        this._weakLangRepeats = (this._weakLangRepeats || 0) + 1;
        if (this._weakLangRepeats <= 2) {
          console.log(`[CALL ${this.callSid}] 🌐 Weak ${this._weakLangCandidate} fragment held — asking to repeat instead of replying in an unconfirmed language`);
          await this._sayDeterministic(repeatPrompt(this._langCode()));
          return;
        }
        // Third strike: stop gatekeeping, let the turn through (never trap the caller).
      }
    }

    // THE DEVANAGARI PAIR FOLLOWS THE PATIENT'S TEXT, EVERY TURN, BOTH WAYS.
    // This used to flip TO Hindi on a clean Hindi utterance and never back —
    // "so the voice doesn't oscillate on a code-mixed caller". The cost of
    // one-way was call 82a3d38c: pinned to Hindi off two 3-token fragments,
    // then eighteen Marathi turns nothing was allowed to listen to. Oscillation
    // is prevented by the classifier, not by the ratchet: looksLikeHindi vetoes
    // on any Marathi marker, and the flip back needs a Marathi-marked sentence
    // of three or more tokens. See sarvam.js pairLanguage.
    // ─── DEBOUNCE: coalesce rapid STT fragments into one LLM turn ─────
    this._pendingTranscript = this._pendingTranscript
      ? `${this._pendingTranscript} ${trimmed}`
      : trimmed;
    // The pair decision reads the TURN so far — every fragment coalesced — not
    // the fragment alone. "मुझे" then "बुखार है" is one Hindi sentence; each
    // fragment by itself is nothing, and the Hindi side used to flip on the
    // first strong token with no floor (see sarvam.js pairLanguage).
    this._updatePairLanguage(this._pendingTranscript);

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    // Hold longer when the utterance looks unfinished (don't cut the caller off).
    let debounceWait = looksIncomplete(this._pendingTranscript) ? ENDPOINT_HOLD_MS : TRANSCRIPT_DEBOUNCE_MS;
    // A complete short confirmation ("हां जी" / "ठीक है" / "बुक करो" / "ना") is terminal
    // — skip the loud-short and soft-speaker holds so it dispatches on the fast path
    // instead of paying a needless 900ms. Non-terminal quiet/short turns still get held.
    const terminalShort = ENABLE_TERMINAL_FASTPATH && isTerminalConfirmation(this._pendingTranscript);
    // Short-burst hold (flag-gated): a very short, non-backchannel turn that was
    // LOUD is the cutoff signature — a mid-sentence pause ("मेरा पेट" → "दर्द हो
    // रहा है"), even right after a question. Hold for the continuation instead of
    // dispatching + then barging in on it. The loudness gate keeps a normal-volume
    // short answer ("कल") snappy — only loud short bursts pay the extra hold.
    if (ENABLE_SHORT_HOLD && !terminalShort && debounceWait === TRANSCRIPT_DEBOUNCE_MS &&
        this._lastTurnPeakRms >= SHORT_HOLD_MIN_PEAK) {
      const words = this._pendingTranscript.split(/\s+/).filter(Boolean).length;
      if (words <= SHORT_HOLD_MAX_WORDS && !isBackchannel(this._pendingTranscript)) {
        debounceWait = SHORT_HOLD_MS;
        console.log(`[CALL ${this.callSid}] Short-burst hold (${SHORT_HOLD_MS}ms) — loud short turn (peak ${Math.round(this._lastTurnPeakRms)}): ${speech(this._pendingTranscript)}`);
      }
    }
    // Soft-speaker hold (default on): a QUIET turn (low peak RMS) was likely endpointed
    // mid-sentence by Sarvam's VAD — hold for the continuation so Ritu doesn't cut a
    // soft-spoken caller off. Runs AFTER short-hold, gated on `=== 300` so it can't
    // override the loud-short (900) or incomplete-tail (1100) holds. Skips backchannels.
    if (ENABLE_SOFT_HOLD && !terminalShort && debounceWait === TRANSCRIPT_DEBOUNCE_MS &&
        this._lastTurnPeakRms > 0 && this._lastTurnPeakRms < SOFT_HOLD_MAX_PEAK &&
        !isBackchannel(this._pendingTranscript)) {
      debounceWait = SOFT_HOLD_MS;
      console.log(`[CALL ${this.callSid}] Soft-speaker hold (${SOFT_HOLD_MS}ms) — quiet turn (peak ${Math.round(this._lastTurnPeakRms)}): ${speech(this._pendingTranscript)}`);
    }
    // Fast endpoint (flag-gated): when Sarvam already endpointed this turn
    // (END_SPEECH within POST_ENDSPEECH_WINDOW_MS) and it doesn't look unfinished,
    // trim the redundant 300ms coalesce wait. Runs AFTER short-hold and is gated on
    // `=== TRANSCRIPT_DEBOUNCE_MS`, so a loud short burst (900ms) and the
    // incomplete-tail hold (1100ms) both still win. A stale _lastSpeechEndAt
    // (mid-speech partial, seconds old) fails the window → keeps the full 300ms.
    if (ENABLE_FAST_ENDPOINT && debounceWait === TRANSCRIPT_DEBOUNCE_MS && this._lastSpeechEndAt) {
      const sinceEnd = Date.now() - this._lastSpeechEndAt;
      if (sinceEnd < POST_ENDSPEECH_WINDOW_MS) {
        debounceWait = POST_ENDSPEECH_DEBOUNCE_MS;
        console.log(`[CALL ${this.callSid}] Fast endpoint (${POST_ENDSPEECH_DEBOUNCE_MS}ms, +${sinceEnd}ms after END_SPEECH): ${speech(this._pendingTranscript)}`);
      }
    }
    if (debounceWait > TRANSCRIPT_DEBOUNCE_MS) {
      console.log(`[CALL ${this.callSid}] Endpoint hold (${debounceWait}ms) — utterance looks unfinished: ${speech(this._pendingTranscript)}`);
    }
    const fireTurn = () => {
      // HOLD-EXTEND (live 2026-07-24 call 2a962ec6): the 900ms hold expired
      // while the caller was STILL SPEAKING the continuation ("since last" ⏸
      // "…ten to twelve hours") — the half-sentence dispatched, the stage
      // machine asked the NEXT question over the caller's real answer, and
      // every turn after was misaligned (the duration answer landed as a
      // "meds answer" and triggered a false med re-ask). If VAD says the
      // caller is mid-utterance right now, wait a little longer — the
      // continuation transcript will arrive and re-run the debounce.
      if (this._patientTalking && (this._holdExtCount || 0) < HOLD_EXTEND_MAX) {
        this._holdExtCount = (this._holdExtCount || 0) + 1;
        console.log(`[CALL ${this.callSid}] Hold extended (${this._holdExtCount}/${HOLD_EXTEND_MAX}) — caller still speaking at hold expiry`);
        // dispatchTurn, not fireTurn — the retry must go back through the
        // speculation reaper below, or an extended hold that then answers
        // deterministically leaks exactly what the reaper exists to catch.
        this._debounceTimer = setTimeout(dispatchTurn, HOLD_EXTEND_MS);
        return;
      }
      this._holdExtCount = 0;
      const combined = this._pendingTranscript;
      this._pendingTranscript = '';
      this._debounceTimer = null;

      // Begin per-turn latency tracking: eos = patient stopped, dispatch = now
      // (debounce fired → this turn starts processing).
      this._turnT = { eos: this._lastSpeechEndAt || Date.now(), dispatch: Date.now(), replyReady: null, firstAudio: null };
      this._fillerPlayedThisTurn = false; // fresh turn → one filler allowed
      this._specStartsThisTurn = 0;       // fresh turn → fresh speculation budget

      // TTS pre-connect for THIS turn's reply (flag-gated; no-op when the
      // speculation path already opened a fresh matching socket). Covers the
      // non-speculated turns too — booking confirms spend ~1s in the LLM while
      // this socket completes its handshake.
      prewarmTTS({ speaker: this._currentSpeaker(), languageCode: this._langCode() });

      this._patientTextAll += ' ' + combined; // monotone union source for the roster slice
      this.conversationHistory.push({ role: 'user', content: combined });

      // Remember the caller's most recent SPOKEN time phrase. If a booking
      // commits later this turn (or a turn or two on), this is the surface half
      // of a datetime gold pair — see _recordDatetimeGold. Pure bookkeeping:
      // never affects what Ritu says or how fast she says it.
      try {
        const te = extractTimeExpression(combined);
        if (te) this._lastTimeExpr = { expression: te.expression, atMs: Date.now() - this.startTime };
      } catch (_) { /* never break a turn for instrumentation */ }

      // ─── DETERMINISTIC SENSITIVE-DATA GUARD ─────────────────────────────
      // Intercept fabrication/leak-bait questions ("how many records do you
      // have", "give me someone else's data", "what's my name in your records")
      // BEFORE the LLM, so it can never invent an answer. Legitimate self-service
      // ("mera appointment kab hai / cancel karna hai") is NOT caught — it flows
      // to the LLM + phone-scoped tools below.
      const probe = detectSensitiveProbe(combined + ' ' + toDevanagari(combined), this._langCode());
      if (probe) {
        console.log(`[CALL ${this.callSid}] Sensitive-data guard (${probe.type}) — deterministic refusal, LLM skipped`);
        // speak() pushes the 'ritu' transcript line itself; here we only add the
        // assistant turn to conversationHistory (we skip processIntent, which
        // normally does that), so the next LLM turn has the full context.
        this._processingChain = this._processingChain
          .then(() => this._sayDeterministic(probe.response))
          .catch((err) => this.handleCriticalError(err));
        return;
      }

      // ─── DETERMINISTIC MEDICAL-ADVICE GUARD ─────────────────────────────
      // A receptionist must never give a drug / dose / diagnosis. Intercept the
      // ADVICE-SEEKING question ("which medicine / what dose / is this cancer /
      // should I stop my meds", jailbreaks) BEFORE the LLM and deflect to the
      // doctor + a booking offer. Symptom statements ("mujhe bukhar hai") and
      // stating a current medicine are NOT caught — they flow to the booking.
      const advice = detectMedicalAdvice(combined + ' ' + toDevanagari(combined), this._langCode());
      // Stand down for ONE turn when Ritu's own previous line was the meds
      // question — a reply to "कोई दवाई चल रही है?" is an answer or a pushback,
      // never a prescription request. Live 2026-08-08: "अरे कौन सी दवाई भाई…"
      // (exasperation) was answered with a liability disclaimer. Only
      // which_medicine*/dose* are suppressible; jailbreak, change_meds* and
      // diagnosis* always deflect. See medicalAdviceGuard.adviceGuardSuppressed.
      if (advice && adviceGuardSuppressed(advice, { historyStage: this._historyStage })) {
        console.log(`[CALL ${this.callSid}] Medical-advice guard (${advice.type}) — SUPPRESSED, this is a reply to our own meds question`);
      } else if (advice) {
        console.log(`[CALL ${this.callSid}] Medical-advice guard (${advice.type}) — deterministic deflection, LLM skipped`);
        this._processingChain = this._processingChain
          .then(() => this._sayDeterministic(advice.response))
          .catch((err) => this.handleCriticalError(err));
        return;
      }

      // ─── DETERMINISTIC PRE-VISIT HISTORY ────────────────────────────────
      // Guarantee the "कब से? / कोई दवाई-एलर्जी?" questions get asked after a
      // real symptom (the fast model skips them), before the model offers a
      // doctor. Canned → no LLM this turn. Skipped for booking/inquiry/rush.
      const histQ = this.intake ? null : this._maybeHistoryQuestion(combined);
      if (histQ) {
        console.log(`[CALL ${this.callSid}] Pre-visit history (stage ${this._historyStage}) — deterministic, LLM skipped`);
        this._processingChain = this._processingChain
          .then(() => this._sayDeterministic(histQ))
          .catch((err) => this.handleCriticalError(err));
        return;
      }

      // ─── ASK FOR OLD REPORTS, ONCE, AFTER THE BOOKING IS COMMITTED ──────
      // Sits at the SAME single call site as the history questions and works
      // the same way: canned, no LLM this turn, pushed to conversationHistory
      // before it is spoken so the next generation knows it was said. Three
      // separate booking paths set appointmentBooked (2616 / 2879 / 2979) —
      // hooking all three would be a seventh copy of one rule, so this reads
      // the flag they all end up setting instead.
      const repQ = this.intake ? null : this._maybeReportAsk();
      if (repQ) {
        console.log(`[CALL ${this.callSid}] 📄 Report intake ask — deterministic, LLM skipped`);
        this._processingChain = this._processingChain
          .then(() => this._sayDeterministic(repQ))
          .catch((err) => this.handleCriticalError(err));
        return;
      }

      // The ONLY exit that hands the turn to the model, and so the only one
      // that can claim the speculation started for it. Everything above
      // answered deterministically.
      this._turnRoutedToModel = true;
      this._processingChain = this._processingChain
        .then(() => this.processIntent(combined))
        .catch((err) => this.handleCriticalError(err));
    };

    // ─── REAP THE SPECULATION A DETERMINISTIC TURN JUST ORPHANED ──────────
    // MEASURED on call 3312d865, 2026-08-07: spec=3 started, 1 claimed, 2
    // cancelled — and both cancellations read "superseded by new transcript"
    // after 7363ms and 8520ms. That reason blamed the patient for speaking
    // again. The real story is in the timing: the speculation was already
    // pointless ~130ms in, when the deterministic pre-visit-history branch
    // answered the turn and returned. Nothing cancelled it, because only
    // processIntent claims or cancels and that path never reaches it. So a
    // full Gemini call (~3900 input tokens) ran to completion, was discarded,
    // and sat in _speculation until the NEXT turn swept it up seconds later.
    //
    // fireTurn has THREE deterministic exits today — sensitive-data guard,
    // medical-advice guard, pre-visit history — and every one leaks. Fixing
    // them one at a time guarantees the fourth one added leaks too, so the
    // reap lives at the single point every exit passes through.
    //
    // Two guards keep it from cancelling something it shouldn't: the turn must
    // not have routed to the model, and the in-flight speculation must be the
    // one started for THIS transcript (a newer turn's spec belongs to that
    // turn — the same rule _takeSpeculation follows). A held-open debounce
    // timer means hold-extend rescheduled, and that speculation is still live.
    const dispatchTurn = () => {
      const t = this._pendingTranscript; // fireTurn clears it; read first
      this._turnRoutedToModel = false;
      fireTurn();
      if (this._turnRoutedToModel || this._debounceTimer) return;
      if (this._speculation && this._speculation.transcript === t) {
        this._cancelSpeculation('turn answered deterministically');
      }
      if (this._completionSpec && this._completionSpec.transcript === t) {
        this._cancelCompletionSpec('turn answered deterministically');
      }
    };
    this._debounceTimer = setTimeout(dispatchTurn, debounceWait);

    // ─── SPECULATIVE LLM (flag-gated): start the gemini call NOW, during the
    // hold we just scheduled. Buffered + side-effect-free; committed only if
    // this exact transcript dispatches, cancelled if the patient keeps talking.
    this._maybeStartSpeculation(debounceWait);
  }

  // The locked TTS voice for this call: Marathi voice (Ritu) by default, Hindi
  // voice (Suhani) once the patient switched to Hindi. Sticky — never flips back.
  // The call's language code — single source of truth for voice, prompts,
  // silence/emergency strings and the sensitive-probe language. Multilingual
  // pin (callLanguage) wins; else the legacy Marathi-first/Hindi-switch pair.
  _langCode() {
    // Pre-pin default = the GREETING language (mr-IN on the default deploy —
    // byte-identical to the old hardcoded 'mr-IN'). On a GREETING_LANG=kn-IN
    // deploy this keeps silence prompts, fillers, fallback lines, and the
    // personalized greeting consistent with the Kannada opening — live
    // 2026-07-20: a Marathi "हं, मी ऐकते आहे" prompt followed a Kannada greeting.
    return this.callLanguage || (this._hindiInCall ? 'hi-IN' : GREETING_LANG);
  }

  // Which slot is Ritu currently collecting? Drives the garble repair ladder's
  // targeted re-ask (S2 T7). Derived from the conversation phase + what's still
  // missing — returns null for phases with no single slot (generic re-ask).
  _currentSlot() {
    // REASON BEFORE NAME, matching the greeting. The greeting used to end with
    // "आपका नाम?" so a garbled opener was re-asked as a name; it now asks the
    // symptom, and re-asking for the wrong slot is worse than a generic re-ask —
    // the caller hears a question they were never asked.
    if ((this.conversationPhase === 'greeting' || this.conversationPhase === 'reason') && !this.reason) return 'reason';
    if (this.conversationPhase === 'greeting' && !this.patientName) return 'name';
    if (this.conversationPhase === 'scheduling') return 'scheduling';
    return null;
  }

  // EXPLICIT language request — "कन्नड़ में बात करो" / "speak Tamil please".
  // The auto-detect pin can't catch this case: the REQUEST itself is spoken in
  // Hindi, so detection correctly hears hi-IN (live call 2026-07-08: Ritu then
  // falsely said "मुझे कन्नड़ नहीं आती"). A clean request OVERRIDES any earlier
  // pin. Requires a language NAME + a speak-verb, and skips negated sentences
  // ("मुझे कन्नड़ नहीं आती" from the patient must not trigger a switch).
  //
  // Cross-script: once a call is pinned (say kn-IN) the STT writes EVERYTHING
  // in that script — a Hindi "पंजाबी में बात कर" arrives as "ಪಂಜಾಬಿ ಮೇ ಬಾತ್ ಕರ್"
  // (live call 2026-07-08, missed). Indic blocks share one Unicode layout, so a
  // codepoint-offset shift to Devanagari lets the same patterns match all nine
  // scripts; patterns are vowel-tolerant because the shift is approximate.
  _detectLanguageRequest(text) {
    if (!text) return null;
    const t = text + ' ' + toDevanagari(text);
    // Verb gate. Includes the POLITE / ability forms — "बोलू शकता?" (can you
    // speak?) is how Marathi asks, and on call 82a3d38c it was the one form the
    // gate did not accept: the caller asked the politest way possible and was
    // answered "जी बिल्कुल!" in Hindi. A caller who barked "मराठीत बोला" would
    // have been served.
    // वात = live STT garble of बात through a kn-pinned session
    // (safe: "पेट में वात है" carries no language name). ਗੱਲ/माताड/मातनाड =
    // native Punjabi/Kannada speak-verbs (raw + transliterated forms).
    if (!/(में|मे|मे़|मध्ये|mein|\bme\b)\s*(बात|बोल|सेवा|वात|baat|bol)|बोलो|बोलिए|बोला|बोलाल|बोलू\s*शक|बोलता\s*येईल|बोलशील|बोलणार|बोल\s*सकत|बोल\s*सकोगे|બોલી\s*શક|બોલશો|ಮಾತಾಡ್ತೀರಾ|ಮಾತನಾಡಬಹುದಾ|பேச\s*முடியுமா|మాట్లాడగలరా|বলতে\s*পার|ਬੋਲ\s*ਸਕਦ|സംസാരിക്കാമോ|କହିପାରିବେ|ਗੱਲ|गॱल|माताड|मातनाड|पेचु|माट्लाड|माटलाड|बलुन|संसारि|कुहन्तु|कहन्तु|पऱय|speak|talk|\bbol/i.test(t)) return null;
    const NAMES = {
      'kn-IN': /कन्न[डट]|kannad/i,
      'pa-IN': /पंजाब|पञ्जाब|पञ्चाप|punjabi/i,
      'ta-IN': /तमि[लळऴ]|tamil/i,
      'te-IN': /तेलुग|तेलगु|telugu/i,
      'bn-IN': /बंगाल|बांग्ला|बांला|बाङ्ला|बङ्गाल|bengali|bangla/i,
      'gu-IN': /गुजरात|गुज्रात|gujarati/i,
      'ml-IN': /मलया[लळ]|मल्या[लळ]|malayalam/i,
      'od-IN': /उड़िया|ओड़िया|उडिया|ओडिया|ओड़िआ|odia|oriya/i,
      'en-IN': /अंग्रेज|अङ्ग्रेज|इंग्लिश|इङ्ग्लिश|इंग्रजी|english/i,
      // Full word only — bare हिंद also matches ಹಿಂದೆ ("earlier") after
      // transliteration, and "ನಾವು ಹಿಂದೆ ಮಾತಾಡಿದ್ವಿ" (we talked earlier)
      // would yank a Kannada call to Hindi.
      'hi-IN': /हिंदी|हिन्दी|हिंदि|हिन्दि|हिन्ति|hindi/i,
      'mr-IN': /मराठ|marathi/i,
    };
    // Negation is CLAUSE-LOCAL, not a blanket bail. Scan the raw text and its
    // transliteration SEPARATELY (concatenating them drags a negation across a
    // clause boundary into the wrong language), then merge: a language whose
    // clause carries a negation is EXCLUDED; a clean clause REQUESTS its language.
    // "हिंदी नहीं, तमिल में बोलो" and "I don't want Hindi, speak Tamil" → Tamil.
    const NEG = /नहीं|नही|नको|नाही|बेड|वेण्डा|वद्दु|वेण्ड|मत|(?<![\u0900-\u097F])ना(?![\u0900-\u097F])|\bnot\b|can'?t|can\s?not|don'?t|doesn'?t|won'?t|\bno\b|nahi\b/i;
    const SPLIT = /[,;।\n]|\bbut\b|\blekin\b|\bmagar\b|मगर|परन्तु|परंतु|किन्तु|किंतु/i;
    const scan = (str) => {
      let req = null; const exc = new Set();
      for (const clause of String(str).split(SPLIT)) {
        const neg = NEG.test(clause);
        for (const [code, re] of Object.entries(NAMES)) {
          if (re.test(clause)) { if (neg) exc.add(code); else req = code; }
        }
      }
      return { req, exc };
    };
    const a = scan(text), b = scan(toDevanagari(text));
    const excluded = new Set([...a.exc, ...b.exc]);
    let requested = null;
    for (const r of [a.req, b.req]) if (r && !excluded.has(r)) requested = r;
    return requested;
  }

  // The model's reply is the language AUTHORITY: if it comes back in a
  // different supported script than the call's current language, sync the call
  // state to it (callLanguage + STT repin + voice) so the NEXT patient turn is
  // transcribed in the language Ritu is now speaking. This is the catch-all
  // behind _detectLanguageRequest — live call 2026-07-08: STT garbled "बात" to
  // "ವಾತ್", the transcript detector missed, but the LLM (told "khushi se haan
  // bol") switched to Punjabi anyway; the kn-pinned STT then transcribed the
  // patient's Punjabi into mush and the reply language ping-ponged kn↔pa for
  // the rest of the call. Syncing to the reply closes the loop no matter WHY
  // the model switched. Called only on LLM replies — canned lines (greeting,
  // emergency, silence prompts) must never re-pin the call.
  _syncLanguageToReply(replyText) {
    if (!ENABLE_MULTILINGUAL || !replyText) return;
    const detected = detectLanguageCode(replyText);
    // Latin-only replies are too ambiguous to act on (names, "OK", numbers).
    if (!detected || detected === 'en-IN') return;
    if (detected === this._langCode()) return;
    // Dominance gate: switch only when the reply is CLEARLY in the detected
    // script — detectLanguageCode has no threshold (one stray "जी बिल्कुल!" in
    // an otherwise-English reply detects hi-IN and would evict the pin).
    const scriptRe = SCRIPT_CHARS[detected];
    const inScript = scriptRe ? (replyText.match(scriptRe) || []).length : 0;
    const letters = (replyText.match(/[A-Za-zऀ-ൿ]/g) || []).length;
    if (inScript < 6 || inScript * 2 < letters) return;
    if (detected === 'hi-IN' || detected === 'mr-IN') {
      // Devanagari reply. On an unpinned call the legacy hi/mr machinery
      // (looksLikeHindi) already owns this — don't interfere. On a PINNED
      // call it means the model left the pinned language → return to legacy.
      if (!this.callLanguage) return;
      this._applyLanguageSwitch(looksLikeHindi(replyText) ? 'hi-IN' : 'mr-IN', 'reply sync');
      return;
    }
    if (!config.languageNames[detected]) return;
    // The pair is decided from the PATIENT's text; the model answering in
    // Hindi to a Marathi caller is the failure, not the evidence.
    if (detected === 'hi-IN' || detected === 'mr-IN') return;
    this._applyLanguageSwitch(detected, 'reply sync');
  }

  _applyLanguageSwitch(code, why) {
    // A late LLM completion can land after hangup: endCall() nulls this.stt
    // without bumping _generationId, so the post-await guards pass and
    // stt.repin would throw on null → false CRITICAL alert.
    if (this._ended || !this.stt) return;
    // Forced-language deployments never switch mid-call (demo lock).
    if (FORCE_LANG) return;
    this._langPinned = true;
    if (why === 'patient request') this._langRequested = code;
    if (code === 'hi-IN' || code === 'mr-IN') {
      // Back to the legacy pair: the hi-IN session serves both languages.
      // WHICH of the two the caller is speaking is decided from their TEXT on
      // every turn (_updatePairLanguage) — never from Sarvam's tag, which is
      // wrong on most short fragments and was what pinned call 82a3d38c to
      // Hindi, and never from the model's reply, which is how it stayed there.
      // Only an explicit request sets it here, because a request is evidence.
      this.callLanguage = null;
      if (why === 'patient request') this._hindiInCall = (code === 'hi-IN');
      this.stt.repin('hi-IN');
    } else {
      this.callLanguage = code;
      this.stt.repin(code);
    }
    console.log(`[CALL ${this.callSid}] 🌐 Language switched (${why}): ${config.languageNames[code]} (${code}) — voice=${config.speakerForLang(code)}`);
    // WhatsApp confirmation + CRM language follows the call's language.
    this.languageDetected = config.languageNames[code] || this.languageDetected;
    // Pre-dial the NEW language's TTS socket now — the turn's earlier prewarm
    // was for the OLD language, and the mismatch cost ~1.9s first-byte on the
    // switch turn of a live call (2026-07-09).
    prewarmTTS({ speaker: this._currentSpeaker(), languageCode: this._langCode() });
    // Background-cache this language's filler + emergency audio — 9 of 11
    // languages otherwise heard a HINDI filler in the wrong voice mid-call,
    // and a pinned-language emergency paid a live-TTS delay.
    _queueLangCaches(this._langCode(), this);
  }

  // Decide the call's language from Sarvam's auto-detect on the FIRST
  // substantive utterance (multilingual flag only; runs after all echo/ghost
  // filters). Pin exactly once per call — like the voice, no oscillation.
  _maybePinLanguage(code, text, meta) {
    // Don't pin the whole call on a grunt/backchannel — wait for a real
    // sentence. (Sub-4-char utterances keep the session in unknown mode.)
    if ((text || '').replace(/[।.,!?\s'"]+/g, '').length < 4) return;

    // MID-SENTENCE GUARD (live 2026-07-24): repin() replaces the STT session,
    // which resets Sarvam's server-side utterance context. Fired during a
    // caller's mid-sentence pause ("...दर्द हो रहा था तो" ⏸ "doctor को दिखाना
    // है...") the sentence tail came back as a fresh turn on the new socket —
    // too late to stitch — and got consumed as the answer to a question the
    // caller never finished hearing. The endpoint-hold heuristic already knows
    // this utterance looks unfinished: don't tear the session down on it. The
    // pin lands on the next complete utterance; unknown-mode transcription is
    // unaffected meanwhile.
    if (looksIncomplete(text)) {
      console.log(`[CALL ${this.callSid}] 🌐 Pin deferred — utterance looks unfinished; repinning now would split the sentence`);
      return;
    }

    // EVIDENCE GATE (interim, S2-measured): Sarvam's auto-detect is wrong on
    // 50-80% of sub-1s fragments and reports language_probability=1.0 even when
    // wrong (LID calibration 2026-07-13) — a 1-word "మీకు" pinned a live call to
    // Telugu (pitch day). Rule: pin only on ONE strong utterance (≥4 tokens AND
    // ≥2s audio when duration is known — every wrong tag we measured had ≤2
    // tokens) or TWO consecutive weak utterances that agree on the language.
    // Genuine multilingual callers still pin on their first real sentence; a
    // stray fragment can no longer lock the call. Full evidence gate (majority
    // vote, whitelist, text-lid cross-check) lands with S2 ticket T3.
    const tokens = (text || '').trim().split(/\s+/).filter(Boolean).length;
    const dur = meta && typeof meta.audioDuration === 'number' ? meta.audioDuration : null;
    const strong = tokens >= 4 && (dur === null || dur >= 2.0);
    if (!strong) {
      if (this._weakLangCandidate !== code) {
        this._weakLangCandidate = code;
        console.log(`[CALL ${this.callSid}] 🌐 Pin deferred — weak evidence (${tokens} tok, ${dur == null ? '?' : dur.toFixed(1) + 's'}) for ${code}; awaiting agreement`);
        return;
      }
      console.log(`[CALL ${this.callSid}] 🌐 Two consecutive weak utterances agree on ${code} — pinning`);
    }
    this._weakLangCandidate = null;

    // Hindi↔Punjabi are highly confusable on short utterances — "chadh rahi hai",
    // "haan do din ho gaye", "theek hai kar do" are near-identical in both, and
    // Sarvam over-confidently tags such fragments pa-IN (live call 2026-07-12: a
    // Hindi caller saying "sir mein gas chadhri hai" locked the WHOLE call to
    // Punjabi off the 1-word tail "chadhri hai"). This clinic's callers speak
    // Hindi / Marathi / Kannada, not Punjabi, so a Punjabi detection is almost
    // always a mis-heard Hindi fragment — route it to the legacy hi-IN session
    // (understood + answered in Hindi either way). Explicit "Punjabi mein bolo"
    // requests still switch, via _detectLanguageRequest (a different path).
    if (code === 'pa-IN') code = 'hi-IN';

    this._langPinned = true;

    if (code === 'hi-IN' || code === 'mr-IN') {
      // Legacy pair: pin the session to hi-IN (handles both Devanagari
      // languages + Hinglish, as it always has) and let looksLikeHindi drive
      // the voice exactly as today.
      console.log(`[CALL ${this.callSid}] 🌐 Auto-detect: ${code} — pinning STT to legacy hi-IN session`);
      this.stt.repin('hi-IN');
      return;
    }
    if (!config.languageNames[code]) {
      // STT-only language (Assamese/Urdu/Nepali/…) or unrecognized code:
      // we can understand it but bulbul can't speak it — reply in Hindi.
      console.log(`[CALL ${this.callSid}] 🌐 Auto-detect: ${code || 'unknown'} — no TTS support; pinning hi-IN, replying in Hindi`);
      this.stt.repin('hi-IN');
      return;
    }
    this.callLanguage = code;
    this.stt.repin(code);
    this.languageDetected = config.languageNames[code] || this.languageDetected;
    _queueLangCaches(code, this);
    console.log(`[CALL ${this.callSid}] 🌐 Language pinned: ${config.languageNames[code]} (${code}) — voice=${config.speakerForLang(code)}`);
  }

  _currentSpeaker() {
    return config.speakerForLang(this._replyVoiceLang || this._langCode());
  }

  // A patient reply that likely triggers a booking (terminal confirmation or
  // explicit booking words). Shared by the lean-streaming dispatch gate and the
  // speculation gate so the two can never drift: these turns stay on the
  // verified-then-speak non-streaming path and are never speculated.
  _lastRituTurnWasOffer() { return lastRituTurnWasOffer(this._lastRituText); }

  // Re-decide Hindi-vs-Marathi from what the patient just said. Inert when the
  // call is pinned to a non-pair language (callLanguage), and when the caller
  // has asked explicitly (_langRequested) — a request outranks inference.
  _updatePairLanguage(text) {
    if (this.callLanguage || this._langRequested) return;
    try {
      const before = this._hindiInCall ? 'hi-IN' : 'mr-IN';
      const after = pairLanguage(text, before);
      if (after !== before) {
        this._hindiInCall = (after === 'hi-IN');
        console.log(`[CALL ${this.callSid}] 🌐 ${before} → ${after} from the patient's own words — voice "${this._currentSpeaker()}"`);
      }
    } catch (_) { /* detection best-effort */ }
  }

  // Remember the FIRST booking this call made. One helper for all three success
  // sites, so a fourth cannot forget it. Later bookings do not overwrite: the
  // first one is what the second-booking line has to name.
  _recordBooking(result) {
    const b = result && result.booking;
    if (!b || !b.appointment_id || this._bookedThisCall) return;
    this._bookedThisCall = {
      appointment_id: b.appointment_id,
      appointment_time: b.appointment_time || result.appointmentTime || null,
      doctor_name: b.doctor_name || this.doctorName || null,
    };
  }

  _isBookingLikelyTurn(text) {
    // NOTE: JS \b is ASCII-only — it NEVER matches next to Devanagari, so
    // \bबुक\b silently never fired ("अपॉइंटमेंट बुक कीजिए" slipped through to
    // streaming). बुक is matched bare (a false positive only costs the turn its
    // streaming, never correctness); \b stays on the English "book" only.
    return (
      // Ritu's own last line was a booking offer → this is the answer to it.
      this._lastRituTurnWasOffer() ||
      isTerminalConfirmation(text) ||
      // बुक + "book" transliterations across scripts (Kannada/Punjabi/Tamil/
      // Telugu/Bengali/Gujarati/Malayalam/Odia) + per-language "do it"
      // imperatives. Over-matching only costs a turn its streaming (routes to
      // the verified-then-speak path) — never correctness.
      /बुक|ಬುಕ್|ਬੁੱਕ|புக்|బుక్|বুক|બુક|ബുക്ക്|ବୁକ୍|\bbook\b|कर\s*दो|कर\s*दीजिए|करा\s*दो|ಮಾಡಿ|ಮಾಡು|ಮಾಡ್ಬಿಡ|ਕਰੋ|ਕਰ\s*ਦਿਓ|செய்யுங்கள்|பண்ணுங்க|பண்ணு|చేయండి|చెయ్య|করুন|করে\s*দিন|કરો|કરી\s*દો|ചെയ്യൂ|ചെയ്യണ|ചെയ്തോളൂ|କରନ୍ତୁ|କରିଦିଅ/i.test(text) ||
      // Cancel intent also takes the guarded non-streamed path (that is where the
      // CANCEL_APPOINTMENT sentinel is parsed + the false-cancel guard runs).
      // Over-matching only costs a turn its streaming, never correctness.
      /\bcancel\b|कैंसि?ल|कैन्सल|कॅन्सल|रद्द|हटा\s*दो|ਰੱਦ|ਕੈਂਸਲ|ರದ್ದು|ரத்து|రద్దు|বাতিল|રદ\s*કર|റദ്ദ|ବାତିଲ/i.test(text)
      // A move/reschedule request takes the verified path too: that is where the
      // UPDATE_APPOINTMENT sentinel is parsed and the false-move guard runs. A
      // streamed "बदल दी है" was audio on the wire before its sentinel arrived.
      || /बदल|शिफ्ट|शिफ़्ट|\bshift\b|\breschedul|\bchange\b|\bmove\b|बदलाय|ಬದಲಾಯಿಸ|ਬਦਲ|மாற்ற|మార్చ|বদল|બદલ|മാറ്റ|ବଦଳ|आगे\s*पीछे/i.test(text)
    );
  }

  // ─── SPECULATIVE LLM (Phase B, flag ENABLE_SPECULATIVE_LLM) ────────────────

  // Called on EVERY new STT final (end of the transcript handler). Any older
  // speculation is superseded (its transcript is now stale); a new one starts
  // only when this turn would take the lean-streaming path anyway — the
  // eligibility below mirrors the dispatch gate in processIntent exactly.
  _maybeStartSpeculation(holdMs) {
    this._cancelSpeculation('superseded by new transcript');
    this._cancelCompletionSpec('superseded by new transcript');
    if (this.intake) return; // a lean speculation would generate a booking reply nobody uses
    if (!ENABLE_SPECULATIVE_LLM) return;
    if (config.clinicMode !== 'lean' || !config.llm.enableLeanStreaming) return;
    if (this._emergencyTriggered || this.shouldEndCall || this._ended) return;
    const transcript = this._pendingTranscript;
    if (!transcript) return;
    if (detectSensitiveProbe(transcript, this._langCode())) return; // probe path skips the LLM entirely
    if (detectMedicalAdvice(transcript + ' ' + toDevanagari(transcript), this._langCode())) return; // deflected deterministically — no LLM
    if (this._specStartsThisTurn >= 3) {
      console.log(`[CALL ${this.callSid}] Speculation skipped — ${this._specStartsThisTurn} starts this turn already (fragmenting utterance)`);
      return;
    }

    // Snapshot: the exact messages this turn would send at dispatch. The live
    // history gets this user turn pushed at dispatch time; the snapshot bakes it
    // in now so late mutations can't leak into the speculative call.
    const snapshot = [...this.conversationHistory, { role: 'user', content: transcript }];
    const context = {
      appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
      clinicId: config.clinicId,
      callerPhone: this.callerPhone,
      callSid: this.callSid, // tool-time + event notes key by the call
      patientTextAll: this._patientTextAll + ' ' + transcript, // slice source incl. THIS turn (not yet pushed)
      patientName: this.patientName,
      hindiInCall: this._hindiInCall,
      languageCode: this.callLanguage, // null → legacy hi/mr prompt rule
      multilingual: ENABLE_MULTILINGUAL, // prompt: she knows her 11 languages
      onRosterSlice: (sl) => this._noteRosterSlice(sl),
      onLlmUsage: (u) => this._recordLlmUsage(u),
    };
    const lastEntryRef = this.conversationHistory[this.conversationHistory.length - 1] || null;

    // Route by which lean path this turn will take at dispatch (must mirror the
    // processIntent gate exactly): booking-likely turns and every post-booking
    // turn run NON-streamed → speculate the raw COMPLETION (generation only, the
    // booking DB write stays at dispatch). Everything else streams → speculate
    // the sentence stream as before.
    if (this.appointmentBooked || this._isBookingLikelyTurn(transcript)) {
      this._completionSpec = new CompletionSpeculation(
        transcript,
        this._generationId,
        snapshot.length,
        lastEntryRef,
        () => generateLeanRaw(snapshot, context)
      );
      this._specStartsThisTurn++;
      this._specStarted++;   // same counter as the streaming kind — see _cancelCompletionSpec
      console.log(`[CALL ${this.callSid}] Speculative completion started during ${holdMs}ms hold (non-streamed turn): ${speech(transcript)}`);
    } else {
      this._speculation = new LeanSpeculation(
        transcript,
        this._generationId,
        snapshot.length,
        lastEntryRef,
        () => getLeanResponseStream(snapshot, context)
      );
      this._specStartsThisTurn++;
      this._specStarted++;
      console.log(`[CALL ${this.callSid}] Speculative LLM started during ${holdMs}ms hold: ${speech(transcript)}`);
    }
    // Open the TTS socket alongside the speculative LLM (flag-gated, no-op if a
    // fresh matching socket is already up) — the reply then skips the handshake.
    prewarmTTS({ speaker: this._currentSpeaker(), languageCode: this._langCode() });
  }

  _cancelCompletionSpec(reason) {
    const spec = this._completionSpec;
    if (!spec) return;
    this._completionSpec = null;
    spec.cancel();
    this._specCancelled++;
    this._noteSpecCancel(`completion:${reason}`);
    console.log(`[CALL ${this.callSid}] Completion speculation cancelled (${reason}) after ${Date.now() - spec.startedAt}ms: ${speech(spec.transcript)}`);
  }

  // At dispatch of a non-streamed lean turn: claim the completion speculation.
  // Same rules as _takeSpeculation — exact-transcript match only (a mismatch
  // belongs to a newer pending turn), then generation id + history length +
  // last-entry identity pins; stale → cancelled, turn runs fresh.
  _takeCompletionSpec(userText) {
    const spec = this._completionSpec;
    if (!spec) return null;
    if (spec.transcript !== userText) return null; // newer turn's spec — leave it
    this._completionSpec = null;
    const valid =
      !spec.cancelled &&
      spec.genId === this._generationId &&
      spec.expectedHistoryLen === this.conversationHistory.length &&
      (this.conversationHistory[this.conversationHistory.length - 2] || null) === spec.lastEntryRef &&
      !this._emergencyTriggered;
    if (!valid) {
      spec.cancel();
      this._specCancelled++;
      this._noteSpecCancel(`completion:${
        spec.genId !== this._generationId ? 'generation-changed'
        : spec.expectedHistoryLen !== this.conversationHistory.length ? 'history-length-changed'
        : this._emergencyTriggered ? 'emergency'
        : 'history-identity-changed'}`);
      console.log(`[CALL ${this.callSid}] Completion speculation discarded at dispatch (stale) after ${Date.now() - spec.startedAt}ms`);
      return null;
    }
    this._specClaimed++;
    return spec;
  }

  // The non-streamed lean turn: use the speculatively-generated raw completion
  // when one is valid for this exact transcript (awaiting the in-flight tail if
  // needed), else run the proven getLeanResponse. Either way the sentinel parse
  // and the booking DB write happen HERE, at dispatch, in the serialized chain.
  async _leanNonStreamedResult(userText) {
    const context = {
      appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
      clinicId: config.clinicId,
      callerPhone: this.callerPhone,
      callSid: this.callSid, // tool-time + event notes key by the call
      patientName: this.patientName,
      hindiInCall: this._hindiInCall,
      languageCode: this.callLanguage, // null → legacy hi/mr prompt rule
      multilingual: ENABLE_MULTILINGUAL, // prompt: she knows her 11 languages
      onRosterSlice: (sl) => this._noteRosterSlice(sl),
      onLlmUsage: (u) => this._recordLlmUsage(u),
      patientTextAll: this._patientTextAll // roster-slice source (call-lifetime, trim-proof)
    };
    const spec = this._takeCompletionSpec(userText);
    if (spec) {
      const raw = await spec.rawPromise;
      if (raw) {
        console.log(`[CALL ${this.callSid}] Completion speculation committed: ${Date.now() - spec.startedAt}ms head start`);
        return processLeanRaw(raw, context);
      }
      console.log(`[CALL ${this.callSid}] Completion speculation empty/failed — running fresh`);
    }
    return getLeanResponse(this.conversationHistory, context);
  }

  _noteSpecCancel(reason) {
    const k = String(reason || 'unknown').slice(0, 40);
    this._specCancelReasons[k] = (this._specCancelReasons[k] || 0) + 1;
  }

  _cancelSpeculation(reason) {
    const spec = this._speculation;
    if (!spec) return;
    this._speculation = null;
    spec.cancel();
    this._specCancelled++;
    this._noteSpecCancel(reason);
    console.log(`[CALL ${this.callSid}] Speculation cancelled (${reason}) after ${Date.now() - spec.startedAt}ms: ${speech(spec.transcript)}`);
  }

  // At dispatch: claim the speculation for THIS turn. Exact-transcript match
  // only — a mismatched spec belongs to a NEWER pending turn (patient spoke
  // again while this turn sat queued) and must be left alone. A matching spec
  // is additionally validated against generation id, history length and
  // emergency state; stale → cancelled, turn runs fresh.
  _takeSpeculation(userText) {
    const spec = this._speculation;
    if (!spec) return null;
    if (spec.transcript !== userText) return null; // newer turn's spec — leave it
    this._speculation = null;
    const valid =
      !spec.cancelled &&
      spec.genId === this._generationId &&
      spec.expectedHistoryLen === this.conversationHistory.length &&
      // Identity pin: the entry just before the dispatch-pushed user turn must
      // be the SAME OBJECT that was last at snapshot time. Catches the
      // length-neutral push+trim interleaving the bare length check misses.
      (this.conversationHistory[this.conversationHistory.length - 2] || null) === spec.lastEntryRef &&
      !this._emergencyTriggered;
    if (!valid) {
      spec.cancel();
      this._specCancelled++;
      // Name WHICH pin failed. "stale" covers five different causes and they
      // have different fixes: a genId change is a barge-in, a history-length
      // change is a turn that pushed while we speculated, and the identity pin
      // catches a length-neutral push+trim that the length check cannot see.
      this._noteSpecCancel(
        spec.cancelled ? 'already-cancelled'
        : spec.genId !== this._generationId ? 'generation-changed'
        : spec.expectedHistoryLen !== this.conversationHistory.length ? 'history-length-changed'
        : (this.conversationHistory[this.conversationHistory.length - 2] || null) !== spec.lastEntryRef ? 'history-identity-changed'
        : this._emergencyTriggered ? 'emergency'
        : 'unknown'
      );
      console.log(`[CALL ${this.callSid}] Speculation discarded at dispatch (stale) after ${Date.now() - spec.startedAt}ms`);
      return null;
    }
    console.log(`[CALL ${this.callSid}] Speculation committed: ${Date.now() - spec.startedAt}ms head start, ${spec.sentencesBuffered()} sentence(s) buffered`);
    // CLAIMED — the turn is using this speculation. This is the number that
    // matters: started-but-cancelled costs an LLM call and saves nothing, and
    // looks identical to "working" from outside.
    this._specClaimed++;
    return spec;
  }

  // Check if a transcript is an echo of Ritu's last utterance.
  // Compares word overlap — if >50% of the transcript words appear in
  // Ritu's text, it's likely echo from the phone speaker.
  _isEcho(text) {
    // ALL Indic blocks (\u0900-\u0D7F), not just Devanagari — with only
    // Devanagari kept, a pinned kn/pa/ta/te/bn/gu/ml/od call normalized
    // Ritu's own words to NOTHING, _isEcho always returned false, and her
    // phone-line echo barged her in (audit 2026-07-09, critical).
    const normalize = s => s.toLowerCase().replace(/[^\w\s\u0900-\u0D7F]/g, '').split(/\s+/).filter(Boolean);
    const rituWords = new Set(normalize(this._lastRituText));
    if (rituWords.size === 0) return false;
    const transcriptWords = normalize(text);
    if (transcriptWords.length === 0) return false;
    const overlap = transcriptWords.filter(w => rituWords.has(w)).length;
    return (overlap / transcriptWords.length) > 0.5;
  }

  // ─── CALL START (pre-cached greeting — instant response) ────────────────────

  /**
   * Load this caller's previously confirmed molecules for the matcher's prior.
   *
   * FIRE-AND-FORGET ON PURPOSE. The meds turn is several turns away — the
   * caller has to be greeted, state a reason and reach the history questions
   * first — so there is no reason to make the greeting wait on a query, and
   * every reason not to. If it is slow, or fails, the prior is simply empty and
   * the matcher behaves exactly as it did before. A latency optimisation that
   * can cost a turn of silence is not one.
   */
  _loadPriorMeds() {
    return getPatientMedications(this.callerPhone, 8)
      .then((rows) => {
        // Brand as well as molecule: a caller says "Dolo", not "Paracetamol",
        // and Calpol arrives as काल बोल. Both are things they have confirmed.
        const terms = [];
        for (const r of rows || []) {
          if (r.canonical) terms.push(r.canonical);
          if (r.brand && r.brand !== r.canonical) terms.push(r.brand);
        }
        this._priorMeds = [...new Set(terms)];
        if (this._priorMeds.length) {
          console.log(`[CALL ${this.callSid}] prior meds loaded: ${this._priorMeds.length} term(s)`);
        }
      })
      .catch((err) => {
        console.warn(`[CALL ${this.callSid}] prior meds unavailable: ${err.message}`);
      });
  }

  async start() {
    if (this.intake) return this._startIntake();
    try {
      console.log(`[CALL ${this.callSid}] Call started from ${maskPhone(this.callerPhone)}`);
      this._loadPriorMeds();   // off the hot path — see above
      // Which slots are already gone, refreshed before the caller can ask for
      // one. Fire-and-forget behind a TTL: the greeting is playing, the roster
      // itself is already in memory, and a failure just leaves Ritu offering
      // blind — where she was before this existed. See brain-lean.refreshTakenSlots.
      // Desk edits (doctors, timings, treatments, fees, FAQs) reach this call
      // once the 60 s roster TTL has lapsed — off the latency path, exactly
      // like the taken-slot refresh below. See brain-lean.refreshRoster.
      try { require('./brain-lean').refreshRoster().catch(() => {}); } catch (_) {}
      try { require('./brain-lean').refreshTakenSlots().catch(() => {}); } catch (_) {}

      // Forced language: the call is BORN pinned — STT opens in the language,
      // callLanguage locks the voice + brain-reply language, and _langPinned
      // makes _maybePinLanguage a no-op. No auto-detect, no mid-call switches.
      if (FORCE_LANG) {
        this._langPinned = true;
        if (FORCE_LANG === 'hi-IN' || FORCE_LANG === 'mr-IN') {
          this.callLanguage = null; // legacy pair machinery, as always
          this._hindiInCall = (FORCE_LANG === 'hi-IN');
        } else {
          this.callLanguage = FORCE_LANG;
          this.languageDetected = config.languageNames[FORCE_LANG] || this.languageDetected;
        }
      }

      this.stt = createStreamingSTT(
        (text, meta) => this._onTranscript(text, meta),
        () => this._onSpeechStart(),
        () => this._onSpeechEnd(),
        // Forced language opens pinned; else multilingual auto-detect
        // (language-code=unknown, first substantive utterance pins — see
        // _maybePinLanguage); flag off → pinned hi-IN exactly as always.
        { languageCode: FORCE_LANG
            ? (FORCE_LANG === 'mr-IN' ? 'hi-IN' : FORCE_LANG) // legacy pair shares the hi-IN session
            : (ENABLE_MULTILINGUAL ? 'unknown' : 'hi-IN') }
      );

      // Warm the primary LLM socket NOW, while the ~5s greeting plays — so the
      // caller's first real turn (their name) skips the cold TLS handshake too.
      // Fire-and-forget, breaker-safe, errors swallowed (see llm prewarmPrimary).
      prewarmPrimary();

      // ─── RETURNING CALLER: greet by saved name, skip the name question ──
      // Eliminates STT name-capture error for repeat patients. We already
      // know the name from a prior booking, so pre-set patientName, advance
      // to the reason phase, and greet personally (live TTS — the cached
      // greeting is generic and can't carry a name).
      if (this.returningName && !PLACEHOLDER_NAME.test(this.returningName)) {
        // The name comes off the patient row in whatever script it was written
        // in, which need not be the greeting's — see the note at GREETING_TEXT.
        const greeting = toSpeakableScriptWords(
          withRecordingNotice(
            (RETURNING_GREETING_TEXTS[GREETING_LANG] || RETURNING_GREETING_TEXTS['mr-IN'])(this.returningName),
            GREETING_LANG),
          GREETING_LANG);
        this.patientName = this.returningName;
        this.conversationPhase = 'reason';
        this.conversationHistory.push({ role: 'user', content: 'Call connected. Returning patient — greet by name and ask the reason.' });
        this.conversationHistory.push({ role: 'assistant', content: greeting });
        console.log(`[CALL ${this.callSid}] Returning patient — personalized greeting, skipping name capture`);
        // speak() streams (~0.5s first chunk) and now picks the right voice
        // via _langCode()'s GREETING_LANG default. (The earlier explicit HTTP
        // synthesis was voice-correct but non-streaming — live 2026-07-20:
        // ~5s of silence before the greeting; the caller hung up.)
        await this.speak(greeting);
        return;
      }

      // ─── NEW CALLER: generic cached greeting (asks for the name) ────────
      this.conversationHistory.push({ role: 'user', content: 'Call connected, greet the patient.' });
      this.conversationHistory.push({ role: 'assistant', content: GREETING_TEXT });

      if (GREETING_AUDIO) {
        console.log(`[CALL ${this.callSid}] Ritu (cached): ${GREETING_TEXT}`);
        this.transcript.push({ role: 'ritu', text: GREETING_TEXT, time: new Date().toISOString() });
        this.isSpeaking = true;
        this._greetingProtected = true; // ignore anything spoken over the name-question greeting
        this._greetingProtectTimer = setTimeout(() => { this._greetingProtected = false; }, GREETING_PROTECT_MAX_MS);
        this._lastRituText = GREETING_TEXT;
        this._sendAudioBuffer(GREETING_AUDIO);
        this._sendSilence(200);
        this._sendMark();
      } else {
        await this.speak(GREETING_TEXT);
      }
    } catch (error) {
      await this.handleCriticalError(error);
    }
  }

  // ─── AUDIO HANDLING ─────────────────────────────────────────────────────────
  // Exotel delivers base64-encoded PCM16 audio. No mulaw conversion needed —
  // we pass bytes directly to Sarvam STT.

  // Full-duplex: always feed caller audio to STT, even while Ritu speaks.
  // This enables barge-in detection — if the patient interrupts, STT fires
  // a transcript, _onTranscript checks isSpeaking and clears the audio queue.
  // Echo from Ritu's playback is filtered by _isEcho().
  handleAudio(audioPayload) {
    if (!this.stt) return;
    try {
      let buf = Buffer.from(audioPayload, 'base64');

      // Track caller loudness every chunk so _onSpeechEnd can log the turn-end
      // RMS — this is the data that confirms (or refutes) the loud-speaker ->
      // early-cutoff theory before we touch endpointing. Print only periodically.
      this._lastRms = computeRMS(buf);
      if (this._lastRms > this._turnPeakRms) this._turnPeakRms = this._lastRms; // running per-turn peak

      // ─── THE BACKGROUND, SAMPLED WHERE IT IS THE ONLY THING THERE ─────────
      // Every noise question this project has asked has ended the same way:
      // "we cannot tell." RMS drove three in-call decisions (ghost drop,
      // short-burst hold, the debounce gate) and was never written down, so
      // calls.diagnostics carried 18 keys and not one of them was acoustic.
      // MEASURED 2026-08-13, after a call the caller reported as misbehaving:
      // dropped=0, garbleReprompts=0, no recording (Exotel recordings stopped
      // on 2026-08-05), and therefore no way to distinguish "the model invented
      // a rejection" from "the answer was lost to noise". Both are live
      // hypotheses and the data cannot separate them.
      //
      // A chunk with NEITHER party speaking is background and nothing else —
      // the caller's room, the line, the fan. Sampled against the speech peaks
      // it gives an SNR per call, which is the number every later decision about
      // denoising, VAD or endpointing has to be argued from.
      //
      // BOUNDED. A 60s call is ~3000 chunks; keeping them all would grow the
      // handler for no gain. Reservoir-free and simple: keep every Nth sample,
      // capped. The percentile of a few hundred samples is not meaningfully
      // worse than of three thousand, and the cost stays flat on a long call.
      if (!this._patientTalking && !this.isSpeaking) {
        this._floorEvery = (this._floorEvery || 0) + 1;
        if (this._floorEvery % 5 === 0 && this._rmsFloor.length < 400) {
          this._rmsFloor.push(this._lastRms);
        }
      }
      this._rmsCounter++;
      if (this._rmsCounter % RMS_LOG_EVERY_N_CHUNKS === 0) {
        console.log(`[CALL ${this.callSid}] RMS sample: ${Math.round(this._lastRms)} (speaking=${this.isSpeaking})`);
      }

      // Optional downward soft-clip limiter (flag-gated, default OFF) — rounds
      // loud near-rail peaks before STT; byte-identical for quiet/normal audio.
      if (config.llm.enableInputLimiter) buf = softLimitPcm16(buf);

      this.stt.sendAudio(buf);
    } catch (error) {
      console.error(`[CALL ${this.callSid}] Audio handling error:`, error.message);
    }
  }

  // ─── INTENT PROCESSING ─────────────────────────────────────────────────────

  async processIntent(userText, opts = {}) {
    // OncoReady intake: its own prompt, no booking machinery, no streaming.
    if (this.intake) return this._processIntakeTurn(userText);
    // ─── LEAN MODE (CLINIC_MODE=lean) ─────────────────────────────────
    // Small-clinic/demo path owns the turn: ONE LLM call against a preloaded
    // roster (no find_doctor, no tool round-trip → no stall/garbage/hallucination).
    // Explicitly bypasses the tool + streaming dispatch below; flows into the same
    // result post-processing as the sentinel path.
    const useLean = config.clinicMode === 'lean';

    // ─── TOOL-CALLING DISPATCH (Phase 4, flag-gated) ──────────────────
    // When ENABLE_TOOL_CALLING is on, the schema-enforced tool path owns the
    // turn (find_doctor / book_appointment / etc.). Default OFF → falls
    // through to the existing sentinel/streaming pipeline, unchanged.
    if (!useLean && !opts._noStream && config.llm.enableToolCalling) {
      if (config.llm.enableToolStreaming) {
        return this.processIntentToolCallingStream(userText);
      }
      return this.processIntentToolCalling(userText);
    }

    // ─── STREAMING DISPATCH (feature/llm-streaming, flag-gated) ───────
    // Stream the LLM→TTS only on greeting/reason turns, where a booking
    // sentinel cannot legitimately occur. Booking/update/wrapup turns stay
    // on the proven non-streaming path (Option B) so the calendar write
    // always precedes the spoken confirmation. _noStream prevents the
    // fallback re-run from recursing back into streaming.
    if (
      !useLean &&
      !opts._noStream &&
      config.llm.enableStreaming &&
      !this.appointmentBooked &&
      (this.conversationPhase === 'greeting' || this.conversationPhase === 'reason')
    ) {
      return this.processIntentStream(userText);
    }

    // Lean streaming: stream the warm reply sentence-by-sentence, EXCEPT the
    // booking-confirm turn (which must stay verified-then-speak). Gated on the
    // PATIENT'S reply AND on whether Ritu's LAST SENTENCE was an offer. The
    // earlier version keyed on the caller alone, because a substring test on
    // _lastRituText ("बुक कर" anywhere) had forced every later turn non-streaming;
    // lastRituTurnWasOffer is anchored on the final sentence ending in "?", which
    // does not have that problem, and it catches the yeses no word list can —
    // "हां जी, करता।", "चल ठीक है।" — that streamed a false "हो गया जी!" twice.
    // The unified streamed guard + sentinel handoff remain the correctness net.
    const bookingLikely = this._isBookingLikelyTurn(userText);
    if (
      useLean &&
      !opts._noStream &&
      config.llm.enableLeanStreaming &&
      !this.appointmentBooked &&
      !bookingLikely
    ) {
      // Claim any speculation started for this exact transcript — its buffered
      // sentences replay through speakStream, hiding the LLM latency inside the
      // endpoint hold that already elapsed.
      return this.processIntentLeanStream(userText, this._takeSpeculation(userText));
    }
    // This turn is NOT taking the lean-streaming path (booking confirm or
    // fallback re-run) — a speculation for this same transcript is unusable.
    // Only cancel an exact match: a mismatched spec belongs to a newer turn.
    if (this._speculation && this._speculation.transcript === userText) {
      this._cancelSpeculation('turn routed non-streaming');
    }

    const myGen = this._generationId;

    const result = useLean
      ? await this._leanNonStreamedResult(userText)
      : await getResponse(
          this.conversationHistory,
          this.callerPhone,
          {
            appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
            conversationPhase: this.conversationPhase,
            eventId: this.eventId
          }
        );

    // Barge-in fired while the LLM was thinking — discard this stale
    // response so we don't speak it over the patient's new turn.
    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale LLM response (gen ${myGen} → ${this._generationId}): "${(result.text || '').substring(0, 60)}"`);
      return;
    }

    // Emergency latched while the LLM was thinking — never speak this
    // response. handleEmergency() owns the audio and the end-call mark.
    if (this._emergencyTriggered) {
      console.log(`[CALL ${this.callSid}] Discarding LLM response — emergency latched: "${(result.text || '').substring(0, 60)}"`);
      return;
    }

    const spokenText = result.text;

    if (result.isSlotFailure) {
      this.slotAttempts += 1;
    }
    // Record WHICH booking failure this was, if any. brain-lean names it
    // (failKind) at each refusal site; without this, two of the classifier's
    // ten reasons — no_time_offered and booking_broke — are unreachable
    // branches. Found by asking whether the edge cases were actually covered.
    if (result && result.failKind) this._bookFailKind = result.failKind;

    if (result.emergency) {
      this.emergencyDetected = true;
      this.bookingFailureReason = 'Emergency';
    }
    if (result.doctorName && result.doctorName !== 'Unknown') {
      this.doctorName = result.doctorName;
    }

    if (result.symptomDrift && result.symptomDrift.length) this._driftReasked = true;
    if (result.booked) this._recordBooking(result);
    if (result.booked && !this.appointmentBooked) {
      this.appointmentBooked = true;
      this.appointmentTime = (result.booking && result.booking.appointment_time) || result.appointmentTime;
      if (result.booking) {
        this.appointmentId = result.booking.appointment_id || this.appointmentId;
        if (result.booking.doctor_name) this.doctorName = result.booking.doctor_name;
      }
      this.eventId = result.eventId;
      this.conversionTimeSec = Math.floor((Date.now() - this.startTime) / 1000);
      this.conversationPhase = 'booked';
      console.log(`[CALL ${this.callSid}] ✅ Appointment booked at ${this.appointmentTime}`);
      this._recordDatetimeGold();
    } else if (result.booked && this.appointmentBooked) {
      // A second BOOK_APPOINTMENT succeeded in a call that already holds one.
      // Same day → the row MOVED (action:'rescheduled'); a different day is,
      // since migration 013, a SECOND row and the first still stands (the brain
      // says so aloud — see bookedSecond). Either way, refresh to the tool's
      // authoritative time so the call-end WhatsApp reflects the LATEST slot;
      // the calls row links one appointment, and it is this one.
      this.appointmentTime = (result.booking && result.booking.appointment_time) || result.appointmentTime || this.appointmentTime;
      if (result.booking && result.booking.appointment_id) this.appointmentId = result.booking.appointment_id;
      if (result.eventId) this.eventId = result.eventId; // hospital isUpdate path refreshes this too
      console.log(`[CALL ${this.callSid}] 🔄 Appointment rescheduled to ${this.appointmentTime}`);
    } else if (result.isUpdate && result.booked && result.appointmentTime) {
      this.appointmentTime = result.appointmentTime;
      if (result.eventId) this.eventId = result.eventId;
      console.log(`[CALL ${this.callSid}] 🔄 Appointment updated at ${result.appointmentTime}`);
    }

    if (result.patientName && !this.patientName) {
      this.patientName = result.patientName;
    }

    if (result.reason && !this.reason) {
      this.reason = result.reason;
      console.log(`[CALL ${this.callSid}] Reason captured`);
    }

    if (this.conversationPhase === 'greeting' && this.patientName) {
      this.conversationPhase = 'reason';
    }
    if (this.conversationPhase === 'reason' && this.reason) {
      this.conversationPhase = 'scheduling';
    }
    if (this.appointmentBooked && this.conversationPhase !== 'wrapup') {
      this.conversationPhase = 'booked';
    }

    if (result.endCall) {
      console.log(`[CALL ${this.callSid}] AI end call intent detected.`);
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }

    // Empty cleaned response (LLM emitted only sentinels, or said nothing
    // useful) → stay silent. Speaking a generic filler over the patient's
    // turn is worse than silence. State updates above still take effect.
    if (!spokenText || !spokenText.trim()) {
      console.log(`[CALL ${this.callSid}] Empty LLM response — staying silent`);
      return;
    }

    this.conversationHistory.push({ role: 'assistant', content: spokenText });
    this._trimHistory();
    // Canned hi/mr substitutions (slot-unavailable, confirm override, error
    // fallbacks from brain-lean) are NOT the model's language choice — syncing
    // on them would evict a kn/pa/… pin at the booking moment.
    if (!result.canned) this._syncLanguageToReply(spokenText); // before speak: voice matches text
    await this.speak(spokenText);
  }

  // ─── STREAMING INTENT PROCESSING (greeting/reason turns only) ───────────────
  // Streams the LLM response sentence-by-sentence into speakStream() so TTS
  // starts on the first sentence while the LLM is still generating. Falls back
  // to the proven non-streaming processIntent() on a booking-sentinel leak or
  // any stream error.

  async processIntentStream(userText) {
    const myGen = this._generationId;

    const stream = getResponseStream(
      this.conversationHistory,
      this.callerPhone,
      {
        appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
        conversationPhase: this.conversationPhase,
        eventId: this.eventId
      }
    );

    const outcome = await this.speakStream(stream, myGen);

    // Barge-in or emergency interrupted mid-stream — speakStream already
    // stopped; nothing more to do (the new turn / emergency owns the call).
    if (outcome.discarded) { this._recordBargeInPartial(outcome); return; }

    // Booking sentinel leaked into a greeting/reason turn, or the stream
    // errored. Re-run the proven non-streaming path. In these phases the
    // streamed text (if any) was a question, not a booking confirmation,
    // so a re-run cannot double-speak a confirmation.
    if (outcome.fallback) {
      console.log(`[CALL ${this.callSid}] Streaming → non-streaming fallback: ${outcome.reason}`);
      return this.processIntent(userText, { _noStream: true });
    }

    // Stale-response guard, mirroring non-streaming processIntent.
    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale streamed turn (gen ${myGen} → ${this._generationId})`);
      return;
    }
    if (this._emergencyTriggered) return;

    const result = outcome.result || {};

    // Apply the subset of state updates valid for greeting/reason turns.
    // (No booking / update / slotFailure handling here — those phases never
    // reach the streaming path.)
    if (result.emergency) {
      this.emergencyDetected = true;
      this.bookingFailureReason = 'Emergency';
    }
    if (result.patientName && !this.patientName) {
      this.patientName = result.patientName;
    }
    if (result.reason && !this.reason) {
      this.reason = result.reason;
      console.log(`[CALL ${this.callSid}] Reason captured`);
    }
    if (this.conversationPhase === 'greeting' && this.patientName) {
      this.conversationPhase = 'reason';
    }
    if (this.conversationPhase === 'reason' && this.reason) {
      this.conversationPhase = 'scheduling';
    }
    if (result.endCall) {
      console.log(`[CALL ${this.callSid}] AI end call intent detected (stream).`);
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }

    // Push the full spoken text to history (matches non-streaming behaviour).
    const spokenText = (result.text || outcome.fullSpokenText || '').trim();
    if (spokenText) {
      this.conversationHistory.push({ role: 'assistant', content: spokenText });
      this._trimHistory();
      this._syncLanguageToReply(spokenText); // streamed turn already spoke — sync for the NEXT turn
    }
  }

  // ─── LEAN STREAMING INTENT PROCESSING ───────────────────────────────────────
  // Streams the warm lean reply sentence-by-sentence via speakStream() so TTS
  // starts on sentence 1 while gemini generates the rest. Booking-confirm turns are
  // pre-routed away (dispatch above) AND the generator hands off on any
  // BOOK_APPOINTMENT sentinel → so this path never speaks a booking confirmation; a
  // fallback re-runs the proven non-streaming getLeanResponse (DB write, THEN speak).
  async processIntentLeanStream(userText, spec = null) {
    const myGen = this._generationId;

    // A committed speculation replays its buffered chunks then continues live —
    // same yield contract, so everything below is identical either way.
    const stream = spec
      ? spec.commitStream()
      : getLeanResponseStream(this.conversationHistory, {
          appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
          clinicId: config.clinicId,
          callerPhone: this.callerPhone,
          callSid: this.callSid, // tool-time + event notes key by the call
          patientName: this.patientName,
          hindiInCall: this._hindiInCall,
          languageCode: this.callLanguage, // null → legacy hi/mr prompt rule
          multilingual: ENABLE_MULTILINGUAL, // prompt: she knows her 11 languages
      onRosterSlice: (sl) => this._noteRosterSlice(sl),
      onLlmUsage: (u) => this._recordLlmUsage(u),
          patientTextAll: this._patientTextAll // roster-slice source (call-lifetime, trim-proof)
        });

    const outcome = await this.speakStream(stream, myGen);

    if (outcome.discarded) { this._recordBargeInPartial(outcome); return; }

    if (outcome.fallback) {
      // WHAT WAS ALREADY SAID ALOUD MUST ENTER THE RECORD THE MODEL READS.
      // getLeanResponseStream trips the booking check BEFORE its emit loop, but
      // sentences from EARLIER chunks are already through speakSentence — audio
      // on the wire. Live 2026-08-09 call 4843c8bc: the caller heard one reply
      // at 07:42:13.963 and a DIFFERENT one at 07:42:16.525, because the
      // re-run is sampled independently (temperature 0.5 on both paths) and had
      // no idea what had just been spoken.
      //
      // The barge-in branch three lines up already solves exactly this with
      // _recordBargeInPartial. The fallback branch dropped the outcome on the
      // floor, so the spoken line reached this.transcript and never
      // conversationHistory — on this turn and every turn after it.
      //
      // Same shape as the garble-guard bug (6427d2b): a line the model cannot
      // see is a line it will contradict. It is a no-op when nothing was spoken.
      this._recordBargeInPartial(outcome);
      // spokeAnything decides whether the ~950ms second call is worth attacking
      // at all: reusing the generation is only safe when NOTHING was spoken yet
      // (no prefix to reconcile). It was being computed and thrown away.
      console.log(`[CALL ${this.callSid}] Lean stream → non-stream fallback: ${outcome.reason} (spoke=${!!outcome.spokeAnything} chars=${(outcome.fullSpokenText || '').length})`);
      return this.processIntent(userText, { _noStream: true });
    }

    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale lean-streamed turn (gen ${myGen} → ${this._generationId})`);
      return;
    }
    if (this._emergencyTriggered) return;

    const result = outcome.result || {};
    if (result.emergency) {
      this.emergencyDetected = true;
      this.bookingFailureReason = 'Emergency';
    }
    if (result.patientName && !this.patientName) {
      this.patientName = result.patientName;
    }
    if (result.endCall) {
      console.log(`[CALL ${this.callSid}] AI end call intent detected (lean stream).`);
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }

    const spokenText = (result.text || outcome.fullSpokenText || '').trim();
    if (spokenText) {
      this.conversationHistory.push({ role: 'assistant', content: spokenText });
      this._trimHistory();
      this._syncLanguageToReply(spokenText); // streamed turn already spoke — sync for the NEXT turn
    }
  }

  // ─── TOOL-CALLING INTENT PROCESSING (Phase 4, flag-gated) ───────────────────
  // The schema-enforced path. getResponseToolCalling runs the find_doctor /
  // book_appointment / etc. loop (which writes the booking to the DB + calendar
  // itself), then returns the spoken reply. callHandler just speaks it and
  // updates call state. Same barge-in / emergency guards as the other paths.
  async processIntentToolCalling(userText) {
    const myGen = this._generationId;

    let result;
    try {
      result = await getResponseToolCalling(this.conversationHistory, {
        pool: dbPool,
        clinicId: config.clinicId,
        patientPhone: this.callerPhone,
        currentDatetime: new Date().toISOString(),
        // Fires the instant a tool call is decided (before the tool + reply-LLM
        // run) → play a short filler so the patient isn't sitting in silence.
        onToolStart: () => this._playFiller(userText)
      });
    } catch (err) {
      return this.handleCriticalError(err);
    }

    // ── Record real DB side-effects FIRST, BEFORE the barge-in/emergency guards.
    // getResponseToolCalling has already run to completion, so if it booked an
    // appointment, that row EXISTS in the DB. We must track it — so the calls row
    // links to it (provenance: which call booked what, when), the WhatsApp
    // confirmation fires, and the summary says booked:true — EVEN IF the patient
    // barged in over the spoken confirmation. Only the spoken reply is suppressed
    // on a stale/emergency turn (below). A booking is never "let go".
    if (result.patientName) this.patientName = result.patientName;
    if (result.symptomDrift && result.symptomDrift.length) this._driftReasked = true;
    if (result.booked) {
      this._recordBooking(result);
      const firstBook = !this.appointmentBooked;
      this.appointmentBooked = true;
      this.conversationPhase = 'booked';
      if (result.booking) {
        // Always refresh to the tool's authoritative latest time — a time change
        // MOVES the same appointment (action:'rescheduled'), so update even when
        // already booked. Stops the stale-time / "already 6:30" flip-flop, and the
        // call-end WhatsApp confirmation then reflects the final time.
        this.appointmentTime = result.booking.appointment_time || this.appointmentTime;
        this.appointmentId = result.booking.appointment_id || this.appointmentId;
        if (result.booking.doctor_name) this.doctorName = result.booking.doctor_name;
      }
      if (firstBook) this.conversionTimeSec = Math.floor((Date.now() - this.startTime) / 1000);
      const stale = myGen !== this._generationId;
      console.log(`[CALL ${this.callSid}] ✅ Appointment ${firstBook ? 'booked' : 'rescheduled'} (tool-calling) for ${maskPhone(this.callerPhone)}${stale ? ' [recorded despite barge-in]' : ''}`);
    }

    // Stale (barge-in) / emergency: the booking above is already recorded; here we
    // only suppress the now-stale SPOKEN reply (the patient interrupted).
    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale tool-calling reply (gen ${myGen} → ${this._generationId})`);
      return;
    }
    if (this._emergencyTriggered) {
      console.log(`[CALL ${this.callSid}] Discarding tool-calling reply — emergency latched`);
      return;
    }

    if (result.endCall) {
      console.log(`[CALL ${this.callSid}] AI end call intent detected (tool-calling).`);
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }

    const spokenText = (result.text || '').trim();
    if (!spokenText) {
      console.log(`[CALL ${this.callSid}] Empty tool-calling response — staying silent`);
      // If a filler played but there's nothing to say, close the turn cleanly
      // (the filler set isSpeaking and sent no mark) so the next turn can listen.
      if (this._fillerPlayedThisTurn && this.isSpeaking) {
        this._sendSilence(200);
        this._sendMark('ritu_done');
        this.isSpeaking = false;
      }
      return;
    }

    this.conversationHistory.push({ role: 'assistant', content: spokenText });
    this._trimHistory();
    // Canned hi/mr substitutions (slot-unavailable, confirm override, error
    // fallbacks from brain-lean) are NOT the model's language choice — syncing
    // on them would evict a kn/pa/… pin at the booking moment.
    if (!result.canned) this._syncLanguageToReply(spokenText); // before speak: voice matches text
    await this.speak(spokenText);
  }

  // ─── TOOL-CALLING, STREAMED (flag-gated: ENABLE_TOOL_STREAMING) ──────────────
  // Same as processIntentToolCalling, but the reply streams to TTS sentence-by-
  // sentence via the shared speakStream() consumer. Tool execution (incl. the
  // calendar write) happens inside the generator's tool rounds — which emit no
  // audio — so the spoken confirmation still follows the calendar write.
  async processIntentToolCallingStream(userText) {
    const myGen = this._generationId;

    const stream = streamResponseToolCalling(this.conversationHistory, {
      pool: dbPool,
      clinicId: config.clinicId,
      patientPhone: this.callerPhone,
      currentDatetime: new Date().toISOString()
    });

    let outcome;
    try {
      outcome = await this.speakStream(stream, myGen);
    } catch (err) {
      return this.handleCriticalError(err);
    }

    // Barge-in / emergency interrupted mid-stream — speakStream already stopped.
    if (outcome.discarded) { this._recordBargeInPartial(outcome); return; }

    // Stream/TTS error → re-run NON-streaming. book_appointment is idempotent
    // (same patient+doctor+time returns the existing row), so a tool that
    // already executed in the aborted stream won't double-book on the re-run.
    if (outcome.fallback) {
      console.log(`[CALL ${this.callSid}] Tool-stream → non-streaming fallback: ${outcome.reason}`);
      return this.processIntentToolCalling(userText);
    }

    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale tool-stream turn (gen ${myGen} → ${this._generationId})`);
      return;
    }
    if (this._emergencyTriggered) return;

    const result = outcome.result || {};
    if (result.patientName) this.patientName = result.patientName;

    if (result.symptomDrift && result.symptomDrift.length) this._driftReasked = true;
    if (result.booked) {
      this._recordBooking(result);
      const firstBook = !this.appointmentBooked;
      this.appointmentBooked = true;
      this.conversationPhase = 'booked';
      if (result.booking) {
        // Always refresh to the tool's latest authoritative time (reschedule moves
        // the same row) — even when already booked. See tool-calling path above.
        this.appointmentTime = result.booking.appointment_time || this.appointmentTime;
        this.appointmentId = result.booking.appointment_id || this.appointmentId;
        if (result.booking.doctor_name) this.doctorName = result.booking.doctor_name;
      }
      if (firstBook) this.conversionTimeSec = Math.floor((Date.now() - this.startTime) / 1000);
      console.log(`[CALL ${this.callSid}] ✅ Appointment ${firstBook ? 'booked' : 'rescheduled'} (tool-stream) for ${maskPhone(this.callerPhone)}`);
    }

    if (result.endCall) {
      console.log(`[CALL ${this.callSid}] AI end call intent detected (tool-stream).`);
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }

    const spokenText = (result.text || outcome.fullSpokenText || '').trim();
    if (spokenText) {
      this.conversationHistory.push({ role: 'assistant', content: spokenText });
      this._trimHistory();
      this._syncLanguageToReply(spokenText); // streamed turn already spoke — sync for the NEXT turn
    }
  }

  // ─── TRIM HISTORY ──────────────────────────────────────────────────────────

  _trimHistory() {
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
      const head = this.conversationHistory.slice(0, 2);
      const tail = this.conversationHistory.slice(-(MAX_CONVERSATION_HISTORY - 2));
      this.conversationHistory = [...head, ...tail];
    }
  }

  // ─── SPEAK (streaming TTS → Exotel as chunks arrive) ───────────────────────

  // One place that folds a turn's token usage into the per-call totals.
  // Absent usage increments the TURN count but not the reported count, so the
  // diagnostics can distinguish "10 turns, none reported" from "10 turns, all
  // reported zero cached". Those looked identical before, and the difference is
  // what a whole caching plan was mistakenly built on.
  _recordLlmUsage(usage) {
    this._llmTurns += 1;
    if (!usage) return;
    if (usage.prompt != null || usage.completion != null) {
      this._llmUsageReportedTurns += 1;
      this._llmPromptTokens += usage.prompt || 0;
      this._llmCompletionTokens += usage.completion || 0;
    }
    if (usage.cached != null) {
      this._llmCachedReportedTurns += 1;
      this._llmCachedTokens += usage.cached;
    }
  }

  // The ONE counting site for spoken text, shared by speak() (canned lines,
  // greeting) and _speakSentence() (the streamed reply path — which is where
  // production speech actually goes). Until this existed only speak() counted,
  // so a lean call's diagnostics showed ~21% of the characters Sarvam billed.
  // Counted AFTER sanitisation so the number is what was sent to TTS, not what
  // the model produced; a cold dial is a socket we had to open for this sentence.
  // ONE chokepoint for every deterministic line Ritu says — guards, re-asks,
  // silence prompts, readback acks. A line the model cannot see is a line it
  // will contradict (6427d2b: "your voice is perfectly clear" two turns after
  // the guard said it could not hear you). The history push and the speak are
  // one operation here, not two that the next call site can forget — four of
  // nine sites had forgotten (weak-language re-ask, silence prompts, the busy
  // goodbye, the readback ack) when the audit looked on 2026-09-03.
  _sayDeterministic(text) {
    if (!text) return Promise.resolve();
    this.conversationHistory.push({ role: 'assistant', content: text });
    return this.speak(text);
  }

  _noteSpokenSentence(text, ttsHandle) {
    this._speechChars += String(text || '').length;
    this._ttsSentences += 1;
    if (ttsHandle && ttsHandle.acquiredWarm === false) this._ttsColdDials += 1;
  }

  async speak(text) {
    if (!text || !text.trim()) return;
    // Last line of defense before TTS: never read markdown/degenerate model output
    // aloud (llama-4-scout once emitted "## Step 1:" ×30 and we spoke it for 15s).
    const fallback = FALLBACK_LINE[this._langCode()] || FALLBACK_LINE['hi-IN'];
    const safe = sanitizeForSpeech(text, fallback);
    const gen = this._generationId; // a barge-in/emergency bumps this; a superseded turn must not fall back to HTTP
    // Only warn when the reply was ACTUALLY replaced by the fallback (degenerate/markdown).
    // sanitizeForSpeech ALSO collapses harmless whitespace (the model's stray \n\n\n), so
    // `safe !== text` alone fired a false "suppressed" alarm on every fine reply — misleading
    // when reading logs. The full (whitespace-collapsed) reply is still spoken in that case.
    if (safe === fallback && text.trim() !== fallback) {
      console.warn(`[CALL ${this.callSid}] Degenerate/markdown reply suppressed → safe fallback. Raw: ${JSON.stringify(text).slice(0, 120)}`);
    }
    text = safe;
    if (this._turnT && !this._turnT.replyReady) this._turnT.replyReady = Date.now();
    this.isSpeaking = true;
    this._ttsTail = Buffer.alloc(0);
    this._lastRituText = text;

    // Voice follows the reply's language. The LLM now switches to Hindi decisively
    // on the patient's first Hindi line, but _hindiInCall (which picks the TTS
    // voice) only flipped on a clean-Hindi PATIENT transcript — so Ritu's Hindi
    // text was spoken by the Marathi voice for a few turns. If she's replying in
    // Hindi, lock the voice to Hindi from THIS reply.
    // (callLanguage set → a pinned non-hi/mr call: _currentSpeaker() follows
    // callLanguage, so this legacy flip must not fire — live bug 2026-07-19,
    // Kannada text spoken by the Hindi voice mid-call.)
    // Speak a Hindi reply in the Hindi voice — for THIS reply. It used to also
    // set _hindiInCall, so one model slip into Hindi re-instructed the model to
    // stay in Hindi and moved every canned line with it. Voice only, transient.
    this._replyVoiceLang = (!this.callLanguage && !this._hindiInCall && looksLikeHindi(text)) ? 'hi-IN' : null;
    if (this._replyVoiceLang) {
      console.log(`[CALL ${this.callSid}] Voice → ${this._currentSpeaker()} for this reply (reply is Hindi; call stays ${this._langCode()})`);
    }

    try {
      console.log(`[CALL ${this.callSid}] Ritu: ${speech(text)}`);
      this.transcript.push({ role: 'ritu', text, time: new Date().toISOString() });
      this._speechReplies += 1;
      const ttsHandle = streamTTS(text, (audioChunk) => {
        this._sendStreamingAudio(audioChunk);
      }, { speaker: this._currentSpeaker(), languageCode: this.callLanguage || undefined });
      this._noteSpokenSentence(text, ttsHandle);
      this._activeTTS = ttsHandle;
      try {
        await ttsHandle;
      } finally {
        this._activeTTS = null;
      }

      this._flushStreamingTail();
      this._sendSilence(200);

      if (this.shouldEndCall) {
        this._sendMark('ritu_end_call');
      } else {
        this._sendMark('ritu_done');
      }
    } catch (error) {
      if (gen !== this._generationId) {
        console.log(`[CALL ${this.callSid}] HTTP fallback skipped — turn superseded (barge-in/emergency)`);
        return;
      }
      console.error(`[CALL ${this.callSid}] Streaming TTS failed, falling back to HTTP:`, error.message);
      this._ttsTail = Buffer.alloc(0);

      try {
        const audioBuffer = await textToSpeech(text, 0, { speaker: this._currentSpeaker(), languageCode: this.callLanguage || undefined });
        this._sendAudioBuffer(audioBuffer);

        this._sendSilence(200);

        if (this.shouldEndCall) {
          this._sendMark('ritu_end_call');
        } else {
          this._sendMark('ritu_done');
        }
      } catch (fallbackErr) {
        console.error(`[CALL ${this.callSid}] HTTP TTS also failed:`, fallbackErr.message);
        this.isSpeaking = false;
      }
    }
  }

  // ─── SPEAK STREAM (sentence-by-sentence TTS) ───────────────────────────────
  // Consumes a getResponseStream() async generator. Speaks each sentence as
  // it arrives (TTS starts on sentence 1 while the LLM is still generating
  // the rest), then emits ONE ritu_done/ritu_end_call mark after the last
  // sentence — so onRituDone() fires exactly once per turn, same as speak().
  //
  // Between sentences it honours the same guards as the non-streaming path:
  //   - generation-ID mismatch (barge-in) → stop, return { discarded:true }
  //   - emergency latch → stop, return { discarded:true }
  //
  // The sub-frame _ttsTail buffer is carried across sentences and flushed
  // once at the end, so audio stays gapless between sentences.
  //
  // Returns one of:
  //   { result, fullSpokenText, spokeAnything }  — normal completion
  //   { discarded: true }                          — barge-in / emergency
  //   { fallback: true, reason, spokeAnything }    — booking leak / stream/TTS error
  // On a barge-in the streamed reply is discarded, but Ritu DID speak part of it.
  // Record that partial text in conversationHistory so the model has memory of it
  // and doesn't re-emit the same line next turn (the "why did she repeat" bug).
  _recordBargeInPartial(outcome) {
    const said = ((outcome && outcome.fullSpokenText) || '').trim();
    if (said) {
      this.conversationHistory.push({ role: 'assistant', content: said });
      this._trimHistory();
    }
  }

  async speakStream(stream, myGen) {
    // replyReady is NOT marked here. It used to be, and it made the latency
    // breakdown lie: on the streaming path the LLM generates INSIDE the stream,
    // so marking at entry charged all of the model's time to the tts bucket.
    // Live call d487e311 printed "llm+tool=0ms, tts-firstbyte=2646ms" on a turn
    // where Gemini itself logged latency=1233ms — every conclusion drawn from
    // that instrument blamed Sarvam for time the LLM spent. The mark now lands
    // where text genuinely exists: the first sentence chunk (below).
    this.isSpeaking = true;
    this._ttsTail = Buffer.alloc(0);
    let finalResult = null;
    let fullSpokenText = '';
    let spokeAnything = false;

    try {
      for await (const chunk of stream) {
        // Interrupt checks before acting on any chunk.
        // A stream abandoned before its 'done' chunk was still a request the
        // provider billed: count the turn (usage unknown → null, never 0).
        if (myGen !== this._generationId) { this._recordLlmUsage(null); return { discarded: true, fullSpokenText }; }
        if (this._emergencyTriggered) { this._recordLlmUsage(null); return { discarded: true, fullSpokenText }; }

        if (chunk.kind === 'fallback-required') {
          // The streamed attempt is being thrown away and the turn re-runs
          // non-streamed — a SECOND full LLM call. Clear the mark so that
          // re-run measures its own time instead of inheriting this attempt's,
          // which is how a 1233ms model call was reported as llm+tool=0ms.
          if (this._turnT) this._turnT.replyReady = null;
          this._recordLlmUsage(null);   // spent; the re-run is a SECOND request and counts itself
          return { fallback: true, reason: chunk.reason, spokeAnything, fullSpokenText };
        }
        if (chunk.kind === 'done') {
          finalResult = chunk.result;
          this._recordLlmUsage(chunk.usage);
          break;
        }
        if (chunk.kind === 'sentence' && chunk.text) {
          if (!spokeAnything) this._speechReplies += 1;   // one reply per turn, however many sentences
          // First real text of the turn — the honest boundary between "the model
          // was thinking" and "we are turning words into audio".
          if (this._turnT && !this._turnT.replyReady) this._turnT.replyReady = Date.now();
          fullSpokenText += (fullSpokenText ? ' ' : '') + chunk.text;
          // Update echo-detection text incrementally (Tier-2 allowance).
          this._lastRituText = fullSpokenText;
          // The STREAMED reply, which the non-streamed "Ritu:" line above was
          // gated but this one was not — a live call put "सिद्धार्थ जी, अभी के
          // लिए Dr. Manoj Deo…" into the logs, the caller's NAME included.
          console.log(`[CALL ${this.callSid}] Ritu (stream): ${speech(chunk.text)}`);
          // Voice follows the reply's language (see speak()) — flip BEFORE
          // _speakSentence so the very first Hindi sentence uses the Hindi voice.
          this._replyVoiceLang = (!this.callLanguage && !this._hindiInCall && looksLikeHindi(chunk.text)) ? 'hi-IN' : null;
          if (this._replyVoiceLang) {
            console.log(`[CALL ${this.callSid}] Voice → ${this._currentSpeaker()} for this sentence (reply is Hindi; call stays ${this._langCode()})`);
          }
          const spokenText = await this._speakSentence(chunk.text);
          // transcript carries what was SENT to TTS — sanitised, as speak() records it
          if (spokenText) this.transcript.push({ role: 'ritu', text: spokenText, time: new Date().toISOString() });
          spokeAnything = true;
        }
      }

      // Final interrupt check before committing the closing mark.
      if (myGen !== this._generationId || this._emergencyTriggered) {
        return { discarded: true, fullSpokenText };
      }

      // Flush the carried sub-frame tail, add the trailing silence, emit the
      // single closing mark for the whole turn.
      this._flushStreamingTail();
      this._sendSilence(200);
      const willEnd = !!(finalResult && finalResult.endCall);
      this._sendMark(willEnd ? 'ritu_end_call' : 'ritu_done');

      return { result: finalResult, fullSpokenText, spokeAnything };
    } catch (err) {
      console.error(`[CALL ${this.callSid}] speakStream error: ${err.message}`);
      // If we haven't spoken yet, a clean fallback is possible. If we have,
      // still request fallback so the caller can finish the turn — the
      // non-streaming re-run handles its own audio + mark.
      return { fallback: true, reason: `stream_tts_error: ${err.message}`, spokeAnything };
    }
  }

  // Speak ONE sentence: stream its TTS audio to Exotel. No mark, no trailing
  // silence (the caller emits those once at end of turn). Carries _ttsTail
  // across calls so sentence boundaries stay gapless. Falls back to HTTP TTS
  // for this sentence on streaming-TTS failure.
  async _speakSentence(text) {
    // Same degenerate/markdown guard as speak(); skip the sentence rather than
    // inject a fallback mid-stream (the turn's other sentences carry on).
    const safe = sanitizeForSpeech(text, '');
    const gen = this._generationId; // see speak(): no HTTP fallback for a superseded sentence
    if (!safe) {
      // Truly degenerate (markdown/repeat-loop → nothing speakable). Skip this
      // sentence; the turn's other sentences carry on.
      console.warn(`[CALL ${this.callSid}] Degenerate sentence skipped (nothing speakable): ${JSON.stringify(text).slice(0, 100)}`);
      return;
    }
    // safe !== text here only means harmless whitespace/markdown was collapsed
    // (e.g. the model's stray \n\n between clauses) — speak the cleaned version,
    // no warning. The old code logged "skipped" here even though it went on to
    // speak the cleaned text, which read as lost content in the logs when nothing
    // was actually dropped.
    text = safe;
    try {
      const ttsHandle = streamTTS(text, (audioChunk) => {
        this._sendStreamingAudio(audioChunk);
      }, { speaker: this._currentSpeaker(), languageCode: this.callLanguage || undefined });
      this._noteSpokenSentence(text, ttsHandle);
      this._activeTTS = ttsHandle;
      try {
        await ttsHandle;
      } finally {
        this._activeTTS = null;
      }
    } catch (err) {
      // Per-sentence HTTP fallback. Flush any partial tail first so we don't
      // splice the HTTP buffer onto a half-frame.
      if (gen !== this._generationId) {
        console.log(`[CALL ${this.callSid}] sentence HTTP fallback skipped — turn superseded`);
        return text;
      }
      console.error(`[CALL ${this.callSid}] Sentence streaming TTS failed, HTTP fallback: ${err.message}`);
      this._flushStreamingTail();
      const audioBuffer = await textToSpeech(text, 0, { speaker: this._currentSpeaker(), languageCode: this.callLanguage || undefined });
      this._sendAudioBuffer(audioBuffer);
    }
    return text;
  }

  // ─── LOW-LEVEL AUDIO SEND ──────────────────────────────────────────────────
  // Exotel expects base64-encoded PCM16 @ 8kHz in the media event. It prefers
  // chunk sizes that are multiples of 320 bytes (20ms frames), so any large
  // TTS blob is sliced into ~100ms frames.

  // One-shot send: used for the pre-cached greeting, silence padding, and the
  // HTTP-TTS fallback. The whole buffer is padded once at the end — safe
  // because it's a single contiguous audio unit.
  _sendAudioBuffer(audioBuffer) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const framed = padOrTrimToChunkBoundary(audioBuffer);
    this._writeFrames(framed);
  }

  // ─── THINKING FILLER ─────────────────────────────────────────────────────────
  // Called via the onToolStart hook the instant a tool call is decided, BEFORE
  // the tool + reply-LLM run. Streams a short pre-cached, language-matched filler
  // ("जी, एक मिनट…") so the patient hears Ritu in ~1s instead of silence. It
  // sends NO closing mark/silence — the real reply's speak() does that, and its
  // frames queue in Exotel right after the filler (sequential playback, no
  // overlap). Barge-in during the filler is handled by the existing path
  // (_clearAudio flushes it; the now-stale reply is discarded by generationId).
  // Flag-gated (ENABLE_THINKING_FILLER); once per turn.
  _playFiller(patientText) {
    if (!config.llm.enableThinkingFiller) return;
    if (this._fillerPlayedThisTurn) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    // Match the call's locked voice (Marathi by default, Hindi once switched) so
    // the filler doesn't clash with the speaker we're about to use for the reply.
    const lang = this._langCode();
    // Filler audio is pre-cached hi/mr only — for pinned new languages fall
    // back to Hindi filler ("एक क्षण") rather than a wrong-sounding Marathi one.
    const buf = FILLER_AUDIO[lang] || FILLER_AUDIO['hi-IN'] || FILLER_AUDIO['mr-IN'];
    if (!buf || !buf.length) return; // pre-cache failed → silently skip (no regression)
    this._fillerPlayedThisTurn = true;
    this.isSpeaking = true;          // so barge-in during the filler is detected
    this._markFirstAudio();          // the filler IS this turn's first audio
    this._sendAudioBuffer(buf);
    console.log(`[CALL ${this.callSid}] 💬 filler played (${lang}) while tool runs`);
  }

  // Streaming send: used per Sarvam TTS chunk. Sarvam emits chunks that are
  // NOT 320-byte aligned, so padding each one individually injects silence
  // (0x00 samples) mid-waveform and produces audible clicks/crackle. Instead,
  // carry the sub-frame remainder across chunks and only emit aligned frames
  // until the utterance ends, then flush the final tail (padded once).
  // ─── LATENCY INSTRUMENTATION ────────────────────────────────────────────────
  // Marks the first reply-audio frame of a turn + logs the dead-air breakdown.
  // _sendStreamingAudio is the ONLY path real TTS reply audio takes (greeting
  // and silence use _sendAudioBuffer), so this fires exactly once per spoken
  // turn. Purely observational — never affects audio or control flow.
  _markFirstAudio() {
    const t = this._turnT;
    if (!t || t.firstAudio) return;
    t.firstAudio = Date.now();
    const total = t.firstAudio - t.eos;
    if (Number.isFinite(total) && total >= 0) this._turnLatencies.push(total);
    // LATENCY_TRACE governs PRINTING, never MEASURING. It used to return here,
    // which was harmless while the split was only a console.log — now that the
    // split is persisted, an early return would silently empty the metric for
    // anyone who turned the trace off. A flag that quietly disables a
    // measurement is how a row passes for weeks by measuring nothing.
    if (this._fillerPlayedThisTurn) {
      // First audio is the filler (plays before the reply exists), so the
      // llm/tts split doesn't apply — the total IS the perceived gap.
      this._fillerTurns++;
      require('./brain-lean').takeTurnToolMs(this.callSid); // reset; the split does not apply to a filler turn
      if (process.env.LATENCY_TRACE !== 'false') {
        console.log(`[LATENCY ${this.callSid}] dead-air=${total}ms (filler masked the tool+reply wait)`);
      }
    } else {
      const sttDebounce = t.dispatch - t.eos;
      const llmTool = t.replyReady ? t.replyReady - t.dispatch : null;
      const ttsFirstByte = t.replyReady ? t.firstAudio - t.replyReady : null;
      // Keep them, do not just print them. Guarded the same way as the total:
      // a negative span means the clocks disagree, not that a stage was free.
      if (Number.isFinite(sttDebounce) && sttDebounce >= 0) this._sttMs.push(sttDebounce);
      if (Number.isFinite(llmTool) && llmTool >= 0) this._llmMs.push(llmTool);
      if (Number.isFinite(ttsFirstByte) && ttsFirstByte >= 0) this._ttsMs.push(ttsFirstByte);
      // The split inside llm+tool: what the tools took on this turn, and the rest.
      const toolMs = require('./brain-lean').takeTurnToolMs(this.callSid);
      const llmOnly = llmTool != null && llmTool >= 0 ? Math.max(0, llmTool - toolMs) : null;
      if (llmTool != null && llmTool >= 0) { (this._toolMs = this._toolMs || []).push(toolMs); (this._llmOnlyMs = this._llmOnlyMs || []).push(llmOnly); }
      if (process.env.LATENCY_TRACE !== 'false') {
        console.log(`[LATENCY ${this.callSid}] dead-air=${total}ms (stt+debounce=${sttDebounce}ms, llm+tool=${llmTool ?? '?'}ms [llm=${llmOnly ?? '?'}ms tool=${toolMs}ms], tts-firstbyte=${ttsFirstByte ?? '?'}ms)`);
      }
    }
  }

  // SYMPTOM DRIFT, computed at call end from conversationHistory rather than
  // hooked into the six places a reply gets pushed. Deriving it from the
  // history is COMPLETE BY CONSTRUCTION — a seventh reply site added later is
  // covered automatically, where a seventh missed hook would have silently
  // under-counted and made the metric read cleaner than the calls were. It also
  // costs the reply path nothing: this runs once, after the call, inside the
  // block that already may not throw.
  _symptomDriftAudit() {
    const out = [];
    let patientAll = '';
    for (const turn of this.conversationHistory || []) {
      const text = String(turn.content || '');
      if (turn.role === 'user') { patientAll += ' ' + text; continue; }
      if (turn.role !== 'assistant') continue;
      const drift = symptomDrift(patientAll, text);
      if (drift.length) out.push({ claimed: drift, said: text.slice(0, 80) });
    }
    return out;
  }

  _noteRosterSlice(slice) {
    this._rosterBrainTurns++;
    if (slice && slice.sliced) {
      this._rosterSliceTurns++;
      this._rosterSliceLast = { specs: slice.specs || [], count: slice.count, total: slice.total };
    }
  }

  _percentile(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  _sendStreamingAudio(audioChunk) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this._markFirstAudio();
    const combined = Buffer.concat([this._ttsTail, audioChunk]);
    const alignedLen = combined.length - (combined.length % EXOTEL_CHUNK_BYTES);
    if (alignedLen > 0) {
      this._writeFrames(combined.subarray(0, alignedLen));
    }
    this._ttsTail = combined.subarray(alignedLen);
  }

  _flushStreamingTail() {
    if (this._ttsTail.length === 0) return;
    this._writeFrames(padOrTrimToChunkBoundary(this._ttsTail));
    this._ttsTail = Buffer.alloc(0);
  }

  _writeFrames(framed) {
    // Every byte of outgoing audio passes here, so this is the one place that
    // can know how much Exotel must PLAY before it echoes the next mark. The
    // mark round trip minus this duration is the network — see telephonyProbe.js.
    // WHEN THE FIRST BYTE OF THIS STRETCH WENT OUT — not when the mark is sent.
    // The mark is sent AFTER the whole utterance has been written to the socket,
    // which takes ~200ms for ~4s of audio, while Exotel echoes only once
    // PLAYBACK finishes. Measuring from the mark therefore always produced an
    // elapsed SHORTER than the audio it represents, i.e. a negative residual,
    // and telephonyProbe discards negatives by design. That is why the first
    // live call reported markSamples=0 while eight marks were plainly echoed.
    if (!this._bytesSinceMark) this._firstByteSinceMark = Date.now();
    this._bytesSinceMark = (this._bytesSinceMark || 0) + framed.length;
    for (let offset = 0; offset < framed.length; offset += EXOTEL_OUTGOING_CHUNK_BYTES) {
      const slice = framed.subarray(offset, Math.min(offset + EXOTEL_OUTGOING_CHUNK_BYTES, framed.length));
      this.ws.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: slice.toString('base64') }
      }));
    }
  }

  _sendSilence(ms = 500) {
    // PCM16 silence = 0x00 bytes. 16 bytes per ms at 8kHz.
    const silenceBuffer = Buffer.alloc(ms * PCM16_BYTES_PER_MS, 0x00);
    this._sendAudioBuffer(silenceBuffer);
  }

  _sendMark(name = 'ritu_done') {
    if (this.ws && this.ws.readyState === 1) {
      if (this._telephony) {
        try {
          this._telephony.markSent(name, (this._bytesSinceMark || 0) / PCM16_BYTES_PER_MS,
            this._firstByteSinceMark || Date.now());
        } catch (_) {}
      }
      this._bytesSinceMark = 0;
      this.ws.send(JSON.stringify({
        event: 'mark',
        streamSid: this.streamSid,
        mark: { name }
      }));
    } else {
      this.isSpeaking = false;
    }
  }

  // ─── BARGE-IN: CLEAR EXOTEL AUDIO QUEUE ───────────────────────────────────

  _clearAudio() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        event: 'clear',
        streamSid: this.streamSid
      }));
    }
  }

  // ─── SILENCE TIMEOUT ──────────────────────────────────────────────────────

  // Deterministic pre-visit history. After a REAL symptom (and unless the caller
  // is rushing), guarantee Ritu asks duration → meds/allergies BEFORE the model
  // offers a doctor. Returns the canned question to speak (LLM skipped this turn),
  // or null to let the normal flow proceed. Has side effects (advances the stage),
  // so call it EXACTLY once per turn — never from the speculation path.
  // Which pre-visit history question has the MODEL already asked this call?
  // → 2 = the meds/allergy question (the later step), 1 = only duration, 0 = none.
  // Only QUESTIONS count (must end in '?'), so Ritu mentioning a medicine in
  // passing ("दवाई के बारे में डॉक्टर बताएंगे") never counts as having asked.
  _llmAlreadyAskedHistory() {
    let seen = 0;
    for (const turn of this.conversationHistory || []) {
      if (turn.role !== 'assistant' || !turn.content) continue;
      // STRIP PARENTHESISED SPECIALTY LABELS BEFORE MATCHING. HISTORY_MEDS_ASKED_RE
      // contains the English word "medicine", and brain-lean renders every roster
      // line as `${d.name} (${d.specialty})` — so Ritu's own offer
      //     "डॉ. कपिल पटवर्धन (Internal Medicine) के साथ बुक करूँ?"
      // is an assistant turn, ends in '?', and contains "Medicine". This helper
      // then reported that the model had already asked the meds/allergy question,
      // _maybeHistoryQuestion jumped _historyStage to 2, and that short-circuited
      // the stage-0 symptom gate — losing BOTH history questions, silently, with
      // no log line, because the deterministic machine never claimed a turn.
      //
      // Reachable constantly: symptomMapping makes "Internal Medicine" the
      // broadest catch-all and the live Sai Shradha roster seeds it, so it is the
      // specialty offered most often. Proven by direct execution with the LLM out
      // of the loop: same history, symptom "दो दिन से सिर में बहुत दर्द है" —
      // with "(Neurology)" the duration question is asked and stage goes to 1;
      // with "(Internal Medicine)" this returns 2 and _maybeHistoryQuestion
      // returns null.
      //
      // The '?' test runs on the STRIPPED string so a question mark living inside
      // the parentheses cannot resurrect the same bug.
      // Paren strip ONLY — deliberately NOT a `(general|internal|…) medicine`
      // word-list. That was measured to introduce a false negative on a genuine
      // "क्या कोई general medicine चल रही है?", and doctors.specialty is free
      // text (Pulmonary / Palliative / "Medicine (MD)") so a fixed list cannot
      // cover it. brain-lean always parenthesises, which covers every format
      // production actually emits.
      const t = String(turn.content).replace(/\([^)]*\)/g, ' ');
      if (!/[?？]/.test(t)) continue;
      if (HISTORY_MEDS_ASKED_RE.test(t)) return 2; // the later step wins outright
      if (HISTORY_DURATION_ASKED_RE.test(t)) seen = Math.max(seen, 1);
    }
    return seen;
  }

  // The report-intake ask: at most once per call, only after a real booking,
  // and ONLY when the intake that receives the photo is actually switched on.
  //
  // THE FLAG COUPLING IS THE POINT, not defensiveness. ENABLE_REPORT_INTAKE
  // gates reportIntake.handleInboundMedia — with it off, a patient who sends a
  // report photo has it logged and DISCARDED (reportIntake.js:23). Asking for
  // documents we would throw away is worse than never asking: the patient
  // photographs their file, sends it, gets nothing, and concludes the clinic
  // lost it. One flag, both halves.
  _maybeReportAsk() {
    if (!runtimeConfig().reportIntake) return null;
    if (!this.appointmentBooked || this._reportAskSpoken) return null;
    // No WhatsApp thread to send a photo into → the ask has nowhere to land.
    if (!this.callerPhone) return null;
    const line = cannedLine('reportAsk', { languageCode: this._langCode(), hindiInCall: this._hindiInCall });
    if (!line) return null;
    this._reportAskSpoken = true;
    return line;
  }

  // ─── DOES THE CALLER NAME A TREATMENT THIS CLINIC ACTUALLY OFFERS? ───────
  // The intake machine starts on a SYMPTOM (specialtiesForSymptom). At an
  // aesthetic clinic nobody presents a symptom: they ask about laser hair
  // removal or a hydrafacial. Measured 2026-08-25, before this existed —
  //   "सर में दर्द हो रहा है"            → intake runs
  //   "laser hair removal kitne ka hai"  → intake SKIPPED
  //   "chemical peel ke baare mein"      → intake SKIPPED
  //   "hydrafacial book karna hai"       → intake SKIPPED
  // and "skipped" means no medicine-or-allergy question before a booking. A
  // chemical peel was bookable with nobody having asked about allergies.
  //
  // Driven off the clinic's OWN treatments table rather than a keyword list, so
  // it cannot fire at a GP clinic (no rows, no match) and it needs no per-clinic
  // code. Names are matched in Latin because that is how STT returns them from
  // code-mixed speech — these are loanwords and callers say them in English
  // even mid-Gujarati. A caller who says a treatment name purely in Gujarati
  // script is NOT matched today; that is a recall gap, and it fails toward the
  // pre-existing behaviour rather than toward a wrong booking.
  _namesKnownTreatment(probe) {
    let list = [];
    // Inline require, matching the refreshTakenSlots call site: brain-lean is
    // loaded lazily here because callHandler is required from it in some paths.
    try { list = (require('./brain-lean')._treatments() || {}).treatments || []; } catch (_) { return false; }
    if (!list.length) return false;
    const hay = String(probe).toLowerCase();
    for (const t of list) {
      const name = String(t.name || '').toLowerCase().trim();
      if (name.length < 4) continue;
      if (hay.includes(name)) return true;
      // Callers shorten: "chemical peel" becomes "peel", "cryolipolysis" stays
      // whole. A single token can stand in for the name — but only a
      // DISTINCTIVE one. Length alone is not distinctiveness: "removal" is
      // seven characters and appears in two of this clinic's five treatments,
      // so it matched "laser hair removal" — a treatment that is not on the
      // list — and would match any sentence containing the word. The stoplist
      // is what makes this a treatment matcher rather than a word matcher.
      for (const tok of name.split(/\s+/)) {
        // 4, not 5: "peel" and "wart" are four characters and are exactly what
        // callers say ("peel karwana hai"). Substring matching means "peel" also
        // catches "peeling", which is the commoner phrasing.
        if (tok.length >= 4 && !GENERIC_TREATMENT_TOKENS.has(tok) && hay.includes(tok)) return true;
      }
    }
    return false;
  }

  _maybeHistoryQuestion(text) {
    if (config.clinicMode !== 'lean') return null; // scoped to the lean voice flow this feature is built for
    if (!config.previsitIntake) return null;        // booking-only clinic: no pre-visit questions (config.previsitIntake, one definition for both channels)
    if (this.appointmentBooked || this._historyStage >= 3) return null;
    // A read-back confirmation is pending (stage 2.5) — this reply resolves it.
    if (this._readbackPending) return this._resolveReadback(text);
    // A med-name repeat is pending (stage 2.6) — this reply carries the name.
    if (this._medRepeatPending) return this._resolveMedRepeat(text);
    const probe = text + ' ' + toDevanagari(text);
    const rushing = RUSH_RE.test(probe);
    if (this._historyStage === 0) {
      // SYNC WITH THE LLM (live 2026-07-25): the model asks history questions
      // on its own whenever the deterministic machine hasn't claimed the turn
      // (e.g. a symptom phrasing the lexicon missed). The machine then started
      // LATE and re-asked everything — the caller was asked "कब से?" three
      // times and the meds question twice in one call. If the model already
      // asked, adopt that stage instead of duplicating it: the caller's reply
      // now flows into the RIGHT step (a meds answer reaches the read-back
      // instead of restarting the interview).
      const asked = this._llmAlreadyAskedHistory();
      if (asked === 2) {
        this._historyStage = 2; // fall through to the stage-2 read-back below
      } else if (asked === 1) {
        if (rushing) { this._historyStage = 3; return null; }
        this._historyStage = 2;
        return HISTORY_ASK_MEDS[this._langCode()] || HISTORY_ASK_MEDS['hi-IN'];
      } else {
        // Start on a real symptom — not a name, a pure booking, or an enquiry.
        const hasSymptom = specialtiesForSymptom(probe).length > 0;
        // …or on a treatment this clinic lists. See _namesKnownTreatment.
        const hasTreatment = !hasSymptom && this._namesKnownTreatment(probe);
        if (!hasSymptom && !hasTreatment) return null;
        if (rushing) { this._historyStage = 3; return null; } // in a hurry → skip
        if (hasTreatment) {
          // NO DURATION QUESTION FOR A PROCEDURE. "यह तकलीफ़ कब से है?" asked of
          // someone enquiring about a hydrafacial is both meaningless and mildly
          // insulting — it is the wrong question, not merely an extra one. Skip
          // straight to stage 2, which is the medicine-and-allergy question, and
          // that is the one that had to be asked before a peel is booked.
          this._historyStage = 2;
          return HISTORY_ASK_MEDS[this._langCode()] || HISTORY_ASK_MEDS['hi-IN'];
        }
        this._historyStage = 1;
        return HISTORY_ASK_DURATION[this._langCode()] || HISTORY_ASK_DURATION['hi-IN'];
      }
    }
    if (this._historyStage === 1) {
      if (rushing) { this._historyStage = 3; return null; } // now rushing → stop asking
      // A REPEATED SYMPTOM IS NOT AN ANSWER TO "how long has this been going on?"
      //
      // This transition used to be unconditional: ANY reply at stage 1 consumed the
      // duration question and moved on. Live call b23c97d5 (2026-07-30, Punjabi):
      //   Ritu  "ਇਹ ਤਕਲੀਫ਼ ਕਦੋਂ ਤੋਂ ਹੈ ਜੀ?"        (how long?)
      //   caller "ਮੇਰੇ ਸਿਰ ਪੀੜ ਹੋ ਰਹੀ ਹੈ।"          (my head hurts — RESTATING, because
      //                                              the previous turn was garbled)
      //   Ritu  "ਕੋਈ ਦਵਾਈ ਚੱਲ ਰਹੀ ਹੈ...?"          (any medicines?)   ← duration lost
      //   caller "ਕੱਲ੍ਹ ਤੋਂ"                        (since yesterday)  ← lands on MEDS
      // Two failures, and the second is the worse one: the duration was never
      // captured, AND "since yesterday" is now recorded as the answer to the
      // medication question. A wrong entry in a clinical record beats a missing one.
      // Repeating yourself is the normal human response to being misheard, which is
      // exactly the situation a noisy line produces most often.
      //
      // Deliberately biased AGAINST re-asking. Over-asking is itself a documented
      // failure (the rush guard exists for it), so this fires only when the reply
      // positively looks like a symptom restatement — specialtiesForSymptom matches,
      // which duration answers never do ("दो दिन से", "ਕੱਲ੍ਹ ਤੋਂ", "दोन दिवसांपासून"
      // all score none) — and at most ONCE per call, so a caller who only ever
      // restates still reaches the medication question on the following turn.
      // A DENIAL ends the duration question rather than repeating it. Checked
      // BEFORE the restatement detector, because a denial often names the body
      // part too ("तकलीफ़ नहीं है बस मुझे अपना दांत दिखाना है" contains दांत →
      // Dental), which is exactly how it was mistaken for a restatement.
      if (HISTORY_DENIAL_RE.test(probe)) {
        console.log(`[CALL ${this.callSid}] Duration question closed — the caller denied there is a problem`);
        this._historyStage = 2;
        return HISTORY_ASK_MEDS[this._langCode()] || HISTORY_ASK_MEDS['hi-IN'];
      }
      if (!this._durationReasked && specialtiesForSymptom(probe).length > 0) {
        this._durationReasked = true;
        console.log(`[CALL ${this.callSid}] Duration re-asked — reply restated the symptom instead of answering "how long"`);
        return HISTORY_ASK_DURATION[this._langCode()] || HISTORY_ASK_DURATION['hi-IN'];
      }
      this._historyStage = 2;
      return HISTORY_ASK_MEDS[this._langCode()] || HISTORY_ASK_MEDS['hi-IN'];
    }
    // Stage 2: the meds/allergy answer just arrived. READ-BACK (S2/S5): if the
    // answer names a recognizable medicine —
    //   READBACK=shadow → LOG what Ritu would confirm (no turn inserted)
    //   READBACK=on     → SPEAK the confirmation ("Metformin — sahi?") and hold
    //                     at stage 2.5; the caller's next reply resolves it via
    //                     stepReadback (fail-open: unclear proceeds unconfirmed).
    // One read-back per call (_readbackDone) — never a confirmation loop.
    if (READBACK_MODE !== 'off' && !this._readbackDone) {
      try {
        // brands:true ONLY here — this turn is the answer to "कोई दवाई चल रही
        // है?", which is the one context where a brand-name reading is more
        // likely than a place name. Ungated the brand index false-fires at
        // 29.8% on ordinary speech (measured).
        // ALL drugs, not the best one. MEASURED on the Eka clinical corpus:
        // 786 of 814 gold mentions (96.6%) sit in utterances naming more than
        // one drug, and on identical audio findDrugMention recovers 40.3% of
        // resolvable mentions where findAllDrugMentions recovers 78.3%. The
        // function was already written, tested and exported — it was simply
        // never wired into the call path, so the phone line was capturing
        // roughly half of what the dashboard reported.
        // max:2 — see the meds2 note in readback.js for why not more.
        const _opts = { brands: true, max: 2, prior: this._priorMeds };
        // An allergen must never become a medication row. Clause-scoped, so a
        // real drug named beside an allergy still records. See ALLERGY_RE.
        const _split = _splitMedsAndAllergens(text, _opts);
        if (_split) {
          console.log(`[CALL ${this.callSid}] Allergy clause — ${_split.meds.length} medication(s), ${_split.allergens.length} allergen(s)`);
        }
        // ONLY an allergy was named. Confirm it AS an allergy rather than
        // saying nothing: readback.js has carried this copy, translated, since
        // it was written — "आपको Penicillin से एलर्जी है — सही?" — and only
        // callHandler's hard-coded type:'meds' kept it unreachable. Migration
        // 009 gives the answer somewhere to land, which is what made speaking
        // it safe; before that column a confirmed allergy still persisted as a
        // medication, which is worse than silence.
        // ─── A DRUG AND AN ALLERGY IN ONE BREATH ───────────────────────────
        // LIVE CALL 513a74cbbd1e1b71932eec755cc31a8c, 2026-08-12 06:51 IST:
        //
        //   ritu     कोई दवाई चल रही है या कोई एलर्जी है जी?
        //   patient  हाँ मैं डोलो ले रहा हूँ और मुझे पेनिसिलिन से एलर्जी है।
        //   ritu     आप Dolo ले रहे हैं — मैंने सही सुना ना?
        //   patient  हाँ जी।
        //
        // Dolo persisted. Penicillin did not. The splitter had ALREADY parsed
        // both correctly — clause 1 meds:[Paracetamol], clause 2
        // allergens:[Penicillin] — and the branch below only fires when there
        // are NO meds, so `_split.meds` was taken and `_split.allergens` fell
        // on the floor. Ritu asked one question about two things and kept the
        // answer to one of them.
        //
        // This is a DIFFERENT branch from the mid-read-back loss fixed in
        // d11cb0d, and the commoner one: the question itself names both, so
        // answering with both is what the prompt invites.
        //
        // Recorded here rather than read back, because we are about to read the
        // DRUG back and a two-part confirmation is how compound questions
        // collect one "हाँ" for two facts — the defect meds2 already documents.
        // Grade 'volunteered': the caller named it unprompted and we never got
        // to confirm it. Excluded from the matcher prior (db.js), present in the
        // record where a doctor can weigh it.
        if (_split && _split.meds.length && _split.allergens.length) {
          for (const a of _split.allergens) {
            console.log(`[CALL ${this.callSid}] Allergy named alongside a medication: "${a.canonical}" (heard "${a.surface}") — recorded, read-back goes to the drug`);
            this._persistMed({
              canonical: a.canonical, brand: a.brand || null, heardSurface: a.surface,
              resolution: 'volunteered', matchScore: a.score ?? null, viaBrand: !!a.viaBrand,
              entityType: 'allergy',
            });
          }
          this.conversationHistory.push({
            role: 'user',
            content: `[ALLERGY] Patient stated allergy: ${_split.allergens.map((a) => a.canonical).join(', ')}. Already recorded — do NOT re-ask. Continue.`,
          });
        }
        if (_split && !_split.meds.length && _split.allergens.length) {
          const a = _split.allergens[0];
          const sayA = a.brand ? a.brand.charAt(0).toUpperCase() + a.brand.slice(1) : a.canonical;
          const lineA = readbackLine('allergy', sayA, this._langCode());
          if (READBACK_MODE === 'shadow') {
            console.log(`[CALL ${this.callSid}] [READBACK-SHADOW] would confirm ALLERGY "${a.canonical}" → "${lineA}"`);
          } else {
            this._readbackPending = {
              type: 'allergy', entityType: 'allergy',
              canonical: a.canonical, surface: a.surface, brand: a.brand,
              score: a.score, viaBrand: !!a.viaBrand, second: null,
            };
            this._historyStage = 2.5;
            return lineA;
          }
          this._historyStage = 3;
          return null;
        }
        const all = _split ? _split.meds.slice(0, 2) : findAllDrugMentions(text, _opts);
        const m = all.length ? { mentioned: true, ...all[0] } : { mentioned: false };
        // The second only travels if it clears the SAME confident bar as the
        // first. A compound question doubles the acquiescence surface, so the
        // runner-up does not get to ride in on the leader's confidence.
        const m2 = all.length > 1 ? all[1] : null;
        if (m.mentioned) {
          // Speak back the caller's OWN word. Someone who said "Dolo" has
          // likely never heard "Paracetamol" — reading the molecule back would
          // read as a mistake and get denied. The molecule is what we RECORD.
          // Brand keys are lowercased in the index; capitalise for speech —
          // live 2026-07-26 Ritu said "आप dolo ले रहे हैं", which reads as a
          // typo rather than the caller's own word.
          const say = (d) => (d.brand ? d.brand.charAt(0).toUpperCase() + d.brand.slice(1) : d.canonical);
          const spoken = say(m);
          const line = m2
            ? readbackLine('meds2', spoken, this._langCode(), say(m2))
            : readbackLine('meds', spoken, this._langCode());
          if (READBACK_MODE === 'shadow') {
            console.log(`[CALL ${this.callSid}] [READBACK-SHADOW] would confirm med "${m.canonical}"${m2 ? ` + "${m2.canonical}"` : ''} (heard "${m.surface}", score ${m.score}) → "${line}"`);
          } else {
            this._readbackPending = {
              type: 'meds', canonical: m.canonical, surface: m.surface, brand: m.brand,
              score: m.score, viaBrand: !!m.viaBrand,
              // The runner-up rides along so a single affirm can record it —
              // but as its OWN row with its own resolution, never as a second
              // [VERIFIED]. See _resolveReadback.
              second: m2 ? { canonical: m2.canonical, surface: m2.surface, brand: m2.brand, score: m2.score, viaBrand: !!m2.viaBrand } : null,
            };
            this._readbackDone = true;
            console.log(`[CALL ${this.callSid}] [READBACK] confirming med "${m.canonical}"${m2 ? ` + "${m2.canonical}" (${all.length} found)` : ''} (heard "${m.surface}", score ${m.score})`);
            this._historyStage = 2.5;
            return line; // spoken as this turn's reply; LLM skipped
          }
        } else {
          // No resolvable drug — but is there a drug-LIKE token we mangled?
          // Live 2026-07-24: caller said Metformin, STT wrote "Metamorphosin"
          // (6 edits from any generic — matching can't recover it, and a
          // guessed read-back at that distance could confirm the WRONG drug).
          // Ask for just the name once; the isolated repeat resolves or the
          // med is recorded unverified for the doctor (fail-open).
          // expectIndic: in a Devanagari-script call a real drug name is a
          // Latin island inside Indic text; a mostly-Latin line means the STT
          // script-switched (measured 14.5% of Marathi utterances under
          // auto-detect) and nothing in it can be trusted as a med name.
          const lang = this._langCode();

          // RUNG 1 — DELETED 2026-07-27. It asked "क्या आप X ले रहे हैं? 1
          // दबाइए" about a match too weak to confirm at the normal 0.34 bar.
          //
          // MEASURED on the Eka corpus, on the real trigger population rather
          // than on hand-written garbles: of the 206 resolvable mentions the
          // 0.34 bar misses, the 0.47 bar recovers THREE. And in the 9 rows
          // where this rung actually fires — nothing at 0.34, something at
          // 0.47 — 0 of 9 guesses were a gold molecule of that row:
          //     triglyceride → Nitroglycerin    pneumonia → Pancuronium
          //     flavor       → Flavoxate        sclerosing → Silodosin (x3)
          // The original 6/8-catch, 0/9-junk sweep that justified it was run on
          // deliberate misspellings of drugs already in the lexicon; on real
          // decodes the trigger population is dominated by ordinary words.
          //
          // So it bought 3 mentions in 814 while inviting an agreeable caller
          // to press 1 on a wrong molecule — manufacturing the exact confident
          // false record this entire layer exists to prevent. Removing it is a
          // recall loss of ~0.4pp and a safety gain that is not measured in pp.
          // The keypad is not lost with it: rung 0 now advertises it, where the
          // match is actually confident enough to deserve a keypress.

          // RUNG 1 (was 2) — nothing close enough to even ask about. Now, and
          // only now, request the isolated name (without inviting
          // hyperarticulation).
          const u = findUnresolvedMedToken(text, {
            // Was `lang === 'hi-IN' || 'mr-IN' || 'kn-IN'` — a hand-written list
            // of three, so the guard silently switched OFF for the seven other
            // Indic-script languages, on the same turn whose copy was also
            // missing. Derived from SCRIPT_BLOCK now: any language with a
            // Brahmic block expects Indic script; en-IN maps to null and does
            // not. Adding a language can no longer forget this line.
            expectIndic: SCRIPT_BLOCK[lang] != null,
          });
          if (u) {
            if (READBACK_MODE === 'shadow') {
              console.log(`[CALL ${this.callSid}] [READBACK-SHADOW] would ask to repeat unresolved med token "${u.token}"`);
            } else {
              this._medRepeatPending = { surface: u.token };
              this._readbackDone = true; // shares the one-confirmation-per-call budget
              this._historyStage = 2.6;
              console.log(`[CALL ${this.callSid}] [READBACK] unresolved med token "${u.token}" — asking for the isolated name (last rung)`);
              return MED_NAME_REASK[this._langCode()] || MED_NAME_REASK['hi-IN'];
            }
          }
        }
      } catch (_) { /* the guard must never break the flow */ }
    }
    // A BARE "YES" IS NOT AN ANSWER — hold the meds stage open (live 2026-07-26,
    // call 56d6db79). Ritu asked "कोई दवाई चल रही है?"; the caller began "हाँ
    // वो" and Sarvam emitted that 2-token fragment on its own. It carried no
    // drug, so the stage advanced to 3 — and the REAL answer, "कोई दवाई है वो
    // Dolo और" three seconds later, arrived to a machine that had stopped
    // listening for medicines. He then said "दवाई का नाम बताया था मैंने Dolo"
    // and was ignored again. Sarvam splits ~1 turn in 6 even at its most patient
    // setting, so the split itself is not preventable here — but spending the
    // meds question on the half that contains no medicine is.
    // Affirmation-without-a-drug therefore holds the stage ONCE; a second
    // contentless turn releases it, so the interview can never stall.
    if (this._historyStage === 2 && !this._medsHeld) {
      // NOTE: no \b here. JS word boundaries are ASCII-only and NEVER match
      // beside Devanagari — the same trap that once made \bबुक\b silently dead
      // in _isBookingLikelyTurn. Anchor on whitespace-or-end instead.
      const affirms = /^(हाँ|हां|हा|जी|हो|होय|हूँ|अच्छा|ठीक|yes|yeah|haan|han|ho|ok|okay)(?=\s|$)/i
        .test(String(text || '').trim());
      // The original test was "affirmation AND <=3 words", sized to the live
      // fragment "हाँ वो". The intent eval (S12) found the natural longer
      // phrasing that slips past it: "हाँ एक दवाई चल रही है" — six words, plainly
      // an affirmation, plainly no drug named — advanced the stage, and the
      // Azithromycin the caller gave on the VERY NEXT turn was dropped.
      //
      // Word count was always a proxy for the real question, which is simply:
      // did they affirm WITHOUT naming a medicine we can resolve? Ask that
      // instead. brands:true because this is the meds turn, the one context
      // where the brand index is trusted.
      const namesADrug = findAllDrugMentions(text, { brands: true, max: 1, prior: this._priorMeds }).length > 0;
      if (affirms && !namesADrug) {
        this._medsHeld = true;
        console.log(`[CALL ${this.callSid}] [READBACK] ${speech(text)} affirms without naming a medicine — holding the meds stage for the name`);
        return null; // no new question; the caller is mid-answer
      }
    }
    this._historyStage = 3;
    return null;
  }

  // Resolve a pending med-name repeat (stage 2.6). If the isolated repeat now
  // matches a generic → escalate to the normal read-back confirmation (stage
  // 2.5). If it still doesn't resolve → record what was heard, marked
  // unverified, and move on — the doctor sees the raw surface and the
  // stereoscopic second pass gets a crack at the recording. Never loops.
  _resolveMedRepeat(text) {
    const prev = this._medRepeatPending;
    this._medRepeatPending = null;
    this._historyStage = 3;
    try {
      const m = findDrugMention(text, { brands: true, prior: this._priorMeds }); // the caller is repeating a MEDICINE name
      if (m.mentioned) {
        this._readbackPending = { type: 'meds', canonical: m.canonical, surface: m.surface, brand: m.brand, score: m.score, viaBrand: !!m.viaBrand };
        this._historyStage = 2.5;
        console.log(`[CALL ${this.callSid}] [READBACK] repeat resolved "${m.canonical}" (heard "${m.surface}", score ${m.score}) — confirming`);
        return readbackLine('meds', m.brand ? m.brand.charAt(0).toUpperCase() + m.brand.slice(1) : m.canonical, this._langCode());
      }
      // A denial ("I am not on any medicine" / "koi dawai nahi") means the
      // flagged token was noise, not a mangled drug — record a clean no-meds,
      // NOT an unverified-medication flag (live 2026-07-24: "twelve" was
      // recorded as an unverified med even after the caller denied taking
      // anything).
      if (classifyReply(text).verdict === 'deny') {
        console.log(`[CALL ${this.callSid}] [READBACK] repeat was a denial — recording no medications (token "${prev && prev.surface}" was noise)`);
        this.conversationHistory.push({ role: 'user', content: '[VERIFIED] Patient confirmed they are NOT on any regular medication.' });
        return null;
      }
    } catch (_) { /* fail-open below */ }
    console.log(`[CALL ${this.callSid}] [READBACK-UNRESOLVED] med heard as "${prev && prev.surface}", repeat "${String(text || '').slice(0, 60)}" — recorded unverified (fail-open)`);
    // Persisted too, as resolution='unverified'. "We heard something drug-shaped
    // and could not confirm it" is genuinely useful to a doctor — it is a
    // prompt to ask — but it must be stored as clearly NOT confirmed, never
    // mixed in with the affirmed rows. canonical carries the heard surface
    // because that is honestly all we know here.
    if (prev && prev.surface) {
      // No match_score and no brand on purpose: this rung fires precisely
      // BECAUSE nothing resolved, so there is no score to record. A NULL here
      // is the honest value and distinguishes these rows at a glance.
      this._persistMed({
        canonical: String(prev.surface),
        heardSurface: String(prev.surface),
        resolution: 'unverified',
      });
    }
    this.conversationHistory.push({ role: 'user', content: `[UNVERIFIED] Patient takes a medication heard as "${prev && prev.surface}" — name could not be confirmed on the call; flag for doctor review.` });
    return null; // let the LLM acknowledge naturally next turn
  }

  // Write one medication row (migration 007). Fire-and-forget by design: every
  // caller of this sits on the critical path between the caller finishing a
  // sentence and Ritu starting the next one, and a slow or down database must
  // cost a caller exactly nothing. saveConfirmedMedication already swallows and
  // logs its own errors; the .catch here covers the case where the module
  // itself throws synchronously.
  //
  // patient_id is intentionally left NULL. upsertPatient only runs at booking
  // (line ~3405) and the meds turn happens BEFORE that, so there is often no
  // patient row yet. (clinic_id, phone) is the join key that always exists —
  // it is the same key checkReturningPatient uses — and migration 007 indexes
  // it for exactly this reason. Backfilling patient_id later is a UPDATE;
  // inventing a patient row here would create duplicates for every caller who
  // asks about medicines and then hangs up without booking.
  _persistMed(med) {
    try {
      saveConfirmedMedication({
        ...med,
        phone: this.callerPhone,
        callSid: this.callSid,
        language: this._langCode(),
        turnOffsetMs: Date.now() - this.startTime,
      }).catch((e) => console.error(`[CALL ${this.callSid}] med persist failed:`, e.message));
    } catch (e) {
      console.error(`[CALL ${this.callSid}] med persist threw:`, e.message);
    }
  }

  // Resolve a pending med read-back from the caller's reply (voice transcript
  // or DTMF '1'/'2'). Records the verified entity into the LLM context + call
  // state so the summary carries the CONFIRMED form, not the raw STT guess.
  // ─── THE ACOUSTIC SUMMARY, AS A METHOD SO IT CAN BE TESTED ────────────────
  // This began as an inline IIFE inside the diagnostics literal, and a mutation
  // exposed why that was the wrong shape: relaxing the zero-floor guard to
  // `floorP50 >= 0` produces Infinity, and JSON.stringify(Infinity) is null — so
  // a test that reads the PERSISTED row cannot tell a guarded null from an
  // unguarded Infinity. The bug is invisible through serialisation and visible
  // here. Anything that must be checked deserves a name.
  //
  // floor  = chunks with NEITHER party speaking: the caller's room and the line.
  // speech = per-turn peak RMS, one entry per finished turn.
  // snrDb  = 20·log10(speech ÷ floor), the ordinary definition, in dB so it is
  //          comparable across calls and across handsets.
  //
  // NULLS, NEVER ZEROS, and never a ratio we did not actually measure.
  _audioSummary() {
    const f = this._rmsFloor || [], sp = this._rmsSpeech || [];
    const pct = (a, p) => (a.length ? this._percentile(a.slice().sort((x, y) => x - y), p) : null);
    const floorP50 = pct(f, 50), speechP50 = pct(sp, 50);
    const measurable = floorP50 !== null && speechP50 !== null && floorP50 > 0 && speechP50 > 0;
    return {
      floorP50, floorP90: pct(f, 90),
      speechP50, speechP10: pct(sp, 10),
      snrDb: measurable ? Math.round(20 * Math.log10(speechP50 / floorP50) * 10) / 10 : null,
      floorSamples: f.length, speechTurns: sp.length,
    };
  }

  _resolveReadback(replyText) {
    const pending = this._readbackPending;
    this._readbackPending = null;
    this._historyStage = 3;
    const r = stepReadback(pending, replyText);
    if (r.verified && r.med) {
      (this.confirmedMeds = this.confirmedMeds || []).push(r.med);
      // [READBACK-GOLD] = the flywheel's harvest line: a caller-verified
      // (audio → drug) label, the self-liquidating gold loop (S5).
      // @<ms> = offset from call start, so the exact turn can be located in the
      // Exotel recording later. Without it a confirmed pair can never be tied
      // back to its audio — and audio you didn't point at is unrecoverable.
      // A weak-match confirmation is real evidence but WEAKER evidence: the
      // caller agreed to our guess rather than naming the drug themselves. The
      // corpus records which, so a future analysis can weight or exclude them.
      let res = (pending && pending.weak && r.resolution === 'affirmed') ? 'affirmed-weak' : r.resolution;

      // ─── WHO SAID "हाँ"? ────────────────────────────────────────────────
      // We cannot know. Sarvam documents diarization as unavailable on this
      // socket (batch only), on v3 AND v4 — it is a property of the endpoint,
      // not the model, so no model switch fixes it. On an Indian clinic call
      // a relative is often on the line, and a bare affirm from an
      // unidentified voice was being promoted to [READBACK-GOLD]: a training
      // LABEL, not merely a record. A bystander's agreement was teaching the
      // system.
      //
      // Two different questions were being answered by one signal:
      //   "good enough to write in the record?"   — yes; someone on a medical
      //      call agreed to a molecule we heard. Refusing bare affirms would
      //      gut capture, because most people just say "हाँ".
      //   "good enough to TRAIN on?"              — no. Gold data should be
      //      the cases where the caller said something of their own.
      // So the medication is still persisted; only the harvest line is gated.
      const bareAffirm = r.affirmStrength === 'bare';
      if (bareAffirm && res === 'affirmed') res = 'affirmed-bare';

      // Turn-peak RMS is logged, NOT acted on. A bystander further from the
      // handset should be quieter, but we have never measured that and a
      // threshold invented here would be exactly the guessed-vendor-parameter
      // mistake this repo has a gate against. Recording it now means a future
      // analysis can test whether loudness discriminates — on real data,
      // rather than on my intuition.
      const rms = Math.round(this._lastTurnPeakRms || 0);
      if (bareAffirm) {
        console.log(`[CALL ${this.callSid}] [READBACK] bare affirm — recorded, NOT harvested as gold (rms=${rms})`);
      } else {
        console.log(`[CALL ${this.callSid}] [READBACK-GOLD] med ${res}: "${r.med}" (heard "${pending && pending.surface}") rms=${rms} @${Date.now() - this.startTime}ms`);
      }
      // PERSIST IT (migration 007). Until 2026-07-27 the line above was the ONLY
      // durable trace of a caller-verified drug — confirmedMeds was written here
      // and read nowhere, so every accuracy point the matcher earned was
      // multiplied by zero at the record. Fire-and-forget: this runs between the
      // caller's "haan" and Ritu's next sentence, so it must never be able to
      // add a turn of dead air. On failure the log line still carries it, which
      // is exactly what we had before.
      // On a CORRECTION, brand/score/viaBrand describe the drug we got WRONG —
      // they belong to the proposal the caller just rejected, not to what they
      // said instead. The first production row proved it: canonical=Cetirizine
      // with brand='dolo', which reads as "the patient's Cetirizine is branded
      // Dolo". A doctor would believe that. Only heard_surface survives, and
      // only because its documented job is tracing a record back to the string
      // that caused it — here, the surface we misheard.
      const corrected = r.resolution === 'corrected';
      this._persistMed({
        canonical: r.med,
        brand: corrected ? null : (pending && pending.brand),
        heardSurface: pending && pending.surface,
        resolution: res,
        matchScore: corrected ? null : (pending && pending.score),
        viaBrand: corrected ? false : !!(pending && pending.viaBrand),
      });
      // The SECOND drug from a compound read-back ("आप Dolo और Telma ले रहे हैं
      // — सही?"). Recorded only on a clean affirm, and with its own resolution
      // 'affirmed-compound', never as a second [VERIFIED]. One "हाँ" answering
      // a two-part question is genuinely weaker evidence than one "हाँ"
      // answering a one-part question — that is the documented compound-question
      // defect, and the honest place to record it is the row, not a comment.
      // A CORRECTION voids it: if the caller denied and named a different drug,
      // they were not agreeing to our list at all.
      if (r.med2 && r.med2 !== r.med) {
        // Two sources, two strengths:
        //   affirmed  → one "हाँ" covered a two-part question we asked. Real
        //               evidence, but weaker — recorded 'affirmed-compound'.
        //   corrected → the caller NAMED it themselves while correcting us
        //               ("नहीं नहीं Dolo और Cetirizine"). That is the strongest
        //               evidence this layer can get, so it is not downgraded.
        const isAffirm = r.resolution === 'affirmed';
        const s = (isAffirm && pending && pending.second) ? pending.second : null;
        const res2 = isAffirm ? 'affirmed-compound' : 'corrected';
        console.log(`[CALL ${this.callSid}] [READBACK-GOLD] med ${res2}: "${r.med2}"${s ? ` (heard "${s.surface}")` : ' (named in the correction)'} @${Date.now() - this.startTime}ms`);
        this._persistMed({
          canonical: r.med2,
          brand: s ? s.brand : null,
          heardSurface: s ? s.surface : (pending && pending.surface) || null,
          resolution: res2,
          matchScore: s ? s.score : null,
          viaBrand: !!(s && s.viaBrand),
        });
        this.conversationHistory.push({ role: 'user', content: `[VERIFIED-2] Patient also confirmed medication: ${r.med2}. Continue.` });
      }
      this.conversationHistory.push({ role: 'user', content: `[VERIFIED] Patient confirmed medication: ${r.med}. Continue.` });
      return null; // let the LLM acknowledge naturally next turn
    }
    if (r.reAsk) {
      console.log(`[CALL ${this.callSid}] [READBACK] denied without correction — re-asking meds once`);
      return HISTORY_ASK_MEDS[this._langCode()] || HISTORY_ASK_MEDS['hi-IN'];
    }
    // UNCLEAR — but do NOT slam the door (live 2026-07-26, call c819da07).
    // Ritu asked "Dolo — सही सुना ना?" while the caller was still finishing
    // "...650"; that continuation arrived as the answer, classified unclear,
    // and cleared the pending read-back. The caller pressed 1 nineteen seconds
    // later and it was ignored — nothing was listening any more.
    // So voice control returns to the normal flow immediately (the turn is NOT
    // swallowed — we return null), while the DTMF window stays open for a
    // while longer. A keypad press is the rung that exists for exactly this
    // situation: a line too messy for speech to settle the question.
    this._readbackDtmfPending = { ...pending, since: Date.now() };
    console.log(`[CALL ${this.callSid}] [READBACK] unresolved (${r.resolution}) — proceeding unconfirmed (fail-open); DTMF 1/2 still accepted for ${Math.round(READBACK_DTMF_GRACE_MS / 1000)}s`);

    // ─── THE REPLY IS NOT ONLY AN ANSWER. IT MAY BE NEW HISTORY. ───────────
    // LIVE CALL db712d3d18a43011e70104acd9d81a8b, 2026-08-11 09:52 IST:
    //
    //   patient  हाँ दवाई तो डोलो ले रहा हूँ।
    //   Ritu     आप Dolo ले रहे हैं — मैंने सही सुना ना?
    //   patient  और मुझे पेनिसिलिन से एलर्जी है।        <- 2.7s later
    //   Ritu     जानकारी के लिए शुक्रिया।
    //
    // Two clinical facts, volunteered, both in calls.reason — and
    // patient_medications got NOTHING. The allergy sentence arrived as the
    // reply to the Dolo read-back, classified 'unclear' (it is neither a yes
    // nor a correction), and _maybeHistoryQuestion returns at the read-back
    // branch BEFORE the clause splitter at stage 2 ever runs. So the one turn
    // where the caller named an allergy was the one turn that could not see it.
    //
    // Answering a question with a new fact instead of "हाँ" is ordinary speech,
    // not an edge case. This runs the same clause-scoped splitter the meds turn
    // uses, on the text that was about to be discarded.
    //
    // NO SECOND READ-BACK. We are already inside one, _readbackDone is set, and
    // a confirmation loop is worse than an unconfirmed row. These are recorded
    // at their honest grade instead: 'volunteered' — the caller said it
    // unprompted and we never got to confirm it. An unconfirmed ALLERGY in the
    // record makes a doctor ask; a missing one makes them not ask, and that
    // asymmetry is the whole reason to keep it.
    try {
      const split = _splitMedsAndAllergens(replyText, { brands: true, max: 2, prior: this._priorMeds });
      if (split && split.allergens.length) {
        for (const a of split.allergens) {
          console.log(`[CALL ${this.callSid}] [READBACK] allergy volunteered mid-read-back: "${a.canonical}" (heard "${a.surface}") — recorded unconfirmed`);
          this._persistMed({
            canonical: a.canonical, brand: a.brand || null, heardSurface: a.surface,
            resolution: 'volunteered', matchScore: a.score ?? null, viaBrand: !!a.viaBrand,
            entityType: 'allergy',
          });
        }
        // Tell the model, so the summary carries it and Ritu does not re-ask.
        this.conversationHistory.push({
          role: 'user',
          content: `[ALLERGY] Patient volunteered allergy: ${split.allergens.map((a) => a.canonical).join(', ')}. Acknowledge briefly; do NOT re-ask. Continue.`,
        });
      }
    } catch (e) {
      // Never let capture cost a turn of dead air — the same rule _persistMed
      // follows. A lost row is bad; a silent line is worse.
      console.error(`[CALL ${this.callSid}] mid-read-back capture failed:`, e.message);
    }
    return null;
  }

  // A booking just committed. Ritu had already SPOKEN the resolved slot in the
  // question the caller said yes to ("...आज शाम 7 बजे... बुक करूँ?"), so the
  // booking IS a caller-confirmed read-back of the datetime — it was simply
  // never recorded. Emit the gold pair now: what the human said → what we
  // committed. No turn added, no latency, and it fires on EVERY booking rather
  // than the ~5% of calls that mention a medicine.
  _recordDatetimeGold() {
    try {
      const expr = this._lastTimeExpr && this._lastTimeExpr.expression;
      if (!expr || !this.appointmentTime) return;
      const iso = new Date(this.appointmentTime);
      if (isNaN(iso.getTime())) return;
      console.log(`[CALL ${this.callSid}] [READBACK-GOLD] datetime affirmed: "${iso.toISOString()}" (heard "${expr}") @${this._lastTimeExpr.atMs}ms`);
    } catch (_) { /* instrumentation must never break a booking */ }
  }

  // DTMF resolution for the read-back turn: 1 = yes, 2 = no. Wired from the
  // Exotel dtmf event (index.js) — digits survive lines that garble speech.
  onDtmf(digit) {
    if (this._ended) return;
    // A keypress after the voice answer came back unclear still counts, inside
    // the grace window — see the note in _resolveReadback.
    if (!this._readbackPending && this._readbackDtmfPending) {
      const p = this._readbackDtmfPending;
      if (Date.now() - p.since <= READBACK_DTMF_GRACE_MS) {
        this._readbackDtmfPending = null;
        this._readbackPending = { type: p.type, canonical: p.canonical, surface: p.surface, brand: p.brand, score: p.score, viaBrand: !!p.viaBrand };
        console.log(`[CALL ${this.callSid}] [READBACK] DTMF ${digit} arrived after an unclear voice answer — honoring it`);
      } else {
        this._readbackDtmfPending = null;
      }
    }
    if (!this._readbackPending) return;
    console.log(`[CALL ${this.callSid}] [READBACK] DTMF ${digit} received for pending confirmation`);
    const line = this._resolveReadback(String(digit));
    const ack = line || null;
    if (ack) { this._processingChain = (this._processingChain || Promise.resolve()).then(() => this._sayDeterministic(ack)).catch(() => {}); }
  }

  _startSilenceTimer() {
    this._clearSilenceTimers();
    this._silenceTimer = setTimeout(() => {
      if (this._ended || this.isSpeaking || this.shouldEndCall) return;
      console.log(`[CALL ${this.callSid}] Silence timeout: prompting patient`);
      const silencePrompts = SILENCE_PROMPTS[this._langCode()] || SILENCE_PROMPTS['hi-IN'];
      const silenceLine = silencePrompts[(this._silencePromptIdx++) % silencePrompts.length];
      // The hangup countdown is armed in onRituDone (when THIS prompt finishes
      // playing), NOT here: onRituDone used to _resetSilenceTimer and clear any
      // hangup timer, so the hangup never fired and prompts looped forever.
      this._awaitingSilenceHangup = true;
      this._processingChain = this._processingChain
        .then(() => this._sayDeterministic(silenceLine))
        .catch(() => {});
    }, SILENCE_WARN_MS);
  }

  // Armed after a silence prompt finishes playing (from onRituDone). If the
  // caller stays quiet through the remaining window, say the busy-goodbye + end.
  _armSilenceHangup() {
    this._clearSilenceTimers();
    this._silenceHangupTimer = setTimeout(() => {
      if (this._ended || this.shouldEndCall) return;
      console.log(`[CALL ${this.callSid}] Silence hangup: no response after ${SILENCE_HANGUP_MS}ms`);
      this._endTrigger = this._endTrigger || 'silence_hangup';
      this.shouldEndCall = true;
      this._processingChain = this._processingChain
        .then(() => this._sayDeterministic(BUSY_GOODBYE[this._langCode()] || BUSY_GOODBYE['hi-IN']))
        .catch(() => {});
    }, SILENCE_HANGUP_MS - SILENCE_WARN_MS);
  }

  _resetSilenceTimer() {
    this._awaitingSilenceHangup = false; // caller activity → not awaiting hangup
    this._clearSilenceTimers();
    this._startSilenceTimer();
  }

  _clearSilenceTimers() {
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    if (this._silenceHangupTimer) { clearTimeout(this._silenceHangupTimer); this._silenceHangupTimer = null; }
  }

  // ─── EMERGENCY HANDLER (deterministic keyword path) ─────────────────────────
  // Fired from _onTranscript when emergencyDetector matches a transcript.
  // Bypasses the LLM entirely. Cancels any in-flight TTS, plays the cached
  // emergency message, fires the ritu_end_call mark to terminate the call,
  // and fire-and-forget alerts n8n so clinic staff get notified.
  //
  // Idempotent via this._emergencyTriggered — repeat detections during the
  // cancellation/playback window are no-ops.
  async handleEmergency(detection, sttLang) {
    if (this._emergencyTriggered || this._ended) return;
    this._emergencyTriggered = true;
    this._cancelSpeculation('emergency');
    this._cancelCompletionSpec('emergency');

    console.error(`[EMERGENCY] DETECTED type=${detection.type} match="${detection.matched}" callSid=${this.callSid} caller=${maskPhone(this.callerPhone)}`);

    // 1. Cancel anything in flight so the patient doesn't hear a stale
    //    response on top of the emergency message.
    if (this.isSpeaking) {
      this._clearAudio();
      if (this._activeTTS && typeof this._activeTTS.abort === 'function') {
        this._activeTTS.abort();
      }
      this.isSpeaking = false;
    }
    // Invalidate any in-flight LLM turn — processIntent will discard the
    // result when it returns.
    this._generationId++;
    // Cancel any pending debounce so a queued transcript can't fire after.
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    this._pendingTranscript = '';
    this._clearSilenceTimers();

    // 2. Mark state for the call record + the end-call path.
    this.emergencyDetected = true;
    this.bookingFailureReason = `Emergency (deterministic: ${detection.type})`;
    this._endTrigger = this._endTrigger || 'emergency_end';
    this.shouldEndCall = true;
    this.conversationPhase = 'wrapup';
    this.transcript.push({
      role: 'system',
      text: `EMERGENCY_DETECTED type=${detection.type} match="${detection.matched}"`,
      time: new Date().toISOString()
    });

    // 3. Fire-and-forget alert to n8n (clinic ops can route this to staff).
    //    Not for OncoReady intake: that patient is not this clinic's caller. The
    //    spoken emergency line still plays; OncoReady gets emergency:true.
    if (config.n8n.webhookUrl && !this.intake) {
      axios.post(config.n8n.webhookUrl, {
        type: 'emergency',
        emergencyType: detection.type,
        matched: detection.matched,
        callSid: this.callSid,
        callerPhone: this.callerPhone,
        patientName: this.patientName || null,
        timestamp: new Date().toISOString()
      }, { timeout: 3000 }).catch(() => {});
    }

    // 4. Play the cached emergency audio. If pre-cache failed at startup,
    //    fall back to live TTS — slower but better than silence.
    try {
      // Answer in the language the patient just SPOKE, not the call's locked
      // language. The emergency detector fires on the raw utterance before the
      // language pin runs, so a returning patient greeted in Marathi who shouts
      // a Hindi "साँस नहीं आ रही" must hear the 108 line in Hindi — the STT
      // already told us (language_code=hi-IN). Order: spoken lang → locked lang
      // → hi-IN. Emergency text exists in all 11; audio is pre-cached hi/mr only,
      // others fall through to the live-TTS path (correct language, ~1s slower).
      // Self-harm routes to the mental-health helpline text, not the 108 line.
      const isSelfHarm = detection.type === 'self_harm';
      const TEXTS = isSelfHarm ? SELF_HARM_TEXTS : EMERGENCY_TEXTS;
      const spokenLang = sttLang && sttLang !== 'unknown' && TEXTS[sttLang] ? sttLang : null;
      const emLang = spokenLang || (TEXTS[this._langCode()] ? this._langCode() : 'hi-IN');
      const emText = TEXTS[emLang];
      // Self-harm text is not pre-cached (rare) → live TTS via the fallback path.
      const emAudio = isSelfHarm ? null : EMERGENCY_AUDIO[emLang];
      this.transcript.push({ role: 'ritu', text: emText, time: new Date().toISOString() });
      this.isSpeaking = true;
      this._lastRituText = emText;
      if (emAudio) {
        console.log(`[CALL ${this.callSid}] Playing cached emergency audio (${emLang}, ${emAudio.length} bytes)`);
        this._sendAudioBuffer(emAudio);
        this._sendSilence(200);
        this._sendMark('ritu_end_call');
      } else {
        console.warn(`[CALL ${this.callSid}] Emergency audio not cached (${emLang}) — falling back to live TTS`);
        await this.speak(emText); // speak() respects shouldEndCall and emits ritu_end_call
      }
    } catch (err) {
      console.error(`[CALL ${this.callSid}] Failed to play emergency audio:`, err.message);
      // Even if audio fails, force the call to end so the patient can dial 108.
      this._sendMark('ritu_end_call');
    }
  }

  // ─── CRITICAL ERROR HANDLER ─────────────────────────────────────────────────

  async handleCriticalError(error) {
    console.error(`[CALL ${this.callSid}] CRITICAL:`, error.message || error);
    if (config.n8n.webhookUrl) {
      axios.post(config.n8n.webhookUrl, {
        type: 'error',
        error: error.message || String(error),
        callSid: this.callSid,
        callerPhone: this.callerPhone,
        timestamp: new Date().toISOString()
      }, { timeout: 3000 }).catch(() => {});
    }
    try {
      await this.speak(CRITICAL_ERROR_MESSAGE[this._langCode()] || CRITICAL_ERROR_MESSAGE['hi-IN']);
    } catch (e) {
      console.error(`[CALL ${this.callSid}] Failed to speak error message:`, e.message);
    }
  }

  // ─── END CALL ──────────────────────────────────────────────────────────────
  // To hang up on Exotel: close the WebSocket. The App Builder flow then
  // advances to the next applet (Passthru → Hangup). No REST call needed.

  // ─── ONCOREADY PRE-VISIT INTAKE (see oncoreadyIntake.js) ──────────────────
  // Born pinned to the language OncoReady asked for, like FORCE_LANG but per
  // session. The opening line comes from the model so it can be in any of the
  // eleven languages without eleven hand-written templates.
  async _startIntake() {
    try {
      const lang = this.intake.language;
      console.log(`[CALL ${this.callSid}] OncoReady intake session started (${lang})`);
      this._langPinned = true;
      this.callLanguage = lang;
      this.languageDetected = config.languageNames[lang] || this.languageDetected;
      this.patientName = this.intake.patientName || null;
      this.conversationPhase = 'intake';
      this._intakeSystem = oncoready.buildIntakePrompt(this.intake, config.languageNames[lang] || 'English');
      this._intakeDeadline = setTimeout(() => {
        console.log(`[CALL ${this.callSid}] Intake session reached its ${this.intake.maxDurationS}s limit`);
        this._endTrigger = this._endTrigger || 'max_duration';
        this.endCall().catch(() => {});
      }, this.intake.maxDurationS * 1000);
      if (this._intakeDeadline.unref) this._intakeDeadline.unref();

      this.stt = createStreamingSTT(
        (text, meta) => this._onTranscript(text, meta),
        () => this._onSpeechStart(),
        () => this._onSpeechEnd(),
        { languageCode: lang === 'mr-IN' ? 'hi-IN' : lang } // mr shares the hi-IN session, as with FORCE_LANG
      );
      prewarmPrimary();

      this.conversationHistory.push({ role: 'user', content: oncoready.OPENING_INSTRUCTION });
      // A failed first generation must not cost the session: fall back to a
      // canned opening and let the next turn try the model again.
      let reply = { text: '', endCall: false };
      try { reply = await this._intakeReply(); } catch (err) {
        console.warn(`[CALL ${this.callSid}] Intake opening generation failed (${err.message}) — canned opening`);
      }
      const { text, endCall } = reply;
      const opening = text || (lang === 'hi-IN'
        ? 'नमस्ते! डॉक्टर से मिलने से पहले मैं आपसे कुछ सवाल पूछूँगी। अभी आपको क्या तकलीफ़ हो रही है?'
        : 'Hello! I will ask you a few questions for your doctor before the visit. What problems are you having right now?');
      if (endCall) this.shouldEndCall = true;
      await this._sayDeterministic(opening); // records it in history, then speaks (the chokepoint rule)
    } catch (error) {
      await this.handleCriticalError(error);
    }
  }

  async _intakeReply() {
    const t0 = Date.now();
    const response = await intakeComplete(
      [{ role: 'system', content: this._intakeSystem }, ...this.conversationHistory],
      { temperature: 0.4, maxTokens: 220 }
    );
    this._llmMs.push(Date.now() - t0);
    this._recordLlmUsage(response.usage);
    return oncoready.parseReply(response.content);
  }

  async _processIntakeTurn(userText) {
    const myGen = this._generationId;
    const { text, endCall } = await this._intakeReply();
    if (myGen !== this._generationId) {
      console.log(`[CALL ${this.callSid}] Discarding stale intake reply (gen ${myGen} → ${this._generationId})`);
      return;
    }
    if (this._emergencyTriggered) return; // handleEmergency owns the audio now
    if (endCall) {
      this._endTrigger = this._endTrigger || 'llm_end_call';
      this.shouldEndCall = true;
      this.conversationPhase = 'wrapup';
    }
    if (!text) {
      if (endCall) this._sendMark('ritu_end_call'); // nothing left to say, still close cleanly
      return;
    }
    this.conversationHistory.push({ role: 'assistant', content: text });
    this._trimHistory();
    await this.speak(text);
  }

  _sendIntakeResult() {
    if (this._intakeDeadline) clearTimeout(this._intakeDeadline);
    const result = oncoready.buildResult(this.intake, {
      transcript: this.transcript,
      startedAt: this.startTime,
      endedAt: Date.now(),
      endTrigger: this._endTrigger,
      criticalErrors: this._criticalErrors,
      emergency: this._emergencyTriggered || this.emergencyDetected,
    });
    oncoready.postResult(this.intake, result).catch(() => {}); // never throws; logged inside
  }

  async endCall() {
    if ((this._rosterBrainTurns || 0) > (this._llmTurns || 0)) {
      console.warn(`[CALL ${this.callSid}] ⚠ cost meter: ${this._rosterBrainTurns} brain requests but ${this._llmTurns} metered LLM turns — a request path is not reporting usage`);
    }
    if (this._ended) return;
    this._ended = true;
    try {
      console.log(`[CALL ${this.callSid}] Ending call...`);

      // ─── A DRUG THE CALLER NAMED, NEVER WRITTEN DOWN ─────────────────────
      // The unclear branch of _resolveReadback logs "proceeding unconfirmed
      // (fail-open)" and, until now, persisted nothing at all — so "unconfirmed"
      // meant "discarded". LIVE CALL db712d3d, 2026-08-11: the caller said "दवाई
      // तो डोलो ले रहा हूँ", Ritu read Dolo back, the caller answered with an
      // allergy instead of "हाँ", and patient_medications got nothing. The drug
      // is in calls.reason, visible to nobody who reads the medical record.
      //
      // WHY HERE AND NOT AT THE UNCLEAR MOMENT. The DTMF grace window can still
      // reopen the read-back for READBACK_DTMF_GRACE_MS and resolve it properly
      // (onDtmf above), which would write a second, contradicting row for the
      // same molecule. Waiting until the call is over means exactly one row:
      // this fires only if _readbackDtmfPending survived, i.e. nothing ever
      // resolved it.
      //
      // Graded 'unconfirmed', and getPatientMedications excludes that grade from
      // the matcher prior — a drug we never confirmed must not go on to make the
      // matcher hear itself on the next call. It is honest in the record and
      // inert in the loop.
      if (this._readbackDtmfPending) {
        const p = this._readbackDtmfPending;
        this._readbackDtmfPending = null;
        console.log(`[CALL ${this.callSid}] [READBACK] never resolved — recording "${p.canonical}" unconfirmed (heard "${p.surface}")`);
        this._persistMed({
          canonical: p.canonical, brand: p.brand || null, heardSurface: p.surface,
          resolution: 'unconfirmed', matchScore: p.score ?? null, viaBrand: !!p.viaBrand,
          entityType: p.entityType === 'allergy' ? 'allergy' : 'medication',
        });
      }

      this._clearSilenceTimers();
      this._cancelSpeculation('call ended');
      this._cancelCompletionSpec('call ended');
      discardTTSPrewarm(); // don't leave an unclaimed socket idling at Sarvam
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
      if (this.stt) { this.stt.close(); this.stt = null; }

      const durationSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      this.durationSeconds = durationSeconds;

      // ── WHY THIS CALL ENDED ──────────────────────────────────────────────
      // Was: two strings chosen by `shouldEndCall`, which collapsed a happy
      // goodbye, a silence timeout and our own redeploy into the same record.
      // classifyCall is pure and cannot throw (tests/test-call-outcome.js), but
      // it is wrapped anyway — nothing about diagnostics may break a call.
      let verdict = { outcome: null, reason: null };
      try {
        verdict = classifyCall({
          appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
          emergencyDetected: this.emergencyDetected,
          endTrigger: this._endTrigger,
          bookFailKind: this._bookFailKind,
          // Patient turns come from the transcript that already exists — no
          // separate counter to drift out of sync with it.
          patientTurns: (this.transcript || []).filter(t => t && t.role === 'patient').length,
          dropped: this._droppedUtterances,
          criticalErrors: this._criticalErrors,
        });
      } catch (err) {
        console.error(`[CALL ${this.callSid}] classifyCall threw (call unaffected):`, err.message);
      }
      this.outcome = verdict.outcome || undefined;
      this.notBookedReason = verdict.reason || undefined;

      if (!this.appointmentBooked && !this.bookingFailureReason) {
         // Keep the legacy free-text field populated for anything still reading
         // it, but say something true now that we know which case it is.
         const lbl = REASON_LABEL[verdict.reason];
         this.bookingFailureReason = (lbl && lbl.en) || 'Unclassified';
      }

      if (this.patientName && this.callerPhone && !this.intake) {
        upsertPatient(this.callerPhone, this.patientName).catch(e => console.error('DB Upsert Error:', e.message));
      }

      // Computed ONCE — it walks the whole conversation, and both the stored
      // row and the CALLSUM log line need it. Calling the audit twice was
      // caught by its own test, which asserts exactly one invocation because
      // "shadow" means observed once at call end, never on the reply path.
      const drift = this._symptomDriftAudit();

      if (this.intake) {
        this._sendIntakeResult(); // OncoReady's record, not the clinic's call log / Sheet / WhatsApp
      } else logCall({
        callSid: this.callSid,
        callerPhone: this.callerPhone,
        callSource: this.callSource,
        patientName: this.patientName || 'Unknown',
        reason: this.reason || 'Unknown',
        appointmentTime: this.appointmentTime,
        appointmentId: this.appointmentId,
        appointmentBooked: this.appointmentBooked,
      bookedThisCall: this._bookedThisCall,
      driftReasked: this._driftReasked,
        durationSeconds: this.durationSeconds,
        isReturning: this.isReturning,
        languageDetected: this.languageDetected,
        doctorName: this.doctorName,
        bookingFailureReason: this.bookingFailureReason,
        slotAttempts: this.slotAttempts,
        conversionTimeSec: this.conversionTimeSec,
        emergencyDetected: this.emergencyDetected,
        outcome: this.outcome,
        notBookedReason: this.notBookedReason,
        // The signals the classification rested on. Stored so a surprising
        // reason can be interrogated later instead of taken on trust — and so
        // "37% couldn't_hear" can be followed by "and here is how quiet those
        // lines were". Every one of these was already computed and discarded.
        diagnostics: {
          endTrigger: this._endTrigger || null,
          patientTurns: (this.transcript || []).filter(t => t && t.role === 'patient').length,
          rituTurns: (this.transcript || []).filter(t => t && t.role === 'ritu').length,
          dropped: this._droppedUtterances,
          garbleReprompts: this._garbleReprompts,
          criticalErrors: this._criticalErrors,
          bookFailKind: this._bookFailKind || null,
          // WAS `this.callLanguage`, which read NULL on every one of the first
          // six real calls while calls.language said "Hindi" — because the
          // field's own comment two thousand lines up says the single source is
          // _langCode(), never the raw field. So the diagnostic reported
          // "unpinned" for calls that were pinned, and, worse, could not tell a
          // PIN from _langCode()'s DEFAULT. Report both: what language, and
          // whether it was actually decided.
          languagePinned: this._langPinned ? this._langCode() : null,
          languageEffective: this._langCode() || null,
          deadAirP50: this._turnLatencies.length ? this._percentile(this._turnLatencies, 50) : null,
          deadAirP95: this._turnLatencies.length ? this._percentile(this._turnLatencies, 95) : null,
          // ─── HOW NOISY WAS THIS LINE, ACTUALLY ─────────────────────────
          // The first acoustic signal this system has ever kept. RMS drove
          // three in-call decisions and was written down nowhere, so every
          // "was that background noise?" ended in "we cannot tell" — including
          // on 2026-08-13, when a caller reported a misbehaving call that had
          // dropped=0, garbleReprompts=0 and no recording. Two hypotheses,
          // no way to separate them.
          //
          // floor = chunks with NEITHER party speaking: the room and the line.
          // speech = per-turn peak. snrDb = 20·log10(speech ÷ floor), the
          // ordinary definition, in dB so it is comparable across calls.
          // NULLS, NEVER ZEROS, and never a fabricated ratio: a floor of 0 is a
          // silent line, and dividing by it would print Infinity as though it
          // were a measurement.
          //
          // NOTHING READS THIS YET, DELIBERATELY. A threshold invented here
          // would be exactly the guessed-vendor-parameter this repo has a gate
          // against — the same mistake as the Sarvam VAD setting that halved
          // "Dolo 650". Twenty calls of this, then decide with numbers.
          audio: this._audioSummary(),
          // The loudness filter's own tally. Kept OUT of `dropped` because that
          // counts content decisions (echo, backchannel, blank) and this is an
          // amplitude decision — rolled together they cannot answer "did we
          // discard a quiet answer?", which is the only question a noisy call
          // asks. ghostDropRms carries the peaks so GHOST_RMS_FLOOR can be
          // argued from the drops it actually made rather than from intuition.
          ghostDrops: this._ghostDrops || 0,
          ghostDropRms: (this._ghostDropRms || []).slice(0, 20),
          // THE SPLIT. deadAir tells you the caller waited 1.3s; this tells you
          // which stage to go and fix. Nulls when a call had no measurable
          // turn, never zeros — zero is a claim, null is an absence.
          // Did the slice actually fire, and how hard? sliceRoster falls back to
          // the FULL roster on several branches, so slicedTurns < brainTurns is
          // normal early in a call (no symptom stated yet) — what matters is
          // that it is not always zero once symptoms are on the table.
          // SHADOW, deliberately. There is exactly ONE production example of
          // this (2026-08-06 12:42, पेट दर्द for सर दर्द) and the first version
          // of the rule fired on 5 of 8 real calls before the assert/ask split
          // took it to 1 of 8. One example is enough to MEASURE on, not enough
          // to block a patient's turn on. Same path emergencyDetectorV2 took:
          // shadow, count, then decide with numbers. If this stays at ~1 per 8
          // calls and every hit is real, it earns a re-ask.
          // THE CONFIGURATION THIS CALL ACTUALLY RAN WITH. A flag in a Railway
          // dashboard is a claim about production; this is the record, attached
          // to the call it governed. Without it, a latency number six months
          // from now cannot be interpreted — speculation ON and speculation OFF
          // produce very different dead air from identical code.
          // Did speculation FIRE, and was it USED? enabled != fired != claimed.
          speculation: {
            started: this._specStarted,
            claimed: this._specClaimed,
            cancelled: this._specCancelled,
            // The whole point: claimed/started is the yield, and this says what
            // is eating the difference.
            cancelReasons: { ...this._specCancelReasons },
          },
          // Did a deterministic guard speak? If it did, the model's next turn
          // now has it in history — the fix for "I cannot hear you" followed by
          // "your voice is perfectly clear".
          garbleSpoke: this._garbleSpokeThisCall,
          config: runtimeConfig(),
          symptomDrift: drift,
          // ─── STEP-1 BASELINE BLOCKS ─────────────────────────────────────
          // Persisted per call so a fix can be scored against a baseline taken
          // by the same instrument. Every field is a COUNT, never a boolean —
          // "reuse was on" is a claim, "1.0 cold dials per sentence" is a fact.
          speech: {
            chars: this._speechChars,
            replies: this._speechReplies,
            charsPerReply: this._speechReplies ? Math.round(this._speechChars / this._speechReplies) : null,
          },
          tts: {
            sentences: this._ttsSentences,
            coldDials: this._ttsColdDials,
            // ~1.0 means prewarm is NOT covering the turn and reuse might help.
            // ~0.0 means the warm slot is doing its job and reuse buys nothing.
            coldPerSentence: this._ttsSentences
              ? Math.round((this._ttsColdDials / this._ttsSentences) * 100) / 100 : null,
          },
          llm: {
            turns: this._llmTurns,
            // Every brain request must be a metered turn. This pair is the
            // runtime self-check the cost meters never had: 30 days of a 41%
            // undercount were visible in these two counters from day one, but
            // nothing compared them. meterVersion separates rows written
            // before the meters were fixed (1) from truthful ones (2).
            brainTurns: this._rosterBrainTurns,
            unmeteredTurns: Math.max(0, (this._rosterBrainTurns || 0) - (this._llmTurns || 0)),
            meterVersion: 2,
            // null, not 0, when NOTHING reported — those are different facts and
            // conflating them is what produced a false caching conclusion.
            usageReportedTurns: this._llmUsageReportedTurns,
            cachedReportedTurns: this._llmCachedReportedTurns,
            promptTokens: this._llmUsageReportedTurns ? this._llmPromptTokens : null,
            completionTokens: this._llmUsageReportedTurns ? this._llmCompletionTokens : null,
            cachedTokens: this._llmCachedReportedTurns ? this._llmCachedTokens : null,
            promptTokensPerTurn: this._llmUsageReportedTurns
              ? Math.round(this._llmPromptTokens / this._llmUsageReportedTurns) : null,
            cachedRatio: (this._llmCachedReportedTurns && this._llmPromptTokens)
              ? Math.round((this._llmCachedTokens / this._llmPromptTokens) * 100) / 100 : null,
          },
          rosterSlice: {
            slicedTurns: this._rosterSliceTurns,
            brainTurns: this._rosterBrainTurns,
            last: this._rosterSliceLast,
          },
          latencySplit: {
            sttDebounceP50: this._sttMs.length ? this._percentile(this._sttMs, 50) : null,
            llmToolP50: this._llmMs.length ? this._percentile(this._llmMs, 50) : null,
            ttsFirstByteP50: this._ttsMs.length ? this._percentile(this._ttsMs, 50) : null,
            sttDebounceP95: this._sttMs.length ? this._percentile(this._sttMs, 95) : null,
            llmToolP95: this._llmMs.length ? this._percentile(this._llmMs, 95) : null,
            ttsFirstByteP95: this._ttsMs.length ? this._percentile(this._ttsMs, 95) : null,
            // llm+tool, split (2026-09-18): the tools' share and the model's share.
            // Guarded: test fixtures build a handler without the constructor.
            toolP50: (this._toolMs || []).length ? this._percentile(this._toolMs, 50) : null,
            toolP95: (this._toolMs || []).length ? this._percentile(this._toolMs, 95) : null,
            llmOnlyP50: (this._llmOnlyMs || []).length ? this._percentile(this._llmOnlyMs, 50) : null,
            llmOnlyP95: (this._llmOnlyMs || []).length ? this._percentile(this._llmOnlyMs, 95) : null,
            splitTurns: this._sttMs.length,
            // Turns where a filler played. The split does not apply to those,
            // and they also make deadAir look BETTER than the real wait — the
            // caller heard something, they just did not hear the answer.
            fillerMaskedTurns: this._fillerTurns,
          },
          telephony: this._telephony ? this._telephony.summary() : null,
        },
        transcript: this.transcript,
        status: 'completed'
      }).catch(err => console.error(`[CALL ${this.callSid}] CRM log error:`, err.message));

      if (this.ws && this.ws.readyState === 1) {
        this.ws.close();
      }
      console.log(`[CALL ${this.callSid}] Call ended. Duration: ${durationSeconds}s, Booked: ${this.appointmentBooked}, Outcome: ${this.outcome}/${this.notBookedReason}` +
        ` (turns=${(this.transcript||[]).filter(t=>t&&t.role==='patient').length} dropped=${this._droppedUtterances} errors=${this._criticalErrors} trigger=${this._endTrigger||'none'})`);
      if (this._telephony) { try { this._telephony.logSummary(); } catch (_) {} }
      if (this._turnLatencies.length) {
        const p50 = this._percentile(this._turnLatencies, 50);
        const p95 = this._percentile(this._turnLatencies, 95);
        console.log(`[LATENCY ${this.callSid}] turns=${this._turnLatencies.length} dead-air p50=${p50}ms p95=${p95}ms max=${Math.max(...this._turnLatencies)}ms`);
        // ONE GREPPABLE LINE WITH EVERYTHING THAT DECIDES THE NEXT FIX.
        // Every one of these already goes into diagnostics, but reading that
        // needs a database password — which meant handing a production
        // credential to whoever is debugging, and it is how one ended up pasted
        // into a chat log twice. The Railway log is already readable by the
        // person who owns the deploy, so the numbers belong there too.
        // Deliberately no patient content: counts, milliseconds and flags only.
        const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : 'n/a');
        console.log(
          `[CALLSUM ${this.callSid}] outcome=${this.outcome || '-'}/${this.notBookedReason || '-'} dur=${this.durationSeconds}s `
          + `turns=r${(this.transcript || []).filter(t => t && t.role === 'ritu').length}/p${(this.transcript || []).filter(t => t && t.role === 'patient').length} end=${this._endTrigger || '-'} `
          + `deadair=${p50}/${p95} stt=${this._sttMs.length ? this._percentile(this._sttMs, 50) : '-'} `
          + `llm=${this._llmMs.length ? this._percentile(this._llmMs, 50) : '-'} `
          + `tts=${this._ttsMs.length ? this._percentile(this._ttsMs, 50) : '-'} filler=${this._fillerTurns} `
          + `spec=${this._specStarted}/${this._specClaimed}claimed/${this._specCancelled}cancelled(${pct(this._specClaimed, this._specStarted)}) `
          + `specwhy=${JSON.stringify(this._specCancelReasons)} `
          + `slice=${this._rosterSliceTurns}/${this._rosterBrainTurns} `
          + `drift=${drift.length} garble=${this._garbleReprompts}/${this._garbleSpokeThisCall} `
          + `lang=${this._langPinned ? this._langCode() : 'unpinned'}`
        );
      }
    } catch (error) {
      console.error(`[CALL ${this.callSid}] End call error:`, error.message);
    }
  }
}

module.exports = CallHandler;
// Named exports alongside the default, so the intent eval can drive the emergency
// path with the REAL spoken texts and the REAL self-harm routing (108 line vs the
// mental-health helpline) instead of a second copy that would drift out of step.
// The eval used to skip this path entirely — the detectors run in _onTranscript,
// which it never called — and S05 therefore reported "nothing booked" on a
// chest-pain call. A harness gap on a patient-safety path is indistinguishable
// from a broken detector, and the reassuring reading is the wrong one.
module.exports.CallHandler = CallHandler;
// Exported so tests can DRIVE the filter rather than restate its regex. It now
// has to get two opposite verdicts right on the same words — Ritu's own
// recording notice echoing back through STT must be dropped, a caller ASKING
// about recording must not be — and a test that retyped the pattern would pass
// while the shipped one was wrong.
module.exports.isRecordingAnnouncement = isRecordingAnnouncement;
module.exports.lastRituTurnWasOffer = lastRituTurnWasOffer;
// The three tables that decide which languages can OPEN a call. Exported so the
// cross-check compares real objects: the previous guard regexed this file for
// /'xx-IN': `/ and therefore saw only entries whose value is a TEMPLATE LITERAL
// — the four shipped ones are backticked purely because they interpolate the
// clinic name, so a fifth language added with plain quotes was invisible to it.
module.exports.GREETING_TEXTS = GREETING_TEXTS;
module.exports.RETURNING_GREETING_TEXTS = RETURNING_GREETING_TEXTS;
module.exports.RECORDING_NOTICES = RECORDING_NOTICES;
module.exports.EMERGENCY_TEXTS = EMERGENCY_TEXTS;
module.exports.SELF_HARM_TEXTS = SELF_HARM_TEXTS;
// Exported for tools/capture-gap.js, which measures how much of what a patient
// SAID reaches the record. It has to split clauses exactly as the call path
// does; a second copy would drift, and drifting copies of one rule are the
// defect this file has shipped three times in four days (four sentinel lists,
// six on-call specialties, three "is this a real name" checks).
module.exports._splitMedsAndAllergens = _splitMedsAndAllergens;
module.exports._sanitizeForSpeech = sanitizeForSpeech;
module.exports.ALLERGY_RE = ALLERGY_RE;
// The enforcement predicate itself, for tests/test-emergency-v2-scope.js. It was
// asserted there by rebuilding the Set from the env var IN THE TEST and checking
// that copy — which tests the test. This is a module-level const frozen at
// require time, so a test must set the env and require in a FRESH process; the
// test does exactly that rather than pretending one process can hold two
// configurations.
module.exports._V2_ENFORCES = V2_ENFORCES;
// The deterministic intake lines, for the twin-parity harness to classify a spoken line by.
module.exports._INTAKE_LINES = { HISTORY_ASK_DURATION, HISTORY_ASK_MEDS, MED_NAME_REASK };
