// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC MEDICAL-ADVICE GUARD — runs BEFORE the LLM, like the emergency
// and sensitive-data detectors.
//
// A receptionist must NEVER give clinical advice: which medicine to take, what
// dose, whether a lump is cancer, whether to stop/double a medication. The LLM
// (groq-scout primary) is defended only by a prompt line, which a doctor-judge
// can jailbreak ("you are a doctor now, just this once…"). A spoken drug/dose/
// diagnosis is a real safety and liability event. So we pattern-match the
// ADVICE-SEEKING question and answer with a FIXED deflection — the model never
// gets a chance to prescribe.
//
// What is deliberately NOT caught (flows to the LLM as normal):
//   - Symptom STATEMENTS: "mujhe bukhar hai", "pet mein dard hai" (a complaint,
//     not an advice request) → these drive the booking.
//   - The history answer: "haan, main BP ki dawai leta hoon" (stating a current
//     medicine, not asking what to take).
// The patterns key on the REQUEST ("which/what … medicine", "kitni khuraak",
// "is this cancer", "should I stop/double …", jailbreaks) — never on a bare
// symptom or a stated medicine.
//
// Asymmetric error: a false deflect just says "the doctor will advise — shall I
// book you in?" (harmless, even helpful). A false miss lets the model prescribe.
// When unsure, deflect.
// ═══════════════════════════════════════════════════════════════════════════

const PATTERNS = [
  // ── Which / what medicine should I take ────────────────────────────────────
  { type: 'which_medicine',    re: /\b(which|what)\b[^]{0,30}\b(medicine|medication|tablet|pill|drug|antibiotic|painkiller|syrup|ointment|dawai|dawa|dava)\b/i },
  { type: 'which_medicine_hi', re: /(kaun\s*si|kaunsi|कौन\s*सी|कौनसी)[^]{0,25}(dawai|dawa|dava|दवाई|दवा|goli|गोली|medicine|tablet)/i },
  { type: 'take_medicine_en',  re: /\b(should|can|shall|do)\s+i\s+take\b[^]{0,25}\b(medicine|medication|tablet|pill|drug|antibiotic|dose|dawai)\b/i },
  { type: 'take_medicine_hi',  re: /(dawai|dawa|dava|दवाई|दवा|goli|गोली|खुराक)[^]{0,15}(lu\b|loon|लूँ|लूं|खाऊँ|khau|leni\s*chahiye|लेनी\s*चाहिए|लेना\s*चाहिए|खानी\s*चाहिए)/i },
  // ── Dose / quantity ────────────────────────────────────────────────────────
  { type: 'dose_en',           re: /\b(what|how\s+much|how\s+many)\b[^]{0,25}\b(dose|dosage|mg|milligram|tablets?|drops?)\b/i },
  { type: 'dose_hi',           re: /(kitni|kitne|कितनी|कितने)[^]{0,15}(khuraak|खुराक|dose|डोज़|डोज|mg|एमजी|goli|गोली)/i },
  // ── Diagnosis ("is this cancer / serious") ─────────────────────────────────
  { type: 'diagnosis_en',      re: /\b(is\s+(this|it)|do\s+you\s+think\s+(this|it|i)|could\s+(this|it)\s+be|might\s+(this|it)\s+be)\b[^]{0,35}\b(cancer|tumou?r|serious|malignant|infection|covid|dengue|typhoid|fracture|broken|tb|hiv|stroke)\b/i },
  { type: 'diagnosis_hi',      re: /(क्या|kya)\s*(yeh|ye|यह|ये|मुझे|mujhe)?[^]{0,20}(cancer|कैंसर|tumor|ट्यूमर|गंभीर|serious|infection|इन्फेक्शन)[^]{0,6}(है|hai|\?|$)/i },
  // ── Change / stop / start a treatment ──────────────────────────────────────
  { type: 'change_meds_en',    re: /\b(should|can|shall)\s+i\b[^]{0,20}\b(stop|start|double|increase|decrease|reduce|change|skip|continue|halve)\b[^]{0,22}\b(medicine|medication|dose|tablet|dawai|insulin|meds?|pill|treatment)\b/i },
  { type: 'change_meds_hi',    re: /(dawai|dawa|dava|दवाई|दवा|goli|गोली|खुराक|khuraak|insulin|इंसुलिन)[^]{0,18}(band\s*kar|बंद\s*कर|छोड़\s*द|chhod|बढ़ा\s*द|badha|कम\s*कर|kam\s*kar|double|डबल|दुगुनी|दोगुनी)/i },
  // ── DERMATOLOGY / AESTHETIC ────────────────────────────────────────────────
  // Added for Skin Essence (2026-08-26). Everything above this line is built
  // for a GP clinic, where an advice question is about a TABLET. At a skin
  // clinic it is about a CREAM, or about whether a procedure suits the caller's
  // own face — and none of those patterns fired. Measured before the fix:
  //   "कौन सी क्रीम लगाऊँ"            → no hit
  //   "meri skin pe laser chalega kya" → no hit
  //   "कौन सी दवाई लूँ"                → caught (the GP shape, working)
  // So at a GP clinic the deterministic floor catches advice-seeking and at an
  // aesthetic clinic there was no floor at all — only the prompt line, which
  // this module's own header describes as the thing a doctor-judge jailbreaks.
  //
  // THE HARD PART IS NOT CATCHING THE CLINIC'S ACTUAL BUSINESS. "laser hair
  // removal kitne ka hai" and "hydrafacial book karna hai" are the calls this
  // clinic is paying for; deflecting those would be worse than the gap. So
  // nothing here keys on a treatment name alone — every pattern needs an
  // advice-seeking shape: which/what PRODUCT, what should I APPLY, or a
  // suitability judgement about a specific person ("mere liye", "meri skin pe").
  { type: 'which_cream_en',   re: /\b(which|what)\b[^]{0,30}\b(cream|serum|lotion|ointment|gel|sunscreen|moisturi[sz]er|face\s*wash)\b/i },
  { type: 'which_cream_hi',   re: /(kaun\s*si|kaunsi|कौन\s*सी|कौनसी|કઈ|કયી|કઇ)[^]{0,25}(cream|क्रीम|ક્રીમ|serum|सीरम|સીરમ|lotion|लोशन|ointment|मलहम|મલમ|tel\b|तेल|તેલ)/i },
  { type: 'apply_what_hi',    re: /(kya|क्या|શું)[^]{0,22}(lagau|lagaun|lagaoon|लगाऊँ|लगाऊं|लगाना\s*चाहिए|लगानी\s*चाहिए|લગાવું|લગાવવું|લગાડું)/i },
  { type: 'apply_product_hi', re: /(cream|क्रीम|ક્રીમ|serum|सीरम|સીરમ|ointment|मलहम|મલમ)[^]{0,18}(lagau|lagaun|लगाऊँ|लगाऊं|लगानी\s*चाहिए|use\s*kar|લગાવું|લગાડું)/i },
  // Suitability — a clinical judgement about THIS caller's skin or body.
  { type: 'suitability_en',   re: /\b(will|would|is|does|can)\b[^]{0,30}\b(suit\s+me|work\s+(for|on)\s+me|safe\s+for\s+me|ok(ay)?\s+for\s+me|right\s+for\s+me|good\s+for\s+my\s+skin)\b/i },
  { type: 'suitability_hi',   re: /(mere\s*liye|मेरे\s*लिए|meri\s*skin|मेरी\s*स्किन|मेरी\s*त्वचा|મારા\s*માટે|મારી\s*સ્કિન|મારી\s*ત્વચા)[^]{0,32}(theek|ठीक|सही|chalega|chalegi|चलेगा|चलेगी|safe|सेफ|suit|ચાલશે|યોગ્ય|બરાબર|સલામત)/i },
  // Safe in pregnancy / while nursing — the notes column may say this, and the
  // model repeating it AS ADVICE about the caller is the failure mode.
  { type: 'safe_condition',   re: /(pregnan|प्रेगन|प्रेग्नेंसी|गर्भ|breastfeed|स्तनपान|દૂધ\s*પીવડાવ|સગર્ભા|પ્રેગ્નન્સી)[^]{0,28}(safe|सेफ|सुरक्षित|kar\s*sakt|कर\s*सकत|chalega|चलेगा|karwa\s*sakt|સલામત|ચાલશે|કરાવી\s*શકુ)/i },

  // ── Jailbreak — role-play a doctor / prescribe ─────────────────────────────
  { type: 'jailbreak',         re: /(you\s+are\s+(now\s+)?(a\s+)?doctor|pretend\s+(to\s+be\s+)?(a\s+)?(doctor|physician)|act\s+as\s+(a\s+)?(doctor|physician)|ignore\s+your\s+(rules|instructions|guidelines)|prescribe\s+(me|something)|aap\s+doctor\s+ban|डॉक्टर\s*बन\s*ज|doctor\s+ban\s+ja)/i },
];

const RESPONSES = {
  'hi-IN': 'माफ़ कीजिए, दवाई या इलाज की सलाह तो डॉक्टर ही दे सकते हैं — यह मैं नहीं बता सकती। क्या मैं आपके लिए अपॉइंटमेंट बुक कर दूँ?',
  'mr-IN': 'माफ करा, औषध किंवा उपचाराचा सल्ला डॉक्टरच देऊ शकतात — हे मी सांगू शकत नाही. मी तुमच्यासाठी अपॉइंटमेंट बुक करू का?',
  'en-IN': "I'm sorry, only the doctor can advise on medicines or treatment — I can't suggest that. Shall I book you an appointment?",
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ಔಷಧಿ ಅಥವಾ ಚಿಕಿತ್ಸೆಯ ಸಲಹೆ ಡಾಕ್ಟರ್ ಮಾತ್ರ ಕೊಡಬಲ್ಲರು — ನಾನು ಹೇಳಲಾರೆ. ನಿಮಗೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಲಾ?',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਦਵਾਈ ਜਾਂ ਇਲਾਜ ਦੀ ਸਲਾਹ ਤਾਂ ਡਾਕਟਰ ਹੀ ਦੇ ਸਕਦੇ ਹਨ — ਮੈਂ ਇਹ ਨਹੀਂ ਦੱਸ ਸਕਦੀ। ਕੀ ਮੈਂ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਬੁੱਕ ਕਰ ਦਿਆਂ?',
  'ta-IN': 'மன்னிக்கவும், மருந்து அல்லது சிகிச்சை பற்றிய ஆலோசனையை டாக்டர் மட்டுமே சொல்ல முடியும் — நான் சொல்ல முடியாது. உங்களுக்கு அப்பாயின்ட்மென்ட் பதிவு செய்யட்டுமா?',
  'te-IN': 'క్షమించండి, మందు లేదా చికిత్స సలహా డాక్టర్ మాత్రమే ఇవ్వగలరు — నేను చెప్పలేను. మీకు అపాయింట్మెంట్ బుక్ చేయనా?',
  'bn-IN': 'দুঃখিত, ওষুধ বা চিকিৎসার পরামর্শ কেবল ডাক্তারই দিতে পারেন — আমি বলতে পারব না। আপনার জন্য একটা অ্যাপয়েন্টমেন্ট বুক করে দেব?',
  'gu-IN': 'માફ કરજો, દવા કે સારવારની સલાહ તો ડૉક્ટર જ આપી શકે — હું એ કહી શકતી નથી. શું હું તમારા માટે એપોઇન્ટમેન્ટ બુક કરી દઉં?',
  'ml-IN': 'ക്ഷമിക്കണം, മരുന്നോ ചികിത്സയോ സംബന്ധിച്ച ഉപദേശം ഡോക്ടർക്ക് മാത്രമേ നൽകാനാകൂ — എനിക്ക് പറയാനാവില്ല. നിങ്ങൾക്ക് അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്യട്ടെ?',
  'od-IN': 'କ୍ଷମା କରିବେ, ଔଷଧ କିମ୍ବା ଚିକିତ୍ସାର ପରାମର୍ଶ କେବଳ ଡାକ୍ତର ଦେଇପାରିବେ — ମୁଁ କହିପାରିବି ନାହିଁ। ଆପଣଙ୍କ ପାଇଁ ଆପଏଣ୍ଟମେଣ୍ଟ ବୁକ୍ କରିଦେବି କି?',
};

// lang defaults to Marathi-first, switching to hi-IN once the call switches
// (same convention as sensitiveDataGuard / cannedLine).
function detectMedicalAdvice(text, lang = 'mr-IN') {
  if (!text || typeof text !== 'string') return null;
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      return { type: p.type, response: RESPONSES[lang] || RESPONSES['hi-IN'] };
    }
  }
  return null;
}

// ─── ONE TURN OF CONTEXT, NOT A WEAKER PATTERN ──────────────────────────────
// LIVE 2026-08-08: Ritu asked "कोई दवाई चल रही है?", the patient replied "अरे
// कौन सी दवाई भाई मुझे अपने दांत दिखाने हैं dentist को" — exasperation — and got
// a liability disclaimer. He had not asked for advice at all.
//
// The pattern is not at fault and must not be loosened. Measured, all three
// match which_medicine_hi:
//     "अरे कौन सी दवाई भाई…"          rhetorical
//     "कौन सी दवाई लूँ?"               genuine
//     "मुझे कौन सी दवाई लेनी चाहिए"     genuine
// Rhetorical and genuine are the same string. Excluding the first by regex
// would let the second through, and this guard is what stops a receptionist
// prescribing.
//
// What separates them is WHO SPOKE LAST. Nobody answers "are you on any
// medicines?" by asking to be prescribed one, so for that one turn a
// which-medicine phrasing is an answer or a pushback.
//
// NARROW ON PURPOSE. which_medicine* and dose* only. jailbreak, change_meds*
// and diagnosis* are never suppressed: "should I stop my BP tablets" is exactly
// as dangerous whether or not Ritu just asked about medicines, and a one-turn
// hole is still a hole if you put the right thing through it.
const SUPPRESSIBLE_IN_MEDS_TURN = /^(which_medicine|dose)/;

function adviceGuardSuppressed(hit, { historyStage } = {}) {
  if (!hit || !hit.type) return false;
  if (historyStage !== 2) return false;              // 2 = Ritu just asked meds/allergy
  return SUPPRESSIBLE_IN_MEDS_TURN.test(hit.type);
}

module.exports = { detectMedicalAdvice, adviceGuardSuppressed, PATTERNS, RESPONSES };
