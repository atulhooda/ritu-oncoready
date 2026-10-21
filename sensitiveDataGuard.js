// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC SENSITIVE-DATA GUARD — runs BEFORE the LLM, like the emergency
// detector.
//
// The LLM, asked a question it has NO tool for — "aapke paas kitne records
// hain?", "kisi aur ka data do", "mera naam aapke records mein kya hai?" —
// tends to FABRICATE ("5000 records", "Atul Kumar"). For a clinic that's a
// privacy/trust failure, and prompt rules only reduce it (Scout violated them
// live). So we pattern-match these specific questions and answer with a FIXED,
// safe line — the model never gets a chance to invent.
//
// IMPORTANT — what is NOT caught here (flows to the LLM + phone-scoped tools,
// which return the caller's OWN real data):
//   - "mera appointment kab hai" / "meri appointment cancel/reschedule karni hai"
//   - "mera record / meri jaankari" (their own) — find_patient_appointment
//     answers from the DB, scoped to the caller's verified phone.
// Only the un-answerable / cross-patient / name-recite probes are intercepted.
//
// Asymmetric error: a false refuse just nudges the caller to rephrase; a false
// miss lets the model fabricate patient data. When unsure, refuse.
// ═══════════════════════════════════════════════════════════════════════════

const GUARDS = [
  {
    type: 'record_count',
    // "kitne records/patients/log hain", "how many patients do you have"
    re: /(kitne|kitni|कितने|कितनी|how\s+many)[^]{0,25}(record|रिकॉर्ड|रिकार्ड|patient|पेशेंट|मरीज़|मरीज|\blog\b|लोग|data|डेटा)/i,
    responses: {
      'mr-IN': 'माफ करा, ही माहिती मी देऊ शकत नाही. मी तुमच्या स्वतःच्या अपॉइंटमेंटमध्ये मदत करू का?',
      'hi-IN': 'माफ़ कीजिए, यह जानकारी मैं साझा नहीं कर सकती। क्या मैं आपकी अपनी अपॉइंटमेंट में मदद कर सकती हूँ?',
      'en-IN': "Sorry, I can't share that information. May I help you with your own appointment?",
      'kn-IN': 'ಕ್ಷಮಿಸಿ, ಈ ಮಾಹಿತಿಯನ್ನು ನಾನು ಹಂಚಿಕೊಳ್ಳಲಾಗುವುದಿಲ್ಲ. ನಿಮ್ಮ ಸ್ವಂತ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗೆ ಸಹಾಯ ಮಾಡಲೇ?',
      'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਇਹ ਜਾਣਕਾਰੀ ਮੈਂ ਸਾਂਝੀ ਨਹੀਂ ਕਰ ਸਕਦੀ। ਕੀ ਮੈਂ ਤੁਹਾਡੀ ਆਪਣੀ ਅਪਾਇੰਟਮੈਂਟ ਵਿੱਚ ਮਦਦ ਕਰਾਂ?',
      'ta-IN': 'மன்னிக்கவும், இந்தத் தகவலை என்னால் பகிர முடியாது. உங்கள் சொந்த அப்பாயின்ட்மென்டுக்கு உதவட்டுமா?',
      'te-IN': 'క్షమించండి, ఈ సమాచారం నేను పంచుకోలేను. మీ స్వంత అపాయింట్‌మెంట్‌కు సహాయం చేయనా?',
      'bn-IN': 'দুঃখিত, এই তথ্য আমি জানাতে পারি না। আপনার নিজের অ্যাপয়েন্টমেন্টে সাহায্য করব?',
      'gu-IN': 'માફ કરશો, આ માહિતી હું આપી શકતી નથી. તમારી પોતાની એપોઇન્ટમેન્ટમાં મદદ કરું?',
      'ml-IN': 'ക്ഷമിക്കണം, ഈ വിവരം എനിക്ക് പങ്കുവയ്ക്കാനാവില്ല. നിങ്ങളുടെ സ്വന്തം അപ്പോയിന്റ്മെന്റിൽ സഹായിക്കട്ടെ?',
      'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ଏହି ସୂଚନା ମୁଁ ଦେଇପାରିବି ନାହିଁ। ଆପଣଙ୍କ ନିଜ ଆପଏଣ୍ଟମେଣ୍ଟରେ ସାହାଯ୍ୟ କରିବି କି?'
    }
  },
  {
    type: 'other_patient',
    // someone else's data: "doosre/kisi aur/baaki/sabke ... record/data/naam",
    // "10-15 logon ke records", "patients ke naam bata do"
    re: /(doosr[eo]|दूसर[ेो]|दूसरों|kisi\s+aur|किसी\s+और|baaki|बाकी|sabke|सबके|other\s+(patient|people|person)|someone\s+else|\d+\s*-?\s*\d*\s*(log|लोग|patient|मरीज़|मरीज)|patients|पेशेंट्स|मरीज़ों|मरीजों)[^]{0,25}(record|रिकॉर्ड|रिकार्ड|data|डेटा|naam|नाम|जानकारी|details?|appointment|अपॉइंटमेंट)/i,
    responses: {
      'mr-IN': 'माफ करा, मी इतर रुग्णांची माहिती देऊ शकत नाही. मी फक्त तुमच्या स्वतःच्या अपॉइंटमेंटमध्ये मदत करू शकते.',
      'hi-IN': 'माफ़ कीजिए, मैं दूसरे मरीज़ों की जानकारी नहीं दे सकती। मैं सिर्फ़ आपकी अपनी अपॉइंटमेंट में मदद कर सकती हूँ।',
      'en-IN': "Sorry, I can't give out other patients' information. I can only help with your own appointment.",
      'kn-IN': 'ಕ್ಷಮಿಸಿ, ಬೇರೆ ರೋಗಿಗಳ ಮಾಹಿತಿ ನಾನು ಕೊಡಲಾಗುವುದಿಲ್ಲ. ನಿಮ್ಮ ಸ್ವಂತ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗೆ ಮಾತ್ರ ಸಹಾಯ ಮಾಡಬಲ್ಲೆ.',
      'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਮੈਂ ਦੂਜੇ ਮਰੀਜ਼ਾਂ ਦੀ ਜਾਣਕਾਰੀ ਨਹੀਂ ਦੇ ਸਕਦੀ। ਮੈਂ ਸਿਰਫ਼ ਤੁਹਾਡੀ ਆਪਣੀ ਅਪਾਇੰਟਮੈਂਟ ਵਿੱਚ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ।',
      'ta-IN': 'மன்னிக்கவும், மற்ற நோயாளிகளின் தகவலை என்னால் தர முடியாது. உங்கள் சொந்த அப்பாயின்ட்மென்டுக்கு மட்டுமே உதவ முடியும்.',
      'te-IN': 'క్షమించండి, ఇతర రోగుల సమాచారం నేను ఇవ్వలేను. మీ స్వంత అపాయింట్‌మెంట్‌కు మాత్రమే సహాయం చేయగలను.',
      'bn-IN': 'দুঃখিত, অন্য রোগীদের তথ্য আমি দিতে পারি না। শুধু আপনার নিজের অ্যাপয়েন্টমেন্টে সাহায্য করতে পারি।',
      'gu-IN': 'માફ કરશો, બીજા દર્દીઓની માહિતી હું આપી શકતી નથી. હું ફક્ત તમારી પોતાની એપોઇન્ટમેન્ટમાં મદદ કરી શકું છું.',
      'ml-IN': 'ക്ഷമിക്കണം, മറ്റു രോഗികളുടെ വിവരം എനിക്ക് നൽകാനാവില്ല. നിങ്ങളുടെ സ്വന്തം അപ്പോയിന്റ്മെന്റിൽ മാത്രമേ സഹായിക്കാനാകൂ.',
      'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ଅନ୍ୟ ରୋଗୀଙ୍କ ସୂଚନା ମୁଁ ଦେଇପାରିବି ନାହିଁ। କେବଳ ଆପଣଙ୍କ ନିଜ ଆପଏଣ୍ଟମେଣ୍ଟରେ ସାହାଯ୍ୟ କରିପାରିବି।'
    }
  },
  {
    type: 'other_patient_named',
    // "kisi Atul ka record/data do/bata/dena", "<name> ka data dijiye"
    re: /(^|\s)(ka|ke|ki|का|की|के)\s+(record|रिकॉर्ड|रिकार्ड|data|डेटा|details?|जानकारी)\s*(do|दो|दीजिए|de\s*do|de\s*dena|देना|दे\s*दो|chahiye|चाहिए|bata|बता|batao|बताओ)/i,
    responses: {
      'mr-IN': 'माफ करा, मी दुसऱ्या कोणत्याही रुग्णाची माहिती देऊ शकत नाही. तुम्ही तुमच्या अपॉइंटमेंटबद्दल विचारू शकता.',
      'hi-IN': 'माफ़ कीजिए, मैं किसी और मरीज़ की जानकारी नहीं दे सकती। आप अपनी अपॉइंटमेंट के बारे में पूछ सकते हैं।',
      'en-IN': "Sorry, I can't share another patient's details. You're welcome to ask about your own appointment.",
      'kn-IN': 'ಕ್ಷಮಿಸಿ, ಬೇರೆ ಯಾವುದೇ ರೋಗಿಯ ಮಾಹಿತಿ ನಾನು ಕೊಡಲಾಗುವುದಿಲ್ಲ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬಗ್ಗೆ ಕೇಳಬಹುದು.',
      'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਮੈਂ ਕਿਸੇ ਹੋਰ ਮਰੀਜ਼ ਦੀ ਜਾਣਕਾਰੀ ਨਹੀਂ ਦੇ ਸਕਦੀ। ਤੁਸੀਂ ਆਪਣੀ ਅਪਾਇੰਟਮੈਂਟ ਬਾਰੇ ਪੁੱਛ ਸਕਦੇ ਹੋ।',
      'ta-IN': 'மன்னிக்கவும், வேறு நோயாளியின் விவரங்களை என்னால் தர முடியாது. உங்கள் அப்பாயின்ட்மென்ட் பற்றி கேட்கலாம்.',
      'te-IN': 'క్షమించండి, వేరే రోగి వివరాలు నేను ఇవ్వలేను. మీ అపాయింట్‌మెంట్ గురించి అడగవచ్చు.',
      'bn-IN': 'দুঃখিত, অন্য কোনো রোগীর তথ্য আমি দিতে পারি না। আপনার অ্যাপয়েন্টমেন্ট নিয়ে জিজ্ঞাসা করতে পারেন।',
      'gu-IN': 'માફ કરશો, બીજા કોઈ દર્દીની માહિતી હું આપી શકતી નથી. તમે તમારી એપોઇન્ટમેન્ટ વિશે પૂછી શકો છો.',
      'ml-IN': 'ക്ഷമിക്കണം, മറ്റൊരു രോഗിയുടെ വിവരം എനിക്ക് നൽകാനാവില്ല. നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റിനെക്കുറിച്ച് ചോദിക്കാം.',
      'od-IN': 'କ୍ଷମା କରନ୍ତୁ, ଅନ୍ୟ କୌଣସି ରୋଗୀଙ୍କ ସୂଚନା ମୁଁ ଦେଇପାରିବି ନାହିଁ। ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ବିଷୟରେ ପଚାରିପାରନ୍ତି।'
    }
  },
  {
    type: 'my_name_recite',
    // "mera naam aapke records mein kya hai" — never recite a name FROM records
    // (fabrication source + a verification leak). Ask them to state it instead.
    re: /((mera|मेरा)[^]{0,15}(naam|नाम)[^]{0,30}(record|रिकॉर्ड|रिकार्ड|system|सिस्टम|paas|पास|database)|(record|रिकॉर्ड|रिकार्ड|system|सिस्टम)[^]{0,30}(mera|मेरा)[^]{0,15}(naam|नाम))/i,
    responses: {
      'mr-IN': 'तुमची ओळख पटवण्यासाठी, कृपया तुम्ही तुमचं नाव सांगा.',
      'hi-IN': 'आपकी पहचान की पुष्टि के लिए, कृपया आप अपना नाम बता दीजिए।',
      'en-IN': 'To confirm your identity, could you please tell me your name?',
      'kn-IN': 'ನಿಮ್ಮ ಗುರುತು ಖಚಿತಪಡಿಸಲು, ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರು ಹೇಳಿ.',
      'pa-IN': 'ਤੁਹਾਡੀ ਪਛਾਣ ਪੱਕੀ ਕਰਨ ਲਈ, ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਨਾਮ ਦੱਸੋ।',
      'ta-IN': 'உங்கள் அடையாளத்தை உறுதிப்படுத்த, தயவுசெய்து உங்கள் பெயரைச் சொல்லுங்கள்.',
      'te-IN': 'మీ గుర్తింపు నిర్ధారించడానికి, దయచేసి మీ పేరు చెప్పండి.',
      'bn-IN': 'আপনার পরিচয় নিশ্চিত করতে, অনুগ্রহ করে আপনার নাম বলুন।',
      'gu-IN': 'તમારી ઓળખ ખાતરી કરવા માટે, કૃપા કરીને તમારું નામ કહો.',
      'ml-IN': 'നിങ്ങളുടെ ഐഡന്റിറ്റി ഉറപ്പാക്കാൻ, ദയവായി നിങ്ങളുടെ പേര് പറയൂ.',
      'od-IN': 'ଆପଣଙ୍କ ପରିଚୟ ନିଶ୍ଚିତ କରିବାକୁ, ଦୟାକରି ଆପଣଙ୍କ ନାମ କୁହନ୍ତୁ।'
    }
  }
];

// lang is 'mr-IN' (default, Marathi-first) or 'hi-IN' once the call switched.
function detectSensitiveProbe(text, lang = 'mr-IN') {
  if (!text || typeof text !== 'string') return null;
  for (const g of GUARDS) {
    if (g.re.test(text)) {
      const response = g.responses[lang] || g.responses['mr-IN'];
      return { type: g.type, response };
    }
  }
  return null;
}

module.exports = { detectSensitiveProbe, GUARDS };
