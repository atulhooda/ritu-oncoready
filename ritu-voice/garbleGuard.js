// ═══════════════════════════════════════════════════════════════════════════
// GARBLE GUARD — "the line is too unclear to be safe" detector
//
// Purpose: in healthcare, a CONFIDENT wrong capture is far more dangerous than a
// "sorry, I didn't catch that." When the audio is so degraded that the STT output
// is untrustworthy, Ritu should ask the caller to repeat — like a real receptionist
// on a bad line — instead of feeding noise into booking / clinical capture.
//
// DESIGN PRINCIPLE (why this can't break normal calls): every threshold below is
// set ABOVE the worst value observed on real clean+telephony Sarvam transcripts
// (measured on 49 Eka clinical clips: max consecutive-token repeat = 2, max
// bigram repeat = 3, min unique-token ratio ≈ 0.69, language_probability = 1.0).
// So on a normal call NONE of these fire. The guard only trips on the extreme,
// heavily-garbled input the judges' laptop-through-a-noisy-room test produces —
// the exact case where proceeding would mean hallucinating.
//
// It is deterministic (no model call, ~0ms), fail-OPEN (any doubt → not garbled →
// normal processing), and the caller path caps re-prompts so a bad take can never
// trap a call in a "please repeat" loop.
// ═══════════════════════════════════════════════════════════════════════════

// Word tokens across Latin + all Indic blocks (Devanagari, Bengali, Gurmukhi,
// Gujarati, Tamil, Telugu, Kannada, Malayalam, Odia) + digits.
const WORD_RE = /[A-Za-z0-9ऀ-෿਀-੿]+/g;

function tokenize(text) {
  return String(text || '').match(WORD_RE) || [];
}

function maxConsecutiveRepeat(toks) {
  let max = toks.length ? 1 : 0, cur = 1;
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === toks[i - 1]) { cur++; if (cur > max) max = cur; }
    else cur = 1;
  }
  return max;
}

function maxBigramRepeat(toks) {
  if (toks.length < 2) return 0;
  const counts = new Map();
  let max = 0;
  for (let i = 0; i < toks.length - 1; i++) {
    const bg = toks[i] + ' ' + toks[i + 1];
    const c = (counts.get(bg) || 0) + 1;
    counts.set(bg, c);
    if (c > max) max = c;
  }
  return max;
}

function uniqueRatio(toks) {
  if (!toks.length) return 1;
  return new Set(toks).size / toks.length;
}

// Thresholds — deliberately BEYOND the clean-data envelope (see header).
// A lone stutter ("child child child …" in otherwise-fine speech) reaches 3
// repeats at HIGH confidence, so a 3-repeat only counts as garble when Sarvam's
// OWN confidence is also low (corroborated); a standalone repeat must hit 4.
// REMOVED 2026-07-25 — the language_probability signal and everything that
// depended on it (LANG_PROB_MIN, LANG_PROB_CORROB, and the two *_CORROB repeat
// thresholds it gated). It was never a signal:
//   • pinned session  → Sarvam returns language_probability = null (schema).
//     Our repin fires after the first substantive utterance, so it is null for
//     nearly the whole call.
//   • unknown session → MEASURED saturated at 1.0. On 400 MUCS Marathi calls it
//     was 1.0 on every single one INCLUDING all 58 it mis-tagged as en-IN
//     (data/mucs-marathi-wer.json); lid-calibration.json found the same on Hindi.
// So `lp` was always null or always 1.0 — never below 0.30 or 0.50. The
// 'low_lang_prob' reason could never fire and the corroborated 3-repeat
// thresholds could never apply, leaving the standalone 4-repeat rules as the
// real behavior. Deleting them is therefore behavior-identical, and it stops us
// tuning against a phantom and stops the suite reporting phantom coverage.
// If a future STT gives a REAL per-utterance confidence, re-add it with its own
// calibration — do not resurrect these constants.
const TH = {
  CONSEC_REPEAT: 4,         // standalone; clean max was 2, a stutter reached 3
  BIGRAM_REPEAT: 4,         // standalone; clean max was 3
  MIN_UNIQUE_RATIO: 0.30,   // clean min ≈ 0.69; only fires on heavy loops
  MIN_TOKENS_FOR_DIVERSITY: 8, // don't judge diversity on tiny utterances
  NEAR_EMPTY_AUDIO_S: 3,    // this much audio…
  NEAR_EMPTY_TOKENS: 1,     // …but ≤1 word ⇒ mostly noise
};

// detectGarble(text, meta) → { garbled: bool, reasons: string[], severity }
//   meta: { languageProbability?: number, audioDuration?: number }
// A `null`/empty transcript is NOT treated as garble here — empty turns are
// silence, handled by the silence path, not this guard.
function detectGarble(text, meta = {}) {
  const t = String(text || '').trim();
  const toks = tokenize(t);
  if (toks.length === 0) return { garbled: false, reasons: [], severity: 0 };

  const reasons = [];
  const dur = meta.audioDuration;
  const consec = maxConsecutiveRepeat(toks);
  const bigram = maxBigramRepeat(toks);

  // meta.languageProbability is deliberately IGNORED — see the TH comment.
  if (consec >= TH.CONSEC_REPEAT) reasons.push('token_repeat');
  if (bigram >= TH.BIGRAM_REPEAT) reasons.push('phrase_repeat');
  if (toks.length >= TH.MIN_TOKENS_FOR_DIVERSITY && uniqueRatio(toks) < TH.MIN_UNIQUE_RATIO) reasons.push('low_diversity');
  if (typeof dur === 'number' && dur >= TH.NEAR_EMPTY_AUDIO_S && toks.length <= TH.NEAR_EMPTY_TOKENS) reasons.push('near_empty');

  return { garbled: reasons.length > 0, reasons, severity: reasons.length };
}

// "Sorry, the line broke up — could you say that again?" in all 11 supported
// languages. Kept short (spoken on a bad line). Falls back to Hindi.
const REPEAT_TEXTS = {
  'hi-IN': 'माफ़ कीजिए, आवाज़ थोड़ी अस्पष्ट आ रही है। कृपया एक बार फिर से बोलिए।',
  'mr-IN': 'माफ करा, आवाज नीट ऐकू येत नाहीये. कृपया पुन्हा एकदा सांगाल का?',
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ಧ್ವನಿ ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ. ದಯವಿಟ್ಟು ಇನ್ನೊಮ್ಮೆ ಹೇಳಿ.',
  'ta-IN': 'மன்னிக்கவும், சத்தம் தெளிவாகக் கேட்கவில்லை. தயவுசெய்து மீண்டும் சொல்லுங்கள்.',
  'te-IN': 'క్షమించండి, స్వరం స్పష్టంగా వినిపించడం లేదు. దయచేసి మళ్లీ చెప్పండి.',
  'bn-IN': 'দুঃখিত, আওয়াজ পরিষ্কার শোনা যাচ্ছে না। অনুগ্রহ করে আবার বলুন।',
  'gu-IN': 'માફ કરશો, અવાજ સ્પષ્ટ સંભળાતો નથી. કૃપા કરીને ફરીથી કહો.',
  'ml-IN': 'ക്ഷമിക്കണം, ശബ്ദം വ്യക്തമായി കേൾക്കുന്നില്ല. ദയവായി ഒന്നുകൂടി പറയാമോ?',
  'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ସ୍ୱର ସ୍ପଷ୍ଟ ଶୁଣାଯାଉ ନାହିଁ। ଦୟାକରି ପୁଣି କୁହନ୍ତୁ।',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਆਵਾਜ਼ ਸਾਫ਼ ਨਹੀਂ ਆ ਰਹੀ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਦੱਸੋ।',
  'en-IN': "Sorry, the line broke up a little — could you please say that once more?",
};

function repeatPrompt(langCode) {
  return REPEAT_TEXTS[langCode] || REPEAT_TEXTS['hi-IN'];
}

// ─── REPAIR LADDER (S2 T7 rung 1–2): targeted, slot-aware re-asks ────────────
// A generic "please repeat" wastes a turn — 72% of human clarifications name
// the missing slot, and Hippocratic's targeted engine cut clarification error
// 16.3%→2.0%. So instead of "say that again", Ritu asks for the SPECIFIC thing
// the line ate ("I didn't catch your NAME"), and on a second failure escalates
// to spell-the-first-letter — asymmetric elicitation that shrinks the STT's
// search space from an infinite name vocabulary to a single character.
//
// Coverage: the clinic's live languages (hi/mr/kn/en) get the targeted phrasing;
// every other language falls back to the generic repeatPrompt (no regression —
// those callers keep exactly today's behavior). Slot names map to the call's
// conversation phase (see callHandler _currentSlot()).
const SLOT_REASK = {
  name: {
    'hi-IN': 'माफ़ कीजिए, आपका नाम ठीक से सुनाई नहीं दिया। कृपया अपना नाम एक बार फिर बताइए।',
    'mr-IN': 'माफ करा, तुमचं नाव नीट ऐकू आलं नाही. कृपया तुमचं नाव पुन्हा एकदा सांगा.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ಹೆಸರು ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರನ್ನು ಇನ್ನೊಮ್ಮೆ ಹೇಳಿ.',
    'en-IN': "Sorry, I didn't catch your name — could you tell me your name once more?",
    'gu-IN': 'માફ કરશો, તમારું નામ બરાબર સંભળાયું નહીં. કૃપા કરીને તમારું નામ ફરી એક વાર કહો.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਤੁਹਾਡਾ ਨਾਮ ਠੀਕ ਤਰ੍ਹਾਂ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤਾ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਨਾਮ ਇੱਕ ਵਾਰ ਫਿਰ ਦੱਸੋ।',
    'ta-IN': 'மன்னிக்கவும், உங்கள் பெயர் சரியாகக் கேட்கவில்லை. தயவுசெய்து உங்கள் பெயரை மீண்டும் ஒருமுறை சொல்லுங்கள்.',
    'te-IN': 'క్షమించండి, మీ పేరు సరిగ్గా వినిపించలేదు. దయచేసి మీ పేరు మరోసారి చెప్పండి.',
    'bn-IN': 'দুঃখিত, আপনার নাম ঠিকমতো শোনা যায়নি। অনুগ্রহ করে আপনার নামটা আরেকবার বলুন।',
    'ml-IN': 'ക്ഷമിക്കണം, നിങ്ങളുടെ പേര് ശരിയായി കേട്ടില്ല. ദയവായി പേര് ഒരിക്കൽ കൂടി പറയൂ.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଆପଣଙ୍କ ନାମ ଠିକ୍ ଭାବେ ଶୁଣାଗଲା ନାହିଁ। ଦୟାକରି ଆପଣଙ୍କ ନାମ ଆଉ ଥରେ କୁହନ୍ତୁ।',
  },
  reason: {
    'hi-IN': 'माफ़ कीजिए, आपकी तकलीफ़ ठीक से सुनाई नहीं दी। कृपया फिर से बताइए, क्या समस्या है।',
    'mr-IN': 'माफ करा, तुमची तक्रार नीट ऐकू आली नाही. कृपया पुन्हा सांगा, काय त्रास होतोय.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ಸಮಸ್ಯೆ ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಇನ್ನೊಮ್ಮೆ ಹೇಳಿ, ಏನು ತೊಂದರೆ.',
    'en-IN': "Sorry, I didn't catch that — could you tell me again what the problem is?",
    'gu-IN': 'માફ કરશો, તમારી તકલીફ બરાબર સંભળાઈ નહીં. કૃપા કરીને ફરીથી કહો, શું સમસ્યા છે.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਤੁਹਾਡੀ ਤਕਲੀਫ਼ ਠੀਕ ਤਰ੍ਹਾਂ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤੀ। ਕਿਰਪਾ ਕਰਕੇ ਫਿਰ ਦੱਸੋ, ਕੀ ਸਮੱਸਿਆ ਹੈ।',
    'ta-IN': 'மன்னிக்கவும், உங்கள் பிரச்சனை சரியாகக் கேட்கவில்லை. தயவுசெய்து மீண்டும் சொல்லுங்கள், என்ன பிரச்சனை.',
    'te-IN': 'క్షమించండి, మీ సమస్య సరిగ్గా వినిపించలేదు. దయచేసి మళ్ళీ చెప్పండి, ఏమి సమస్య.',
    'bn-IN': 'দুঃখিত, আপনার সমস্যাটা ঠিকমতো শোনা যায়নি। অনুগ্রহ করে আবার বলুন, কী সমস্যা।',
    'ml-IN': 'ക്ഷമിക്കണം, നിങ്ങളുടെ പ്രശ്നം ശരിയായി കേട്ടില്ല. ദയവായി വീണ്ടും പറയൂ, എന്താണ് പ്രശ്നം.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଆପଣଙ୍କ ଅସୁବିଧା ଠିକ୍ ଭାବେ ଶୁଣାଗଲା ନାହିଁ। ଦୟାକରି ପୁଣି କୁହନ୍ତୁ, କଣ ସମସ୍ୟା।',
  },
  scheduling: {
    'hi-IN': 'माफ़ कीजिए, ठीक से सुनाई नहीं दिया। कृपया बताइए, किस डॉक्टर या किस समय के लिए।',
    'mr-IN': 'माफ करा, नीट ऐकू आलं नाही. कृपया सांगा, कोणत्या डॉक्टरांसाठी किंवा कोणत्या वेळेसाठी.',
    'kn-IN': 'ಕ್ಷಮಿಸಿ, ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಹೇಳಿ, ಯಾವ ಡಾಕ್ಟರ್ ಅಥವಾ ಯಾವ ಸಮಯಕ್ಕೆ.',
    'en-IN': "Sorry, I didn't catch that — which doctor, or what time would you like?",
    'gu-IN': 'માફ કરશો, બરાબર સંભળાયું નહીં. કૃપા કરીને કહો, કયા ડૉક્ટર માટે કે કયા સમય માટે.',
    'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਠੀਕ ਤਰ੍ਹਾਂ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤਾ। ਕਿਰਪਾ ਕਰਕੇ ਦੱਸੋ, ਕਿਹੜੇ ਡਾਕਟਰ ਜਾਂ ਕਿਹੜੇ ਸਮੇਂ ਲਈ।',
    'ta-IN': 'மன்னிக்கவும், சரியாகக் கேட்கவில்லை. தயவுசெய்து சொல்லுங்கள், எந்த டாக்டர் அல்லது எந்த நேரத்திற்கு.',
    'te-IN': 'క్షమించండి, సరిగ్గా వినిపించలేదు. దయచేసి చెప్పండి, ఏ డాక్టర్ కోసం లేదా ఏ సమయానికి.',
    'bn-IN': 'দুঃখিত, ঠিকমতো শোনা যায়নি। অনুগ্রহ করে বলুন, কোন ডাক্তার বা কোন সময়ের জন্য।',
    'ml-IN': 'ക്ഷമിക്കണം, ശരിയായി കേട്ടില്ല. ദയവായി പറയൂ, ഏത് ഡോക്ടർ അല്ലെങ്കിൽ ഏത് സമയത്തേക്ക്.',
    'od-IN': 'କ୍ଷମା କରିବେ, ଠିକ୍ ଭାବେ ଶୁଣାଗଲା ନାହିଁ। ଦୟାକରି କୁହନ୍ତୁ, କେଉଁ ଡାକ୍ତର କିମ୍ବା କେଉଁ ସମୟ ପାଇଁ।',
  },
};
// Rung 2 for the NAME slot: spell the first letter (search space → 1 char).
const NAME_SPELL = {
  'hi-IN': 'लाइन थोड़ी ख़राब है। क्या आप अपने नाम का सिर्फ़ पहला अक्षर बता सकते हैं?',
  'mr-IN': 'लाइन थोडी खराब आहे. तुम्ही तुमच्या नावाचं फक्त पहिलं अक्षर सांगू शकता का?',
  'kn-IN': 'ಲೈನ್ ಸ್ವಲ್ಪ ಸರಿಯಿಲ್ಲ. ನಿಮ್ಮ ಹೆಸರಿನ ಮೊದಲ ಅಕ್ಷರವನ್ನು ಮಾತ್ರ ಹೇಳಬಹುದೇ?',
  'en-IN': "The line is a little unclear — could you just tell me the first letter of your name?",
  'gu-IN': 'લાઇન થોડી ખરાબ છે. શું તમે તમારા નામનો ફક્ત પહેલો અક્ષર કહી શકો?',
  'pa-IN': 'ਲਾਈਨ ਥੋੜ੍ਹੀ ਖ਼ਰਾਬ ਹੈ। ਕੀ ਤੁਸੀਂ ਆਪਣੇ ਨਾਮ ਦਾ ਸਿਰਫ਼ ਪਹਿਲਾ ਅੱਖਰ ਦੱਸ ਸਕਦੇ ਹੋ?',
  'ta-IN': 'லைன் கொஞ்சம் சரியில்லை. உங்கள் பெயரின் முதல் எழுத்தை மட்டும் சொல்ல முடியுமா?',
  'te-IN': 'లైన్ కొంచెం సరిగ్గా లేదు. మీ పేరులోని మొదటి అక్షరం మాత్రమే చెప్పగలరా?',
  'bn-IN': 'লাইনটা একটু খারাপ। আপনার নামের শুধু প্রথম অক্ষরটা বলতে পারবেন?',
  'ml-IN': 'ലൈൻ അല്പം മോശമാണ്. നിങ്ങളുടെ പേരിന്റെ ആദ്യ അക്ഷരം മാത്രം പറയാമോ?',
  'od-IN': 'ଲାଇନ୍ ଟିକେ ଖରାପ ଅଛି। ଆପଣ ଆପଣଙ୍କ ନାମର କେବଳ ପ୍ରଥମ ଅକ୍ଷର କହିପାରିବେ କି?',
};

// Rung 2 for the REASON slot. It did not exist until 2026-08-15, and nobody
// noticed because the greeting used to ask for the NAME first — a garbled
// opener landed on the name slot, which escalates. The greeting now asks about
// the problem (111 of 125 callers answered that question regardless of what
// they were asked), so the opener lands HERE, and without a rung 2 a caller on
// a bad line hears the exact same sentence twice. Repeating yourself verbatim
// is the single most bot-like thing this system can do, and it arrives at the
// worst moment: the line is already bad and the caller is already unsure.
//
// Same asymmetric-elicitation principle as NAME_SPELL — collapse an open-ended
// answer into a small one. "What is the problem?" admits any sentence; "where
// does it hurt?" admits a body part, which is a handful of high-frequency words
// the STT gets right even on a poor line.
const REASON_NARROW = {
  'hi-IN': 'लाइन थोड़ी ख़राब है। बस इतना बता दीजिए — तकलीफ़ कहाँ हो रही है?',
  'mr-IN': 'लाइन थोडी खराब आहे. फक्त एवढं सांगा — त्रास कुठे होतोय?',
  'kn-IN': 'ಲೈನ್ ಸ್ವಲ್ಪ ಸರಿಯಿಲ್ಲ. ಇಷ್ಟೇ ಹೇಳಿ — ಎಲ್ಲಿ ತೊಂದರೆ ಆಗ್ತಿದೆ?',
  'en-IN': "The line is a little unclear — just tell me this: where is the trouble?",
  'gu-IN': 'લાઇન થોડી ખરાબ છે. બસ આટલું કહો — તકલીફ ક્યાં થાય છે?',
  'pa-IN': 'ਲਾਈਨ ਥੋੜ੍ਹੀ ਖ਼ਰਾਬ ਹੈ। ਬੱਸ ਇੰਨਾ ਦੱਸੋ — ਤਕਲੀਫ਼ ਕਿੱਥੇ ਹੋ ਰਹੀ ਹੈ?',
  'ta-IN': 'லைன் கொஞ்சம் சரியில்லை. இதை மட்டும் சொல்லுங்கள் — எங்கே பிரச்சனை?',
  'te-IN': 'లైన్ కొంచెం సరిగ్గా లేదు. ఇది మాత్రమే చెప్పండి — ఎక్కడ ఇబ్బంది ఉంది?',
  'bn-IN': 'লাইনটা একটু খারাপ। শুধু এটুকু বলুন — কোথায় সমস্যা হচ্ছে?',
  'ml-IN': 'ലൈൻ അല്പം മോശമാണ്. ഇത്രമാത്രം പറയൂ — എവിടെയാണ് ബുദ്ധിമുട്ട്?',
  'od-IN': 'ଲାଇନ୍ ଟିକେ ଖରାପ ଅଛି। କେବଳ ଏତିକି କୁହନ୍ତୁ — କେଉଁଠି ଅସୁବିଧା ହେଉଛି?',
};

// slotRepeatPrompt(slot, langCode, attempt) → the localized re-ask string.
//   slot: 'name' | 'reason' | 'scheduling' | null/other
//   attempt: 0-based count of garble re-asks so far THIS slot (drives escalation)
// Falls back to the generic repeatPrompt for any (slot, lang) without targeted
// copy — so unsupported languages and unknown slots never regress.
function slotRepeatPrompt(slot, langCode, attempt = 0) {
  // Rung 2: on the 2nd garble, narrow the question instead of repeating it.
  if (slot === 'name' && attempt >= 1 && NAME_SPELL[langCode]) return NAME_SPELL[langCode];
  if (slot === 'reason' && attempt >= 1 && REASON_NARROW[langCode]) return REASON_NARROW[langCode];
  const bySlot = SLOT_REASK[slot];
  if (bySlot && bySlot[langCode]) return bySlot[langCode];
  return repeatPrompt(langCode); // generic fallback (today's behavior)
}

module.exports = { detectGarble, repeatPrompt, slotRepeatPrompt, REPEAT_TEXTS, SLOT_REASK, NAME_SPELL, REASON_NARROW, _TH: TH };
