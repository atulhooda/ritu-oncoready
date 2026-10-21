// ═══════════════════════════════════════════════════════════════════════════
// PATIENT-SAFETY RESPONSE TEXT, SHARED BY EVERY CHANNEL.
//
// Lifted verbatim out of callHandler.js so a NON-VOICE channel can reach it
// without requiring callHandler. That is not tidiness — it is a load-bearing
// constraint. There is a require cycle:
//
//     callHandler.js -> crm.js -> whatsapp.js
//
// and crm.js DESTRUCTURES sendConfirmation at load time. So if whatsapp.js (or
// anything it pulls in) requires callHandler, that binding resolves to
// undefined permanently and the VOICE path silently stops sending its
// post-call WhatsApp confirmation. Node only warns; nothing throws.
//
// Rule, enforced by tests/test-no-callhandler-cycle.js:
//   the WhatsApp path must never require("./callHandler").
//
// callHandler.js now requires THIS file and re-exports both tables, so its own
// public surface is unchanged.
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const EMERGENCY_TEXTS = {
  'mr-IN': 'ही इमर्जन्सी वाटते. कृपया लगेच 108 डायल करा किंवा जवळच्या हॉस्पिटलमध्ये जा. मी हा कॉल इथे थांबवते जेणेकरून तुम्हाला मदत मिळेल. काळजी घ्या.',
  'hi-IN': 'यह इमरजेंसी लगती है। कृपया अभी 108 डायल करें या नज़दीकी हॉस्पिटल जाएं। मैं यह कॉल यहाँ रोक रही हूँ ताकि आप मदद ले सकें। ध्यान रखिए।',
  'en-IN': 'This sounds like an emergency. Please dial 108 right away or go to the nearest hospital. I am ending this call so you can get help. Take care.',
  'kn-IN': 'ಇದು ತುರ್ತು ಪರಿಸ್ಥಿತಿ ಎನಿಸುತ್ತದೆ. ದಯವಿಟ್ಟು ಈಗಲೇ 108 ಡಯಲ್ ಮಾಡಿ ಅಥವಾ ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆಗೆ ಹೋಗಿ. ನಿಮಗೆ ಸಹಾಯ ಸಿಗಲಿ ಎಂದು ನಾನು ಈ ಕರೆಯನ್ನು ಇಲ್ಲಿ ನಿಲ್ಲಿಸುತ್ತೇನೆ. ಜೋಪಾನ.',
  'pa-IN': 'ਇਹ ਐਮਰਜੈਂਸੀ ਲੱਗਦੀ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਹੁਣੇ 108 ਡਾਇਲ ਕਰੋ ਜਾਂ ਨੇੜਲੇ ਹਸਪਤਾਲ ਜਾਓ। ਮੈਂ ਇਹ ਕਾਲ ਇੱਥੇ ਰੋਕ ਰਹੀ ਹਾਂ ਤਾਂ ਜੋ ਤੁਸੀਂ ਮਦਦ ਲੈ ਸਕੋ। ਖ਼ਿਆਲ ਰੱਖਣਾ।',
  'ta-IN': 'இது அவசர நிலை போல் தெரிகிறது. உடனே 108 அழைக்கவும் அல்லது அருகிலுள்ள மருத்துவமனைக்குச் செல்லவும். நீங்கள் உதவி பெற இந்த அழைப்பை இங்கே நிறுத்துகிறேன். கவனமாக இருங்கள்.',
  'te-IN': 'ఇది ఎమర్జెన్సీ లాగా ఉంది. దయచేసి వెంటనే 108 డయల్ చేయండి లేదా దగ్గరలోని హాస్పిటల్‌కు వెళ్ళండి. మీకు సహాయం అందేలా నేను ఈ కాల్‌ను ఇక్కడ ఆపుతున్నాను. జాగ్రత్త.',
  'bn-IN': 'এটি জরুরি অবস্থা মনে হচ্ছে। অনুগ্রহ করে এখনই ১০৮ ডায়াল করুন বা নিকটস্থ হাসপাতালে যান। আপনি যাতে সাহায্য পান সেজন্য আমি কলটি এখানে শেষ করছি। ভালো থাকবেন।',
  'gu-IN': 'આ ઈમરજન્સી લાગે છે. કૃપા કરીને હમણાં જ 108 ડાયલ કરો અથવા નજીકની હોસ્પિટલમાં જાઓ. તમને મદદ મળે તે માટે હું આ કૉલ અહીં અટકાવું છું. ધ્યાન રાખજો.',
  'ml-IN': 'ഇത് അടിയന്തര സാഹചര്യമാണെന്ന് തോന്നുന്നു. ദയവായി ഉടൻ 108 ഡയൽ ചെയ്യൂ അല്ലെങ്കിൽ അടുത്തുള്ള ആശുപത്രിയിൽ പോകൂ. നിങ്ങൾക്ക് സഹായം ലഭിക്കാൻ ഞാൻ ഈ കോൾ ഇവിടെ നിർത്തുന്നു. ശ്രദ്ധിക്കണേ.',
  'od-IN': 'ଏହା ଜରୁରୀ ଅବସ୍ଥା ପରି ଲାଗୁଛି। ଦୟାକରି ଏବେ 108 ଡାଏଲ୍ କରନ୍ତୁ କିମ୍ବା ପାଖ ହସ୍ପିଟାଲ୍ ଯାଆନ୍ତୁ। ଆପଣ ସାହାଯ୍ୟ ପାଇବା ପାଇଁ ମୁଁ ଏହି କଲ୍ ଏଠାରେ ବନ୍ଦ କରୁଛି। ଯତ୍ନ ନିଅନ୍ତୁ।',
};

const SELF_HARM_TEXTS = {
  'en-IN': 'It sounds like you are going through something very painful, and I am really glad you reached out. Trained counsellors can help you right now — please call Tele-MANAS on 1 4 4 1 6, or toll-free on 1 800 891 4416. It is free, confidential, and available any time, day or night. Please call them now. You are not alone, and help is there for you.',
  'hi-IN': 'लगता है आप बहुत मुश्किल दौर से गुज़र रहे हैं, और मुझे खुशी है कि आपने कॉल किया। प्रशिक्षित काउंसलर अभी आपकी मदद कर सकते हैं — कृपया टेली-मानस हेल्पलाइन 1 4 4 1 6 पर कॉल करें, या टोल-फ्री नंबर 1 800 891 4416 पर। यह मुफ़्त है, पूरी तरह गोपनीय है, और दिन-रात उपलब्ध है। कृपया अभी कॉल करें। आप अकेले नहीं हैं, मदद मौजूद है।',
  'mr-IN': 'तुम्ही खूप कठीण प्रसंगातून जात आहात असं वाटतंय, आणि तुम्ही कॉल केलात याचा मला आनंद आहे. प्रशिक्षित समुपदेशक आत्ता तुम्हाला मदत करू शकतात — कृपया टेली-मानस हेल्पलाइन 1 4 4 1 6 वर कॉल करा, किंवा टोल-फ्री 1 800 891 4416 वर. ही सेवा मोफत, पूर्णपणे गोपनीय आणि दिवसरात्र उपलब्ध आहे. कृपया आत्ताच कॉल करा. तुम्ही एकटे नाही आहात, मदत आहे.',
  'ta-IN': 'நீங்கள் மிகவும் கடினமான நிலையைக் கடந்து செல்கிறீர்கள் என்று தோன்றுகிறது; நீங்கள் அழைத்ததில் மகிழ்ச்சி. பயிற்சி பெற்ற ஆலோசகர்கள் இப்போதே உதவ முடியும் — தயவுசெய்து டெலி-மனஸ் எண் 1 4 4 1 6 அல்லது கட்டணமில்லா எண் 1 800 891 4416 ஐ அழைக்கவும். இது இலவசம், ரகசியமானது, இரவும் பகலும் கிடைக்கும். தயவுசெய்து இப்போதே அழைக்கவும். நீங்கள் தனியாக இல்லை, உதவி இருக்கிறது.',
  'te-IN': 'మీరు చాలా కష్టమైన పరిస్థితి గుండా వెళుతున్నట్టు అనిపిస్తోంది; మీరు కాల్ చేసినందుకు సంతోషం. శిక్షణ పొందిన కౌన్సెలర్లు ఇప్పుడే సహాయం చేయగలరు — దయచేసి టెలీ-మానస్ నంబర్ 1 4 4 1 6 కి లేదా టోల్-ఫ్రీ 1 800 891 4416 కి కాల్ చేయండి. ఇది ఉచితం, గోప్యమైనది, పగలు రాత్రి అందుబాటులో ఉంటుంది. దయచేసి ఇప్పుడే కాల్ చేయండి. మీరు ఒంటరిగా లేరు, సహాయం ఉంది.',
  'kn-IN': 'ನೀವು ತುಂಬಾ ಕಷ್ಟದ ಸಮಯದಲ್ಲಿ ಇದ್ದೀರಿ ಎಂದು ಅನಿಸುತ್ತದೆ; ನೀವು ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಸಂತೋಷ. ತರಬೇತಿ ಪಡೆದ ಸಲಹೆಗಾರರು ಈಗಲೇ ಸಹಾಯ ಮಾಡಬಲ್ಲರು — ದಯವಿಟ್ಟು ಟೆಲಿ-ಮಾನಸ್ ಸಂಖ್ಯೆ 1 4 4 1 6 ಗೆ ಅಥವಾ ಟೋಲ್-ಫ್ರೀ 1 800 891 4416 ಗೆ ಕರೆ ಮಾಡಿ. ಇದು ಉಚಿತ, ಗೌಪ್ಯ, ಹಗಲು ರಾತ್ರಿ ಲಭ್ಯ. ದಯವಿಟ್ಟು ಈಗಲೇ ಕರೆ ಮಾಡಿ. ನೀವು ಒಬ್ಬಂಟಿಯಾಗಿಲ್ಲ, ಸಹಾಯ ಇದೆ.',
  'pa-IN': 'ਲੱਗਦਾ ਹੈ ਤੁਸੀਂ ਬਹੁਤ ਔਖੇ ਸਮੇਂ ਵਿੱਚੋਂ ਲੰਘ ਰਹੇ ਹੋ, ਅਤੇ ਮੈਨੂੰ ਖੁਸ਼ੀ ਹੈ ਕਿ ਤੁਸੀਂ ਕਾਲ ਕੀਤੀ। ਸਿਖਲਾਈ ਪ੍ਰਾਪਤ ਕਾਊਂਸਲਰ ਹੁਣੇ ਤੁਹਾਡੀ ਮਦਦ ਕਰ ਸਕਦੇ ਹਨ — ਕਿਰਪਾ ਕਰਕੇ ਟੈਲੀ-ਮਾਨਸ ਹੈਲਪਲਾਈਨ 1 4 4 1 6 ਤੇ ਕਾਲ ਕਰੋ, ਜਾਂ ਟੋਲ-ਫ੍ਰੀ 1 800 891 4416 ਤੇ। ਇਹ ਮੁਫ਼ਤ ਹੈ, ਪੂਰੀ ਤਰ੍ਹਾਂ ਗੁਪਤ ਹੈ, ਅਤੇ ਦਿਨ-ਰਾਤ ਉਪਲਬਧ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਹੁਣੇ ਕਾਲ ਕਰੋ। ਤੁਸੀਂ ਇਕੱਲੇ ਨਹੀਂ ਹੋ, ਮਦਦ ਮੌਜੂਦ ਹੈ।',
  'bn-IN': 'মনে হচ্ছে আপনি খুব কঠিন সময়ের মধ্য দিয়ে যাচ্ছেন, এবং আপনি কল করেছেন বলে আমি খুশি। প্রশিক্ষিত কাউন্সেলররা এখনই আপনাকে সাহায্য করতে পারেন — অনুগ্রহ করে টেলি-মানস হেল্পলাইন 1 4 4 1 6 নম্বরে কল করুন, বা টোল-ফ্রি 1 800 891 4416 নম্বরে। এটি বিনামূল্যে, সম্পূর্ণ গোপনীয়, এবং দিন-রাত পাওয়া যায়। অনুগ্রহ করে এখনই কল করুন। আপনি একা নন, সাহায্য আছে।',
  'gu-IN': 'લાગે છે કે તમે બહુ મુશ્કેલ સમયમાંથી પસાર થઈ રહ્યા છો, અને તમે કૉલ કર્યો તેનો મને આનંદ છે. પ્રશિક્ષિત કાઉન્સેલર હમણાં જ તમારી મદદ કરી શકે છે — કૃપા કરીને ટેલિ-માનસ હેલ્પલાઈન 1 4 4 1 6 પર કૉલ કરો, અથવા ટોલ-ફ્રી 1 800 891 4416 પર. આ મફત છે, સંપૂર્ણ ગોપનીય છે, અને દિવસ-રાત ઉપલબ્ધ છે. કૃપા કરીને હમણાં જ કૉલ કરો. તમે એકલા નથી, મદદ હાજર છે.',
  'ml-IN': 'നിങ്ങൾ വളരെ പ്രയാസകരമായ സമയത്തിലൂടെ കടന്നുപോകുകയാണെന്ന് തോന്നുന്നു; നിങ്ങൾ വിളിച്ചതിൽ എനിക്ക് സന്തോഷമുണ്ട്. പരിശീലനം ലഭിച്ച കൗൺസിലർമാർക്ക് ഇപ്പോൾ തന്നെ നിങ്ങളെ സഹായിക്കാൻ കഴിയും — ദയവായി ടെലി-മാനസ് ഹെൽപ്പ്‌ലൈൻ 1 4 4 1 6 ലേക്ക് വിളിക്കൂ, അല്ലെങ്കിൽ ടോൾ-ഫ്രീ 1 800 891 4416 ലേക്ക്. ഇത് സൗജന്യമാണ്, പൂർണ്ണമായും രഹസ്യമാണ്, രാവും പകലും ലഭ്യമാണ്. ദയവായി ഇപ്പോൾ തന്നെ വിളിക്കൂ. നിങ്ങൾ ഒറ്റയ്ക്കല്ല, സഹായം ഉണ്ട്.',
  'od-IN': 'ଲାଗୁଛି ଆପଣ ବହୁତ କଠିନ ସମୟ ଦେଇ ଯାଉଛନ୍ତି, ଏବଂ ଆପଣ କଲ୍ କରିଥିବାରୁ ମୁଁ ଖୁସି। ତାଲିମପ୍ରାପ୍ତ କାଉନସେଲର ଏବେ ଆପଣଙ୍କୁ ସାହାଯ୍ୟ କରିପାରିବେ — ଦୟାକରି ଟେଲି-ମାନସ ହେଲ୍ପଲାଇନ 1 4 4 1 6 ରେ କଲ୍ କରନ୍ତୁ, କିମ୍ବା ଟୋଲ୍-ଫ୍ରି 1 800 891 4416 ରେ। ଏହା ମାଗଣା, ସମ୍ପୂର୍ଣ୍ଣ ଗୋପନୀୟ, ଏବଂ ଦିନରାତି ଉପଲବ୍ଧ। ଦୟାକରି ଏବେ କଲ୍ କରନ୍ତୁ। ଆପଣ ଏକୁଟିଆ ନୁହଁନ୍ତି, ସାହାଯ୍ୟ ଅଛି।',
};


// ── THE SAME WORDS, ON A CHANNEL WITH NO CALL TO END ────────────────────────
// Every line above ends with a promise that only makes sense on the phone:
//   hi  "मैं यह कॉल यहाँ रोक रही हूँ ताकि आप मदद ले सकें।"
//   en  "I am ending this call so you can get help."
// On WhatsApp nothing is being ended, so that sentence is simply false — and it
// is false in the one message where the patient most needs to trust us.
//
// Rather than maintain an eleventh-language second copy of every string (which
// drifts, and drifts silently on the path nobody tests), this drops the sentence
// that mentions a CALL. One rule, eleven scripts: split on sentence boundaries,
// remove any sentence naming the call, rejoin.
//
// The instruction that matters — dial 108, or ring Tele-MANAS — always lives in
// a DIFFERENT sentence, so it always survives. tests/test-safety-text-channel.js
// asserts exactly that for all 11 languages: the call clause is gone AND the
// number is still there. A stripper that quietly removed the helpline would be
// far worse than the sentence it was fixing.
const CALL_WORDS = /कॉल|call|ಕರೆ|ਕਾਲ|அழைப்ப|కాల్|কল|કૉલ|കോൾ|କଲ୍/i;
// Digits in every script these tables use — Bengali writes 108 as ১০৮.
const ANY_DIGIT = /[0-9०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/;

function forTextChannel(s) {
  const kept = String(s || '')
    // Keep the delimiter so the rejoined text still reads as sentences.
    .split(/(?<=[।.])\s*/)
    // NEVER strip a sentence containing a NUMBER. The self-harm text says
    // "please CALL Tele-MANAS 14416" — it names the call, so a naive call-word
    // filter deletes the helpline itself and sends someone in crisis a message
    // of sympathy with no way to get help. Caught by
    // tests/test-safety-text-channel.js before this shipped, which is the entire
    // argument for asserting what must SURVIVE and not only what must go.
    // The instruction to dial always carries digits; "I am ending this call"
    // never does. That distinction holds in all eleven scripts.
    .filter(part => part.trim() && !(CALL_WORDS.test(part) && !ANY_DIGIT.test(part)))
    .join(' ')
    .trim();

  // Helpline numbers are written SPACED — "1 4 4 1 6", "1 800 891 4416" — so the
  // TTS reads them digit by digit instead of saying "fourteen thousand four
  // hundred sixteen". That is right for speech and wrong for text: on a phone a
  // run of separated digits is not recognised as a number, so it is not tappable
  // and cannot be copied cleanly. Someone in crisis should not be retyping it.
  //
  // Only runs of THREE OR MORE single digits collapse, which leaves grouped
  // numbers like "1 800 891 4416" alone — those already read as a phone number.
  return kept.replace(/\d(?:\s+\d){2,}/g, (m) => m.replace(/\s+/g, ''));
}

/**
 * The emergency line to SEND AS TEXT.
 * @param {string} lang     ISO code, e.g. 'hi-IN'
 * @param {boolean} selfHarm  self-harm gets Tele-MANAS 14416, NEVER 108.
 */
function emergencyTextFor(lang, selfHarm) {
  const table = selfHarm ? SELF_HARM_TEXTS : EMERGENCY_TEXTS;
  return forTextChannel(table[lang] || table['hi-IN']);
}

module.exports = { EMERGENCY_TEXTS, SELF_HARM_TEXTS, emergencyTextFor, forTextChannel, CALL_WORDS, ANY_DIGIT };
