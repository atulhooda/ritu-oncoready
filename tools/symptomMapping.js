// ═══════════════════════════════════════════════════════════════════════════
// Symptom → specialty mapping
//
// Used by findDoctor (hospital path) and brain-lean's roster slice to translate
// a patient's described complaint ("ghutne mein dard", "fever hai", "घसा
// दुखतोय") into clinical specialties matched against doctors.specialty.
//
// STRUCTURE (rewritten after red-team 2026-07-09): each entry has a `latin`
// regex (ASCII \b word boundaries work there) and a `dev` list of
// Devanagari/Indic word forms. JS \b is ASCII-only — it NEVER anchors next to
// Devanagari — so `dev` entries are compiled with emulated boundaries:
// (?<![DV])(?:word|word2)(?![DV]) where DV = the Devanagari block. Without
// this, everyday words used to false-match as substrings and mis-slice the
// roster: "अपॉइंटमेंट दिला दो" → दिल → Cardiology, "अगला सोमवार" → गला → ENT,
// "दुकान" → कान → ENT, "कमरे में" → कमर → Orthopedic (all live-confirmed).
//
// Consequences of real boundaries:
//   - Inflected forms must be listed EXPLICITLY (दांत no longer matches दांतों
//     by substring) — or as an open-suffix stem `stem[DV]*` where every
//     continuation is a legit inflection (डोळ… is always eye-related; कमर is
//     NOT — कमरे = room — so कमर stays strict with कमरदर्द listed separately).
//   - Homographs resolve correctly: घुटन (suffocation → Pulmonology) no longer
//     rides along with घुटने/घुटना (knee → Orthopedic).
//
// specialtiesForSymptom returns ALL matches (not first-match) — overlaps are
// intentional; the roster slice unions specialties and shows a GP alongside
// the specialist for shared symptoms.
//
// Not a closed taxonomy — extend as we observe real clinic phrasings. Comment
// the source ("from receptionist screen-share day 3" / "red-team 2026-07-09")
// when adding aliases so we know what came from real calls vs guesses.
// ═══════════════════════════════════════════════════════════════════════════

const DV = '\\u0900-\\u097F'; // Devanagari block (Hindi + Marathi)
const GM = '\\u0A00-\\u0A7F'; // Gurmukhi (Punjabi)
const KN = '\\u0C80-\\u0CFF'; // Kannada

// Compile latin (already \b-anchored, ASCII) + per-script word lists, each
// with its OWN emulated boundary class (JS \b is ASCII-only in every Indic
// script — the दिल/दिला false-positive class exists in Gurmukhi and Kannada
// too, e.g. pa ਦਿਲ vs ਦਿਲਾ). Entries may be regex fragments (open-suffix
// stems like 'डोळ[DV]*' or spaced forms like 'सर\\s+दर्द').
// MARATHI IS AGGLUTINATIVE — case markers attach directly to the noun, with no
// space. The trailing (?![DV]) guard below exists to kill the दिल/दिला class
// (दिल = heart, दिला = gave), and it does that job, but it also blocked every
// naturally inflected form in the PILOT LANGUAGE:
//     डोकेदुखी           → Neurology            ✓
//     डोकेदुखीसाठी        → nothing              ✗  ("for a headache")
//     तापासाठी           → nothing              ✗  (ताप → तापा oblique + साठी)
//     दातदुखीसाठी        → nothing              ✗  (दात + दुखी + साठी)
// So "मला डोकेदुखीसाठी अपॉइंटमेंट हवी आहे" — about the most ordinary way a
// Marathi caller can state their reason — matched NO symptom. Consequences, all
// silent: the deterministic history machine never starts (it requires a symptom
// match), so the pre-visit questions fall to the model's discretion; and the
// roster slice sees no symptom and cannot narrow to a specialist.
// This is the same phenomenon the MUCS WER harness already normalises for with
// agglutinate() because saaras:v3 writes these forms joined.
//
// Allow TWO suffix classes after a term, and only these:
//   1. the ache-compound (X-दुखी / X-दुखणे) that forms the symptom word itself
//   2. a CLOSED list of postpositions, optionally preceded by the oblique vowel
// A blanket [DV]* suffix would have been the easy fix and would have brought
// दिला straight back. Verified: दिला still does NOT match, because the vowel is
// only allowed as part of a postposition group that must then actually find one.
const ACHE = 'दुख(?:ी|णे|णं|त|ते|ना)';
const POSTP = [
  // Marathi
  'साठी', 'मुळे', 'पासून', 'मध्ये', 'कडून', 'कडे', 'बद्दल', 'वरून', 'वर', 'ने', 'ला', 'चा', 'ची', 'चे', 'चं',
  // Hindi (written separately far more often, but harmless to accept)
  'के', 'को', 'से', 'में', 'पर', 'का', 'की',
].join('|');

function bounded(block, words) {
  const core = `(?:${words.join('|')})`;
  // Only Devanagari gets the suffix allowance — Gurmukhi/Kannada keep the strict
  // boundary until someone measures the same problem there rather than assuming it.
  if (block !== DV) return `(?<![${block}])${core}(?![${block}])`;
  return `(?<![${block}])${core}(?:${ACHE})?(?:[ाेीिं]?(?:${POSTP}))?(?![${block}])`;
}
function compile(latinSrc, devWords, paWords, knWords) {
  const parts = [];
  if (latinSrc) parts.push(latinSrc);
  if (devWords && devWords.length) parts.push(bounded(DV, devWords));
  if (paWords && paWords.length) parts.push(bounded(GM, paWords));
  if (knWords && knWords.length) parts.push(bounded(KN, knWords));
  return new RegExp(parts.join('|'), 'i');
}

const ENTRIES = [
  {
    specialty: 'Orthopedic',
    // Latin `back` alone was a red-team hit ("call me back", "back to back"
    // scheduling filler → spurious Ortho slice) — now requires pain context.
    latin: '\\b(ghutne|ghutna|knee|joint|jod|haddi|bone|kamar|back\\s*(pain|ache|dard)|backache|lower\\s+back|leg|foot|feet|ankle|tang|taang|paer|pair|edi|sports\\s+injury|fracture|spine|sciatica)\\b',
    // घुटने/घुटना (knee) explicit — bare घुटन is SUFFOCATION → Pulmonology.
    // कमर strict (कमरे = room); कमरदर्द listed separately. गुडघ… = Marathi knee.
    // Gujarati forms (2026-08-29), as they arrive AFTER toDevanagari — पग/माथुं/
    // ताव/छातीमां/खंजवाळ/डाघ/खील. Measured before, same ten complaints: Gujarati
    // 4/10, and "ચામડી પર ખંજવાળ" (itchy skin) mapped to nothing — at a clinic
    // whose first patient is a dermatology patient. Skin Essence is Gujarati-
    // first, so this is the go-live lexicon, not a nicety.
    // पाय/कंबर/छाती (2026-08-29): Marathi leg, lower back, chest — with their
    // locative inflections listed explicitly per the boundary rule above.
    // Measured before: Marathi 7/10 complaints mapped vs Hindi 10/10; "माझा पाय
    // दुखतोय" mapped to NOTHING, so the roster slice handed the model all 39
    // doctors and a sore leg was booked with a cardiologist (call 82a3d38c).
    dev: ['पग', 'पगमां', 'पगनो', 'पगनी', 'पगमा', 'घुटने', 'घुटना', 'घुटनों', `गुडघ[${DV}]*`, 'जोड़', 'जोड़ों', 'जोडों', 'हड्डी', 'हड्डियों', 'कमर', 'कमरदर्द', 'पैर', 'पैरों', 'टांग', 'टाँग', 'एड़ी', 'पाँव', 'पांव', 'पाय', 'पायात', 'पायाला', 'पायाचा', 'पायाची', 'पायावर', 'पायांना', 'कंबर', 'कंबरेत', 'कंबरेला', 'कंबरदुखी', 'पाठदुखी', 'मणक्या'],
    pa: ['ਗੋਡਾ', 'ਗੋਡੇ', 'ਗੋਡਿਆਂ', 'ਲੱਤ', 'ਲੱਤਾਂ', 'ਪਿੱਠ', 'ਹੱਡੀ', 'ਕਮਰ', 'ਅੱਡੀ'],
    kn: [`ಮೊಣಕಾಲ[\u0C80-\u0CFF]*`, `ಮಂಡಿ[\u0C80-\u0CFF]*`, 'ಕಾಲು', `ಕಾಲುನೋವ[\u0C80-\u0CFF]*`, `ಕಾಲ್ನೋವ[\u0C80-\u0CFF]*`, `ಬೆನ್ನ[\u0C80-\u0CFF]*`, `ಮೂಳೆ[\u0C80-\u0CFF]*`, 'ಕಾಲಲ್ಲಿ', 'ಕಾಲಿನಲ್ಲಿ', `ಸೊಂಟ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Gynecology',
    // "ladies doctor" / "lady doctor" / "mahila"/"aurat" — the most common
    // ways Indian patients ask for a gynecologist — must map here.
    latin: '\\b(pregnancy|pregnant|garbh|periods|maasik|gynec|gynae|stree|stri|women|ladies|lady|mahila|aurat|menstr|prsv|prasav|delivery)\\b',
    // गरोदर / पाळी = Marathi pregnant / periods (red-team gap-fill).
    dev: ['गर्भ', 'गर्भवती', 'प्रसव', 'माहवारी', 'महिला', 'औरत', 'लेडीज', 'लेडी', 'पीरियड्स', 'पिरियड्स', 'पीरियड', 'मासिक', 'गायनी', 'प्रेग्नेंट', 'प्रेगनेंट', 'गरोदर', 'पाळी'],
    pa: ['ਗਰਭਵਤੀ', 'ਗਰਭ', 'ਮਾਹਵਾਰੀ', 'ਲੇਡੀ', 'ਲੇਡੀਜ਼', 'ਔਰਤਾਂ\\s*ਵਾਲ', 'ਮਹਿਲਾ'],
    kn: [`ಗರ್ಭ[\u0C80-\u0CFF]*`, 'ಮುಟ್ಟು', `ಮುಟ್ಟಿನ[\u0C80-\u0CFF]*`, `ಮುಟ್ಟಾಗ[\u0C80-\u0CFF]*`, 'ಲೇಡಿ', 'ಲೇಡೀಸ್', `ಮಹಿಳಾ`, `ಹೆಂಗಸ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Pediatric',
    latin: '\\b(bachha|bachhe|bachhi|baby|baccha|child|children|kids|pediatric|paediatric|infant)\\b',
    // बाळ… = Marathi baby/child (open suffix: बाळ, बाळा, बाळाला all child-related).
    dev: ['बच्चे', 'बच्चा', 'बच्ची', 'बच्चों', 'शिशु', `बाळ[${DV}]*`],
    pa: ['ਬੱਚਾ', 'ਬੱਚੇ', 'ਬੱਚੀ', 'ਬੱਚਿਆਂ'],
    kn: [`ಮಗು[\u0C80-\u0CFF]*`, `ಮಕ್ಕಳ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Neurology',
    // (sar|sir)\s*dard — "sir dard" transliteration was a confirmed miss.
    latin: '\\b((sar|sir)\\s*dard|sardard|head|headache|chakkar|nerve|brain|memory|migraine|stroke|seizure|epilep|paralys)\\b',
    // डोकं/डोके/डोकेदुखी = Marathi head/headache (red-team gap-fill).
    // सर/सिर can NEVER stand alone (सर = "sir", the everyday address form:
    // "सर, appointment चाहिए"), so they stay bound to दर्द — but with a WINDOW,
    // not strict adjacency: live 2026-07-25 the caller said "सर में दर्द हो रहा
    // है" (the most natural Hindi phrasing) and the strict `सर\s+दर्द` missed
    // it, so the deterministic history flow never started and the LLM
    // freelanced the pre-visit questions. Up to 2 Devanagari words may sit
    // between (में / में बहुत / का तेज़ …).
    dev: ['माथुं', 'माथु', 'माथामां', 'माथानो', 'माथुंदुखावो', `सर(?:\\s+[${DV}]+){0,2}\\s+दर्द`, `सिर(?:\\s+[${DV}]+){0,2}\\s+दर्द`, 'सरदर्द', 'सिरदर्द', 'चक्कर', 'दिमाग', 'डोकं', 'डोके', 'डोकेदुखी', 'मिर्गी', 'लकवा', 'अर्धांगवायू', 'माइग्रेन'],
    pa: ['ਸਿਰ', 'ਸਿਰਦਰਦ', 'ਚੱਕਰ'],
    kn: [`ತಲೆ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Nephrology',
    latin: '\\b(kidney|guda|peshab|urine|nephro|dialysis|gurda)\\b',
    dev: ['किडनी', 'गुर्दा', 'गुर्दे', 'पेशाब', 'डायलिसिस'],
    pa: ['ਕਿਡਨੀ', 'ਗੁਰਦਾ', 'ਗੁਰਦੇ', 'ਪਿਸ਼ਾਬ', 'ਡਾਇਲਸਿਸ'],
    kn: [`ಕಿಡ್ನಿ[\u0C80-\u0CFF]*`, `ಮೂತ್ರಪಿಂಡ[\u0C80-\u0CFF]*`, `ಡಯಾಲಿಸಿಸ್`]
  },
  {
    specialty: 'Urology',
    latin: '\\b(urinary|prostate|bladder|mootra|pesab|urology|stone|kidney\\s+stone)\\b',
    dev: ['मूत्र', 'प्रोस्टेट', 'पथरी'],
    pa: ['ਪਿਸ਼ਾਬ', 'ਪੱਥਰੀ', 'ਪ੍ਰੋਸਟੇਟ'],
    kn: [`ಮೂತ್ರ[\u0C80-\u0CFF]*`, `ಕಲ್ಲು ಇದೆ`, `ಪ್ರಾಸ್ಟೇಟ್`]
  },
  {
    specialty: 'Anesthesia',
    latin: '\\b(anesthesia|anesthetic|anaesthesia|surgery\\s+prep|pre-op)\\b',
    dev: ['बेहोशी'],
    pa: ['ਬੇਹੋਸ਼ੀ'],
    kn: ['ಅರಿವಳಿಕೆ']
  },
  {
    specialty: 'Surgery',
    latin: '\\b(surgery|surgeon|operation|operate|opration|operashion)\\b',
    // शस्त्रक्रिया = Marathi surgery.
    dev: ['सर्जरी', 'ऑपरेशन', 'शस्त्रक्रिया'],
    pa: ['ਅਪਰੇਸ਼ਨ', 'ਸਰਜਰੀ'],
    kn: [`ಆಪರೇಷನ್[\u0C80-\u0CFF]*`, `ಸರ್ಜರಿ[\u0C80-\u0CFF]*`, `ಶಸ್ತ್ರಚಿಕಿತ್ಸೆ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Dental',
    // The demo clinic IS dental. दात = Marathi tooth (दाता/दातार = donor —
    // blocked by the right boundary). दाढ = molar (दाढी = beard — blocked).
    latin: '\\b(daant|dant|teeth|tooth|molar|cavity|dentist|dental|rct|root\\s*canal|gum|gums|braces|filling|toothache)\\b',
    dev: ['दांत', 'दांतों', 'दाँत', 'दाँतों', 'दात', 'दाताम?ध्ये', 'दाढ', 'दाढेत', `मसूड[${DV}]*`, 'दंत', 'कॅविटी'],
    pa: ['ਦੰਦ', 'ਦੰਦਾਂ', 'ਦਾੜ੍ਹ', 'ਮਸੂੜ[\u0A00-\u0A7F]*'],
    kn: [`ಹಲ್ಲು[\u0C80-\u0CFF]*`, `ಹಲ್ಲಿನ[\u0C80-\u0CFF]*`, `ವಸಡ[\u0C80-\u0CFF]*`, `ದವಡೆ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Cardiology',
    latin: '\\b(dil|heart|cardiac|cardio|chest\\s*pain|seene?\\s*(me|mein)?\\s*dard|palpitation|dhadkan|angina)\\b',
    // दिल strict — the boundary is what stops "अपॉइंटमेंट दिला दो" → Cardiology.
    dev: ['छातीमां', 'छातीनो', 'छातीमा', 'दिल', 'हृदय', 'ह्रदय', 'सीने', 'सीना', 'छाती', 'छातीत', 'छातीतून', 'छातीवर', 'छातीमध्ये', 'धड़कन', 'धडधड'],
    pa: ['ਦਿਲ', 'ਛਾਤੀ', 'ਧੜਕਣ'],
    kn: [`ಎದೆ[\u0C80-\u0CFF]*`, `ಹೃದಯ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'ENT',
    latin: '\\b(kaan|kan|ear|gala|throat|naak|nak|nose|ent|tonsil|sinus|hearing|sunai|khichkhich)\\b',
    // गला/गले strict (अगला = next — blocked by left boundary). कान strict
    // (दुकान = shop — blocked). घसा/घशा… = Marathi throat (red-team gap-fill).
    dev: ['कान', 'कानों', 'कानात', 'गला', 'गले', 'घसा', `घश[${DV}]*`, 'नाक', 'नाकात', 'टॉन्सिल', 'साइनस', 'खिचखिच'],
    pa: ['ਗਲਾ', 'ਗਲੇ', 'ਕੰਨ', 'ਨੱਕ'],
    kn: [`ಗಂಟಲ[\u0C80-\u0CFF]*`, `ಕಿವಿ[\u0C80-\u0CFF]*`, `ಮೂಗು[\u0C80-\u0CFF]*`, `ಮೂಗಿನ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Dermatology',
    latin: '\\b(skin|twacha|khujli|itch|rash|pimple|acne|daag|daane|eczema|psoriasis|derma|charm|hairfall)\\b',
    // पुरळ = Marathi rash.
    dev: ['खंजवाळ', 'खंजवाल', 'चामडी', 'चामडीमां', 'चामडीनो', 'चामडीपर', 'डाघ', 'खील', 'खीलनो', `वाळ\\s+खर[${DV}]*`, 'कोढ', 'सोरायसिस', 'त्वचा', 'खुजली', 'चर्म', 'दाने', 'मुँहासे', 'मुहांसे', 'फुंसी', 'पुरळ', 'खाज'],
    pa: ['ਚਮੜੀ', 'ਖੁਜਲੀ', 'ਧੱਫੜ'],
    kn: [`ಚರ್ಮ[\u0C80-\u0CFF]*`, `ತುರಿಕೆ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Ophthalmology',
    latin: '\\b(aankh|ankh|aankhon|eye|eyes|vision|nazar|motiyabind|cataract|ophthal|netra|dhundhla)\\b',
    // डोळ… = Marathi eye (open suffix — डोळा/डोळे/डोळ्यांना/डोळ्यात are all eye).
    dev: ['आँख', 'आंख', 'आँखों', 'आंखों', `डोळ[${DV}]*`, 'नेत्र', 'मोतियाबिंद', 'दृष्टि', 'नज़र', 'नजर', 'धुंधला'],
    pa: ['ਅੱਖ', 'ਅੱਖਾਂ', 'ਨਜ਼ਰ'],
    kn: [`ಕಣ್ಣ[\u0C80-\u0CFF]*`, `ದೃಷ್ಟಿ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Psychiatry',
    latin: '\\b(depression|anxiety|tension|stress|mansik|mental|insomnia|panic|psychiat|udaas|ghabrahat)\\b',
    dev: ['मानसिक', 'डिप्रेशन', 'तनाव', 'घबराहट', 'उदास', 'बेचैनी', 'नींद\\s+नहीं'],
    pa: ['ਤਣਾਅ', 'ਡਿਪਰੈਸ਼ਨ', 'ਮਾਨਸਿਕ', 'ਘਬਰਾਹਟ', 'ਨੀਂਦ\\s*ਨਹੀਂ'],
    kn: [`ಒತ್ತಡ[\u0C80-\u0CFF]*`, `ಖಿನ್ನತೆ[\u0C80-\u0CFF]*`, `ಮಾನಸಿಕ[\u0C80-\u0CFF]*`, `ಡಿಪ್ರೆಶನ್`, `ನಿದ್ದೆ\\s*ಬರ(ುತ್ತ)?ಿಲ್ಲ`]
  },
  {
    specialty: 'Oncology',
    latin: '\\b(cancer|tumor|tumour|oncolog|gaanth|lump|chemo|kimo)\\b',
    dev: ['कैंसर', 'कर्करोग', 'ट्यूमर', 'गाँठ', 'गांठ', 'कीमो'],
    pa: ['ਕੈਂਸਰ', 'ਟਿਊਮਰ', 'ਗੰਢ', 'ਕੀਮੋ'],
    kn: [`ಕ್ಯಾನ್ಸರ್[\u0C80-\u0CFF]*`, `ಕ್ಯಾನ್ಸರ`, `ಟ್ಯೂಮರ್`, `ಗಡ್ಡೆ[\u0C80-\u0CFF]*`, `ಕಿಮೊ`]
  },
  {
    specialty: 'Gastroenterology',
    latin: '\\b(pet|stomach|acidity|gas|liver|jigar|digestion|pachan|ulcer|piles|bawaseer|constipation|kabz|loose\\s*motion|dast|jaundice|peelia|gastro)\\b',
    // पोट… = Marathi stomach (open suffix — पोट/पोटात/पोटदुखी; red-team gap-fill).
    dev: ['पेट', 'पेटदर्द', 'पेटमां', 'पेटनो', 'पेटमा', 'एसिडिटी', 'जिगर', 'लिवर', 'पाचन', 'बवासीर', 'कब्ज', 'दस्त', 'पीलिया', `पोट[${DV}]*`, 'उलटी', 'उल्टी', 'जुलाब'],
    pa: ['ਢਿੱਡ', 'ਪੇਟ', 'ਕਬਜ਼', 'ਉਲਟੀ'],
    kn: [`ಹೊಟ್ಟೆ[\u0C80-\u0CFF]*`, `ವಾಂತಿ[\u0C80-\u0CFF]*`, `ಮಲಬದ್ಧತೆ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Pulmonology',
    latin: '\\b(saans|sans|breath|breathing|asthma|dama|lungs|phephde|tb|tuberculosis|wheez)\\b',
    // घुटन (suffocation/breathlessness) belongs HERE, not Orthopedic — it is a
    // cardiopulmonary red-flag word, not the knee stem (red-team homograph fix).
    dev: ['साँस', 'सांस', 'दमा', `फेफड[${DV}]*`, 'श्वास', 'घुटन', 'धाप'],
    pa: ['ਸਾਹ', 'ਦਮਾ'],
    kn: [`ಉಸಿರ[\u0C80-\u0CFF]*`, `ದಮ್ಮ[\u0C80-\u0CFF]*`]
  },
  {
    specialty: 'Endocrinology',
    latin: '\\b(diabetes|sugar|madhumeh|thyroid|hormone|endocrin|insulin)\\b',
    dev: ['मधुमेह', 'शुगर', 'थायराइड', 'थाइरॉइड', 'हार्मोन'],
    pa: ['ਸ਼ੂਗਰ', 'ਥਾਇਰਾਇਡ'],
    kn: [`ಮಧುಮೇಹ[\u0C80-\u0CFF]*`, 'ಥೈರಾಯ್ಡ್', `ಶುಗರ್`, 'ಸಕ್ಕರೆ ಕಾಯಿಲೆ']
  },
  // Internal Medicine LAST — broadest catch-all. specialtiesForSymptom returns
  // ALL matches, so overlaps with the specialists above are intentional — a GP
  // shows alongside the specialist for shared symptoms.
  {
    specialty: 'Internal Medicine',
    latin: '\\b(bukhar|fever|cold|cough|khansi|jukam|jukaam|BP|diabetes|sugar|pet|stomach|general\\s+illness|hypertension|thyroid|allergy|weakness|kamzori|body\\s*ache)\\b',
    // पेट strict (पेटी = box); ताप/खोकला/अशक्तपणा = Marathi fever/cough/weakness.
    dev: [`पोट[${DV}]*`, 'ताव', 'तावमां', 'पेटमां', 'पेटनो', 'पेटमा', 'खांसीमां', 'उधरस', 'बुखार', 'खांसी', 'खोकला', 'जुकाम', 'पेट', 'पेटदर्द', 'कमज़ोरी', 'कमजोरी', 'ताप', 'अशक्तपणा', 'एलर्जी', 'ऍलर्जी'],
    pa: ['ਬੁਖਾਰ', 'ਖੰਘ', 'ਜ਼ੁਕਾਮ', 'ਕਮਜ਼ੋਰੀ'],
    kn: [`ಹೊಟ್ಟೆ[\u0C80-\u0CFF]*`, `ಜ್ವರ[\u0C80-\u0CFF]*`, `ಕೆಮ್ಮ[\u0C80-\u0CFF]*`, `ನೆಗಡಿ[\u0C80-\u0CFF]*`, `ಸುಸ್ತ[\u0C80-\u0CFF]*`]
  }
];

const SYMPTOM_TO_SPECIALTY = ENTRIES.map(({ specialty, latin, dev, pa, kn }) => ({
  specialty,
  patterns: compile(latin, dev, pa, kn)
}));

/**
 * Match a symptom / complaint phrase to one or more specialties.
 *
 * @param {string} text — patient's complaint in any supported language
 * @returns {string[]} — matched specialties, in scan order (most-specific first).
 *                       Empty array if nothing matched.
 */
function specialtiesForSymptom(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  for (const { specialty, patterns } of SYMPTOM_TO_SPECIALTY) {
    if (patterns.test(text)) matches.push(specialty);
  }
  return matches;
}

module.exports = { SYMPTOM_TO_SPECIALTY, specialtiesForSymptom };
