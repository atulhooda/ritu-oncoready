// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC EMERGENCY DETECTOR — safety layer for the voice agent
//
// Runs in CallHandler._onTranscript BEFORE any LLM call. Pattern-matches
// patient transcripts for phrases that signal a life-threatening situation
// (cardiac, respiratory, neurological, hemorrhagic, traumatic). If any
// pattern matches, the call bypasses the LLM entirely and plays a hardcoded
// "call 108 / go to hospital" message, then ends the call.
//
// Why deterministic, not LLM-based:
//   - Works during LLM outages, provider rate-limits, network failures
//   - Works regardless of which model is primary (Scout, 70B, future)
//   - Sub-millisecond decision latency vs ~500-1500ms LLM round-trip
//   - No prompt-injection / jailbreak surface; cannot be "talked out of"
//   - Healthcare regulators expect deterministic safety nets, not "the model
//     usually catches it"
//
// Why phrase-anchored (not single-word):
//   - "dard" / "pain" / "chest" alone are far too common in routine clinic
//     calls and would false-fire constantly
//   - Patterns require a phrase that clearly signals acute distress, not
//     historical mention ("I had chest pain last year") or routine concern
//     ("my back hurts a little")
//
// Asymmetric error preference:
//   False positive  → patient annoyed, call ends, they re-call to book
//   False negative  → potential medical/legal liability event
//   ∴ when in doubt, fire. Better to occasionally cut off a non-emergency.
// ═══════════════════════════════════════════════════════════════════════════

// Each category groups patterns covering Hindi (Devanagari), Hinglish
// (transliterated Latin), and English. Patterns use \s+ for loose spacing
// and word boundaries for Latin tokens that could collide with longer words.
//
// Important: Devanagari has no case, so we keep those patterns as-is.
// Latin patterns use the /i flag for case-insensitive matching.

const EMERGENCY_PATTERNS = [
  {
    id: 'cardiac',
    label: 'Cardiac event (chest pain / heart attack)',
    patterns: [
      // English
      /\bchest\s+pain\b/i,
      /\bheart\s+attack\b/i,
      /\bcardiac\s+arrest\b/i,
      // Hinglish (Latin transliterated). Up to three tokens may sit between
      // the site and the symptom — "chest mein BAHUT ZYADA dard": a frightened
      // caller describing severity is exactly the caller this exists for, and
      // strict adjacency missed every intensified form (measured 2026-08-29).
      /\bchest\s+(mein|me)(?:\s+[^\s‖]+){0,3}\s+(dard|pain)\b/i,
      /\bseene\s+(mein|me)(?:\s+[^\s‖]+){0,3}\s+dard\b/i,
      /\bdil\s+(ka\s+(daura|dard)|mein\s+dard|me\s+dard)\b/i,
      /\bdil\s+ka\s+dauraa\b/i,
      // Devanagari — same bounded window: "छाती में बहुत तेज़ दर्द", "सीने में
      // बहुत जोर से दर्द" both missed on strict adjacency. Bounded at three
      // intervening tokens so "छाती में … कल … दर्द था" reaches no further than
      // the existing patterns already did (v1 has never handled tense).
      /सीने\s+में(?:\s+[^\s‖]+){0,3}\s+दर्द/,
      /छाती\s+में(?:\s+[^\s‖]+){0,3}\s+दर्द/,
      /दिल\s+का\s+दौरा/,
      /दिल\s+में\s+दर्द/,
      /दिल\s+का\s+दर्द/
    ]
  },
  {
    id: 'breathing',
    label: 'Respiratory distress (cannot breathe)',
    patterns: [
      // English  (note: /can'?t/ alone missed the full word "cannot")
      /\b(can'?t|cannot|can\s+not)\s+breathe\b/i,
      /\b(stopped|not)\s+breathing\b/i,
      /\bnot\s+able\s+to\s+breathe\b/i,
      /\b(struggling|gasping)\s+(to\s+|for\s+)?breath/i,
      // Hinglish
      /\bsaans\s+(nahi|nahin|nai)\s+aa\s+rahi\b/i,
      /\bsaans\s+ruk\s+gay/i,
      /\bsaans\s+(le|lene)\s+(nahi|nahin)\s+pa\s+rah/i,
      /\bdam\s+ghut\s+rah/i,
      // Devanagari
      /सांस\s+नहीं\s+आ\s+रही/,
      /साँस\s+नहीं\s+आ\s+रही/,
      /सांस\s+रुक/,
      /साँस\s+रुक/,
      /दम\s+घुट/
    ]
  },
  {
    id: 'unconscious',
    label: 'Loss of consciousness',
    patterns: [
      // English
      /\bunconscious\b/i,
      /\bpassed\s+out\b/i,
      /\bfainted\b/i,
      /\bcollapsed\b/i,
      // Hinglish
      /\bbehosh\b/i,
      /\bbehoshi\b/i,
      /\bhosh\s+(mein|me)\s+(nahi|nahin)\b/i,
      /\bhosh\s+nahi\s+(aa\s+rah|hai)/i,
      // Devanagari — note: JS \b is ASCII-only, so we don't use it here.
      // Surrounding whitespace/punctuation in real input bounds these words
      // naturally; the risk of substring false-positives on these tokens
      // is negligible (they are complete Hindi words, not affixes).
      /बेहोश/,
      /होश\s+नहीं/,
      /होश\s+में\s+नहीं/
    ]
  },
  {
    id: 'bleeding',
    label: 'Severe / uncontrolled bleeding',
    patterns: [
      // English
      /\bheavy\s+bleeding\b/i,
      /\bsevere\s+bleeding\b/i,
      /\bbleeding\s+(won'?t|wont|not|nahi)\s+stop\b/i,
      /\blot\s+of\s+blood\b/i,
      // Hinglish
      /\bbahut\s+khoon\b/i,
      /\bkhoon\s+bah\s+rah/i,
      /\bkhoon\s+nahi\s+(ruk|band)/i,
      /\bkhoon\s+(ruk|band)\s+nahi\b/i,
      /\bbahut\s+(jyada|zyada)\s+blood\b/i,
      // Devanagari
      /खून\s+बह/,
      /बहुत\s+खून/,
      /खून\s+नहीं\s+(रुक|बंद)/,
      /खून\s+(रुक|बंद)\s+नहीं/
    ]
  },
  {
    id: 'stroke',
    label: 'Stroke / paralysis',
    patterns: [
      // English
      /\bstroke\b/i,
      /\bbrain\s+stroke\b/i,
      /\bparalys/i,                              // paralysis / paralysed / paralyzed
      /\bsudden\s+(weakness|numbness)\b/i,
      // Hinglish
      /\blakwa\b/i,
      /\blakhva\b/i,
      /\bside\s+mar\s+gay/i,
      // Devanagari (JS \b is ASCII-only — relies on natural word boundaries)
      /लकवा/,
      /लक़वा/,
      /पक्षाघात/,
      /एक\s+तरफ\s+मार\s+गय/
    ]
  },
  {
    id: 'accident_trauma',
    label: 'Accident / head injury / severe trauma',
    patterns: [
      // English
      /\baccident\s+(happened|hua|ho\s+gay)/i,
      /\b(road|car|bike)\s+accident\b/i,
      /\bhead\s+injury\b/i,
      /\bsevere\s+(injury|trauma)\b/i,
      // Hinglish
      /\baccident\s+ho\s+(gay|gaya|gayi)\b/i,
      /\bdurghatna\b/i,
      /\bhadsa\b/i,
      /\bsir\s+(mein|me)\s+(chot|injury)\b/i,
      /\bsir\s+phut\s+gay/i,
      // Devanagari (JS \b is ASCII-only — relies on natural word boundaries)
      /दुर्घटना/,
      /हादसा/,
      /सिर\s+में\s+चोट/,
      /सिर\s+फूट\s+गय/
    ]
  },
  {
    id: 'severe_burn',
    label: 'Severe burn',
    patterns: [
      // English
      /\bsevere\s+burn\b/i,
      /\bbadly\s+burn/i,
      // Hinglish
      /\bbahut\s+jal\s+gay/i,
      /\bbadly\s+jal\s+gay/i,
      // Devanagari
      /बहुत\s+जल\s+गय/,
      /गंभीर\s+रूप\s+से\s+जल/
    ]
  },
  {
    id: 'seizure',
    label: 'Seizure / convulsion',
    patterns: [
      // English
      /\bseizure\b/i,
      /\bconvulsion/i,
      /\bfit\s+aa\s+rah/i,
      // Hinglish
      /\bmirgi\s+ka\s+daura\b/i,
      /\bdaur(a|e)\s+(pad|aa)\s+rah/i,
      // Devanagari
      /मिर्गी\s+का\s+दौरा/,
      /दौरा\s+पड़\s+रह/,
      /\bआक्षेप\b/
    ]
  },
  {
    id: 'choking',
    label: 'Choking',
    patterns: [
      /\bchoking\b/i,
      /\bgala\s+(ruk|band)\b/i,
      /\bkuch\s+atak\s+gay/i,
      /गला\s+(रुक|बंद)/,
      /कुछ\s+अटक\s+गय/
    ]
  },
  {
    id: 'overdose_poison',
    label: 'Overdose or poisoning',
    patterns: [
      /\boverdose\b/i,
      /\bpoison/i,
      /\bzehar\b/i,
      /\bzeher\b/i,
      // "goli", "goliya", "goliyon" etc. + "kha" — pill-eating constructions
      /\bgoli\w*\s+kha/i,
      // Devanagari (JS \b is ASCII-only — relies on natural word boundaries)
      /जहर/,
      /ज़हर/,
      /गोलियां?\s+खा/,
      /गोलियाँ?\s+खा/
    ]
  },
  {
    id: 'life_threat',
    label: 'Patient says they are dying / cries for rescue',
    // A patient saying "I'm dying" (esp. with severe headache → possible stroke)
    // must get the 108 message, NOT a 2-4h callback. Phrase-anchored so routine
    // hyperbole is rare; per the asymmetric-error rule, firing here is correct.
    patterns: [
      // English
      /\bi(?:'?m|\s+am)\s+dying\b/i,
      /\b(going|about)\s+to\s+die\b/i,
      /\bgonna\s+die\b/i,
      /\bsave\s+me\b/i,
      // Hinglish
      /\bmarne\s+wal[ai]\b/i,
      /\bmar\s+(jaunga|jaungi|jaaunga|jaaungi)\b/i,
      /\bmar\s+(raha|rahi)\s+(hu|hun|hoon)\b/i,
      /\bjaan\s+nikal\s+rah/i,
      /\b(mujhe\s+)?bacha\s*(lo|o)\b/i,
      // Devanagari
      /मरने\s*वाल[ाी]/,
      /मर\s*जाऊँ?ग[ाी]/,
      /मर\s*जाउँ?ग[ाी]/,
      /मर\s*रह[ाी]\s*ह/,
      /जान\s*निकल\s*रह/,
      /बचा\s*लो/,
      /मुझे\s*बचाओ/
    ]
  },
  {
    id: 'emergency_mr',
    label: 'Emergency stated in Marathi',
    // Marathi shares Devanagari with Hindi but uses different words — these
    // never fired before, so a Marathi caller's emergency ("मला इमरजेंसी आहे",
    // "जगू शकत नाही") slipped through and the call kept going. Phrase-anchored;
    // per the asymmetric-error rule, firing here is the safe default.
    patterns: [
      // "I have an emergency / it's an emergency"
      /मला\s*इमर(जेंसी|्जन्सी)/,
      /इमर(जेंसी|्जन्सी)\s*आहे/,
      // dying / won't survive
      /मरतोय|मरतेय|मरत\s*आहे|मरणार\s*आहे/,
      /जगू\s*शकत\s*नाही/,
      /जगू\s*ना\s*सकत/,
      /जगणार\s*नाही/,
      /वाचणार\s*नाही/,
      /वाचवा/,
      // cardiac
      /छाती(त|मध्ये)[^]{0,12}दुख/,
      /हृदयविकाराचा\s*झटका/,
      /हृदयात[^]{0,12}दुख/,
      // breathing
      /श्वास\s*(घेता\s*)?येत\s*नाही/,
      /दम\s*कोंड/,
      /धाप\s*लाग/,
      // unconscious
      /बेशुद्ध/,
      /शुद्ध\s*(हरपली|गेली|हरवली)/,
      // bleeding
      /खूप\s*रक्त/,
      /रक्तस्राव/,
      /रक्त\s*थांबत\s*नाही/,
      // seizure
      /फेफरे|आकडी\s*येत|झटके\s*येत/
    ]
  },
  // ── Multilingual groups (2026-07-09 systematic-audit fix) ──────────────────
  // The detector was hi/mr/en-only: a Kannada caller's "ಹೃದಯಾಘಾತ" never fired.
  // Same calibration as emergency_mr: phrase-anchored; ambiguous words need
  // verb/pain context; bare nouns only when unambiguous (heart attack, stroke,
  // poison, unconscious). Per the asymmetric-error rule, firing is the safe
  // default. Native emergency vocabulary per supported language.
  {
    id: 'emergency_kn',
    label: 'Emergency stated in Kannada',
    patterns: [
      /ಹೃದಯಾಘಾತ/, /(ತುಂಬಾ|ಜೋರಾಗಿ)[^]{0,10}ಎದೆನೋವ/, /ಎದೆ[^]{0,8}ನೋವು[^]{0,12}(ತುಂಬಾ|ಜೋರಾಗಿ)/,
      /ಉಸಿರಾಡ(ಲು|ಕ್ಕೆ)?\s*(ಆಗ(ುತ್ತ)?ಿಲ್ಲ|ಸಾಧ್ಯವಿಲ್ಲ)/, /ಉಸಿರು\s*(ಸಿಗ(ುತ್ತ)?ಿಲ್ಲ|ಕಟ್ಟ)/,
      /ಪ್ರಜ್ಞೆ\s*(ತಪ್ಪ|ಇಲ್ಲ)/, /ಮೂರ್ಛೆ/, /ಎಚ್ಚರ\s*(ಆಗ(ುತ್ತ)?ಿಲ್ಲ|ಇಲ್ಲ)/,
      /ರಕ್ತಸ್ರಾವ/, /(ತುಂಬಾ|ಬಹಳ)\s*ರಕ್ತ/, /ರಕ್ತ\s*ನಿಲ್ಲ(ುತ್ತ)?ಿಲ್ಲ/,
      /ಪಾರ್ಶ್ವವಾಯು/, /ಲಕ್ವಾ?\s*(ಹೊಡೆ|ಆಗ)/,
      /ಆಕ್ಸಿಡೆಂಟ್\s*(ಆಗಿದೆ|ಆಯ್ತು|ಆಯಿತು)/, /ಅಪಘಾತ\s*(ಆಗಿದೆ|ಆಯ್ತು|ಆಯಿತು)/,
      /ಸುಟ್ಟು\s*(ಹೋ|ಕೊಂಡ)/, /ಫಿಟ್ಸ್\s*(ಬಂದ|ಬರ್ತ|ಬರುತ್ತ)/, /ವಿಷ\s*(ಕುಡಿ|ಸೇವಿಸ|ತಿಂದ)/,
      /ಸಾಯ(ುತ್ತಿದ್ದ|್ತಾ\s*ಇದ್ದ)/, /ಉಳಿಯ(ುವುದಿಲ್ಲ|ಲ್ಲ)/, /ಎಮರ್ಜೆನ್ಸಿ\s*(ಇದೆ|ಆಗಿದೆ)/
    ]
  },
  {
    id: 'emergency_pa',
    label: 'Emergency stated in Punjabi',
    patterns: [
      /ਦਿਲ\s*ਦਾ\s*ਦੌਰਾ/, /ਹਾਰਟ\s*ਅਟੈਕ/, /ਛਾਤੀ[^]{0,10}(ਬਹੁਤ|ਜ਼ੋਰ)[^]{0,10}ਦਰਦ/,
      /ਸਾਹ\s*ਨਹੀਂ\s*(ਆ|ਲੈ)/, /ਸਾਹ\s*(ਰੁਕ|ਘੁੱਟ)/, /ਦਮ\s*ਘੁੱਟ/,
      /ਬੇਹੋਸ਼/, /ਹੋਸ਼\s*(ਨਹੀਂ|ਗੁਆ)/,
      /ਖੂਨ\s*(ਵਗ|ਵਹਿ|ਨਹੀਂ\s*ਰੁਕ)/, /ਬਹੁਤ\s*ਖੂਨ/,
      /ਲਕਵਾ/, /ਸਟ੍ਰੋਕ/, /ਐਕਸੀਡੈਂਟ\s*(ਹੋ\s*ਗਿਆ|ਹੋਇਆ)/, /ਹਾਦਸਾ\s*ਹੋ/,
      /ਸੜ\s*(ਗਿਆ|ਗਈ)/, /ਦੌਰਾ\s*(ਪੈ|ਪਿਆ)/, /ਜ਼ਹਿਰ\s*(ਖਾ|ਪੀ)/,
      /ਮਰ\s*(ਰਿਹਾ|ਰਹੀ|ਜਾਵੇਗਾ|ਜਾਵੇਗੀ)/, /ਬਚਾਓ/, /ਐਮਰਜੈਂਸੀ\s*(ਹੈ|ਹੋ)/
    ]
  },
  {
    id: 'emergency_ta',
    label: 'Emergency stated in Tamil',
    patterns: [
      /மாரடைப்பு/, /நெஞ்சு[^]{0,8}வலி[^]{0,12}(ரொம்ப|மிகவும்)/, /(ரொம்ப|மிகவும்)[^]{0,10}நெஞ்சு\s*வலி/,
      /மூச்சு\s*(விட\s*முடியவில்லை|வரவில்லை|திணற)/, /சுவாசிக்க\s*முடியவில்லை/,
      /மயக்கம்\s*(ஆகி|போட்ட|அடைந்)/, /சுயநினைவு\s*இல்லை/,
      /இரத்தப்போக்கு/, /ரத்தம்\s*(நிற்கவில்லை|வழி|கொட்டு)/, /(ரொம்ப|அதிக)\s*ரத்தம்/,
      /பக்கவாதம்/, /ஸ்ட்ரோக்/, /விபத்து\s*(ஆகி|நடந்த)/, /ஆக்சிடென்ட்\s*(ஆகி|ஆச்சு)/,
      /தீக்காயம்/, /சுட்டு\s*(விட்ட|போச்)/, /வலிப்பு\s*(வந்த|வருகிற)/, /விஷம்\s*(குடி|சாப்பிட்ட)/,
      /சாக(ப்\s*போ|ிறே)/, /உயிர்\s*போ/, /எமர்ஜென்சி/
    ]
  },
  {
    id: 'emergency_te',
    label: 'Emergency stated in Telugu',
    patterns: [
      /గుండెపోటు/, /గుండె[^]{0,8}నొప్పి[^]{0,12}(చాలా|ఎక్కువ)/, /(చాలా|ఎక్కువ)[^]{0,10}గుండె\s*నొప్పి/,
      /ఊపిరి\s*(ఆడ(టం|డం)?\s*లేదు|తీసుకోలేక)/, /శ్వాస\s*(ఆడటం\s*లేదు|తీసుకోలేక)/,
      /స్పృహ\s*(లేదు|తప్పి|కోల్పో)/, /మూర్ఛ\s*(వచ్చి|పోయ)/,
      /రక్తస్రావం/, /రక్తం\s*(ఆగ(డం)?\s*లేదు|కారు|పోతు)/, /(చాలా|ఎక్కువ)\s*రక్తం/,
      /పక్షవాతం/, /స్ట్రోక్/, /ప్రమాదం\s*(జరిగి|అయి)/, /యాక్సిడెంట్\s*(అయి|జరిగి)/,
      /కాలి(పోయ|ంది)/, /ఫిట్స్\s*(వచ్చ|వస్తు)/, /విషం\s*(తాగ|తిన్న|మింగ)/,
      /చనిపోతున్నా/, /బతక(డు|దు)/, /ఎమర్జెన్సీ/
    ]
  },
  {
    id: 'emergency_bn',
    label: 'Emergency stated in Bengali',
    patterns: [
      /হার্ট\s*অ্যাটাক/, /বুকে[^]{0,10}(খুব|প্রচণ্ড)[^]{0,10}ব্যথা/,
      /শ্বাস\s*(নিতে\s*পারছ|বন্ধ|আটকে)/, /নিঃশ্বাস\s*(নিতে\s*পারছ|বন্ধ)/, /দম\s*(বন্ধ|আটকে)/,
      /অজ্ঞান/, /জ্ঞান\s*(নেই|হারিয়ে)/,
      /রক্তক্ষরণ/, /রক্ত\s*(বন্ধ\s*হচ্ছে\s*না|পড়ছে|ঝরছে)/, /(অনেক|প্রচুর)\s*রক্ত/,
      /স্ট্রোক/, /পক্ষাঘাত/, /দুর্ঘটনা\s*(হয়েছে|ঘটেছে)/, /অ্যাক্সিডেন্ট\s*(হয়েছে|করেছে)/,
      /পুড়ে\s*(গেছে|গিয়েছে)/, /খিঁচুনি/, /বিষ\s*(খেয়েছে|খেয়ে)/,
      /মারা\s*যাচ্ছ/, /বাঁচবে\s*না/, /ইমার্জেন্সি/
    ]
  },
  {
    id: 'emergency_gu',
    label: 'Emergency stated in Gujarati',
    patterns: [
      /હાર્ટ\s*એટેક/, /હૃદયરોગનો\s*હુમલો/, /છાતીમાં[^]{0,10}(બહુ|ખૂબ)[^]{0,10}દુખાવો/,
      /શ્વાસ\s*(નથી\s*લેવાતો|લેવામાં\s*તકલીફ|રૂંધા)/, /દમ\s*ઘૂંટ/,
      /બેભાન/, /ભાન\s*(નથી|ગુમાવ)/,
      /રક્તસ્રાવ/, /લોહી\s*(વહી|બંધ\s*નથી\s*થતું|નીકળ)/, /(બહુ|ખૂબ)\s*લોહી/,
      /લકવો/, /સ્ટ્રોક/, /અકસ્માત\s*(થયો|થઈ)/, /એક્સિડન્ટ\s*(થયો|થઈ)/,
      /દાઝી\s*(ગયું|ગયો|ગઈ)/, /આંચકી/, /ખેંચ\s*આવ/, /ઝેર\s*(ખાધું|પીધું)/,
      /મરી\s*(રહ્યો|રહી|જશે)/, /બચશે\s*નહીં/, /ઈમરજન્સી/
    ]
  },
  {
    id: 'emergency_ml',
    label: 'Emergency stated in Malayalam',
    patterns: [
      /ഹൃദയാഘാതം/, /നെഞ്ചു?\s*വേദന[^]{0,12}(കഠിന|ശക്തമായ|വല്ലാത്ത)/, /(കഠിനമായ|ശക്തമായ)[^]{0,10}നെഞ്ചു?വേദന/,
      /ശ്വാസം\s*(കിട്ടുന്നില്ല|എടുക്കാൻ\s*പറ്റുന്നില്ല|മുട്ട)/, /ശ്വാസംമുട്ട്/,
      /ബോധം\s*(ഇല്ല|പോയി|കെട്ട)/, /ബോധക്ഷയം/,
      /രക്തസ്രാവം/, /രക്തം\s*(നിൽക്കുന്നില്ല|ഒഴുകു)/, /(ഒരുപാട്|കൂടുതൽ)\s*രക്തം/,
      /പക്ഷാഘാതം/, /സ്ട്രോക്ക്/, /അപകടം\s*(പറ്റി|ഉണ്ടായി)/, /ആക്സിഡന്റ്\s*(പറ്റി|ആയി)/,
      /പൊള്ള(ൽ|ി)/, /അപസ്മാരം/, /ഫിറ്റ്സ്\s*(വന്നു|വരുന്നു)/, /വിഷം\s*(കഴിച്ചു|കുടിച്ചു)/,
      /മരിക്കു(ന്നു|കയാണ്)/, /രക്ഷിക്ക(ണം|ൂ)/, /എമർജൻസി/
    ]
  },
  {
    id: 'emergency_od',
    label: 'Emergency stated in Odia',
    patterns: [
      /ହାର୍ଟ\s*ଆଟାକ/, /ହୃଦଘାତ/, /ଛାତିରେ[^]{0,10}(ବହୁତ|ଭୀଷଣ)[^]{0,10}ଯନ୍ତ୍ରଣା/,
      /ନିଶ୍ୱାସ\s*(ନେଇ\s*ପାରୁନ|ବନ୍ଦ|ରୁନ୍ଧ)/, /ଦମ\s*ବନ୍ଦ/,
      /ବେହୋଶ/, /ଚେତା\s*(ନାହିଁ|ହରାଇ)/,
      /ରକ୍ତସ୍ରାବ/, /ରକ୍ତ\s*(ବନ୍ଦ\s*ହେଉନାହିଁ|ବହୁଛି|ଝରୁଛି)/, /(ବହୁତ|ଅଧିକ)\s*ରକ୍ତ/,
      /ପକ୍ଷାଘାତ/, /ଷ୍ଟ୍ରୋକ/, /ଦୁର୍ଘଟଣା\s*(ହୋଇଛି|ଘଟିଛି)/, /ଆକ୍ସିଡେଣ୍ଟ\s*(ହୋଇଛି|ହେଲା)/,
      /ପୋଡ଼ି\s*(ଯାଇଛି|ଗଲା)/, /ବାତ\s*ମାଡ଼/, /ଫିଟ୍\s*(ଆସୁଛି|ହେଉଛି)/, /ବିଷ\s*(ଖାଇ|ପିଇ)/,
      /ମରି\s*ଯାଉଛ/, /ବଞ୍ଚିବ\s*ନାହିଁ/, /ଏମରଜେନ୍ସି/
    ]
  },
  // ── English / Hinglish colloquial gaps (2026-07-11 adversarial bug-drive) ─────
  // The old detector was strong on clinical terms but missed the phrases a
  // layperson (or a doctor-judge on stage) actually says. All route to the same
  // 108 message and are phrase-anchored to keep routine calls quiet.
  {
    id: 'emergency_generic',
    label: 'Explicit emergency / ambulance request',
    patterns: [
      // The single most likely on-stage phrase.
      /\b(it'?s|it\s+is|this\s+is|i\s+have|there'?s|there\s+is|we\s+have)\s+(an?\s+)?(medical\s+)?emergency\b/i,
      /\bmedical\s+emergency\b/i,
      /\b(send|call|get|need|want|bhej|bulao?)\s+(an?\s+|the\s+|ek\s+)?ambulance\b/i,
      /\bambulance\s+(bhej|bhejo|chahiye|bula|bulao)/i,
      /\bemergency\s+ha[iy]\b/i,
      // The English WORD inside a Hindi sentence (2026-08-29). A caller said he
      // wanted to be seen "emergency में" and was offered a slot three days out
      // with no 108 — the frames above are all-English or all-Devanagari, and
      // the scheduling regex happily consumed the same word. Adjacent forms
      // only, so "emergency नहीं है" (a denial) still does not fire.
      /\bemergency\b\s*(है|हैं|मे|में)\b/i,
      // Bounded on the left: without it, "bhejiYE emergency" — the seam between
      // two copies in the composed probe — matched as "ye emergency".
      /(?:(?<![\p{L}])(?:ये|यह)|\b(?:ye|yeh))\s+emergency\b/iu,
      /\bemergency\s+(?:में|me|mein)\s+(?:दिखाना|dikhana|दिखा|dikha)/i,
      /(?:अर्जेंट|अर्जन्ट|\burgent)\s*(?:है|hai)[,،]?\s*(?:अभी|abhi|जल्दी|jaldi|turant|तुरंत)/i,
      /इमर(जेंसी|्जेंसी|जेन्सी|्जन्सी)/,
      // The same frames in the other ten languages (2026-09-03): the word
      // "emergency" followed by that language's "is" / "in", adjacent — native
      // script on the raw copy, and the romanized copy for the transliterated
      // forms. "emergency नाही आहे" (a denial) puts नाही between and stays quiet.
      /\bemergency\b\s*(?:आहे|मध्ये|ಇದೆ|ಇದ್ದೆ|ആണ്|ഉണ്ട്|ఉంది|இருக்கு|இருக்கிறது|છે|ਹੈ|আছে|ଅଛି)/iu,
      /\bemergency\s+(?:ahe|aahe|madhye|ide|aanu|anu|undu|undi|irukku|irukkirathu|che|chhe|ache|achhe|achi)\b/i,
      /(?<![\p{L}])(?:हे|ही|ಇದು|ഇത്|ఇది|இது|આ|ਇਹ|এটা|ଏହା)\s+emergency\b/iu,
      /\bemergency\s+(?:मध्ये|madhye|ಯಲ್ಲಿ|യിൽ|లో|இல்|માં|ਵਿੱਚ|তে|ରେ)\s*(?:दाखव|dakhav|ತೋರಿಸ|കാണിക്ക|చూపించ|காட்ட|બતાવ|ਦਿਖਾ|দেখা|ଦେଖା)/iu,
      /एमरजेंसी/, /एम्बुलेंस\s*(भेज|बुला|चाहिए)/, /एंबुलेंस\s*(भेज|बुला|चाहिए)/
    ]
  },
  {
    id: 'cyanosis',
    label: 'Cyanosis (turning blue) — respiratory/cardiac emergency',
    patterns: [
      /\b(turning|going|gone|turned)\s+blue\b/i,
      /\blips?\s+(are\s+|have\s+gone\s+|turning\s+)?blue\b/i,
      /\bblue\s+in\s+the\s+face\b/i,
      /\bneel[ae]\s+pad\s+rah/i,
      /नील[ेा]\s*पड़?\s*रह/, /होंठ\s*नील[ेा]/, /निळ[ाे]\s*पड/
    ]
  },
  {
    id: 'cardiac_colloquial',
    label: 'Cardiac — colloquial chest description',
    patterns: [
      /\b(crushing|tight|tightness|heavy|heaviness|pressure|squeezing)\b[^]{0,18}\bchest\b/i,
      /\bchest\b[^]{0,18}\b(crushing|tight|tightness|heavy|heaviness|pressure|squeezing|really\s+hurts?)\b/i,
      /\bpain\s+in\s+(my|the)\s+chest\b/i
    ]
  },
  {
    id: 'stroke_fast',
    label: 'Stroke — FAST symptoms (layperson description)',
    patterns: [
      /\bface\s+(is\s+)?drooping\b/i,
      /\bdrooping\s+(on\s+one\s+side|face)\b/i,
      /\bslurred\s+speech\b/i,
      /\bspeech\s+(is\s+)?slurr/i,
      /\bcan'?t\s+(speak|talk)\s+(properly|clearly)\b/i,
      /\bone\s+side\s+[^]{0,15}(weak|numb|not\s+moving|paraly)/i,
      /\bmunh\s+tedha\b/i,
      /मुँह\s*टेढ़?ा/, /मुंह\s*टेढ़?ा/
    ]
  },
  {
    id: 'unconscious_colloquial',
    label: 'Loss of consciousness — colloquial',
    patterns: [
      /\bwon'?t\s+wake\s+up\b/i,
      /\bnot\s+waking\s+up\b/i,
      /\bnot\s+responding\b[^]{0,20}\b(wake|breath|move|call|shak|conscious)/i,
      /\bjaag\s+nahi\s+rah/i,
      /जाग\s*नहीं\s*रह/, /होश\s*नहीं\s*आ\s*रह/
    ]
  },
  {
    id: 'self_harm',
    label: 'Suicidal ideation / self-harm',
    // Routed to a mental-health helpline (not 108) via SELF_HARM_TEXTS in
    // callHandler. Critical that this NEVER reaches the booking LLM.
    patterns: [
      /\bkill\s+myself\b/i,
      /\bend\s+(my\s+life|it\s+all|everything)\b/i,
      /\btake\s+my\s+(own\s+)?life\b/i,
      /\bsuicid/i,
      /\bharm\s+myself\b/i,
      /\bwant\s+to\s+die\b/i,
      /\bdon'?t\s+want\s+to\s+(live|be\s+alive)\b/i,
      /\bno\s+reason\s+to\s+live\b/i,
      /\baatmahatya\b/i, /\bkhudkushi\b/i, /\bkhud\s*kushi\b/i,
      /\b(jeena|jina)\s+nahi\s+chah/i,
      /\bzinda\s+nahi\s+reh(na|un)/i,
      /\bmar\s+jaana\s+chah/i,
      /आत्महत्या/, /आत्म\s*हत्या/, /खुदकुशी/, /ख़ुदकुशी/,
      /जीना\s*नहीं\s*चाह/, /ज[िी]ंदा\s*नहीं\s*रह/,
      /मरना\s*चाह(ता|ती|ती)/, /मर\s*जाना\s*चाह/,
      // ── PASSIVE IDEATION (2026-08-29) ──────────────────────────────────
      // Everything above needs the caller to name an ACT — kill, suicide,
      // मरना चाहता. The commonest presentation, and the one that precedes an
      // attempt, is passive: "I don't want to live", "जीने का मन नहीं करता".
      // Measured before this block: "मुझे जीने का मन नहीं करता", "I do not want
      // to live anymore", "मैं खुद को खत्म कर लूंगा" — all missed by BOTH
      // detectors, on the one category that is enforced. जीना-the-staircase
      // homonym (v2's worst FP) is avoided by requiring मन/इच्छा/बेकार beside it.
      /जीने\s*का\s*मन\s*नहीं/, /जीने\s*की\s*इच्छा\s*नहीं/, /जीना\s*बेकार/,
      /खुद\s*को\s*ख[त़]?त्?म\s*कर/, /अपनी\s*जान\s*ले\s*(लूँ|लूं|लूंग|लेना|लेती|लेता)/,
      /मर\s*जाऊँ?\s*तो\s*(अच्छा|ठीक|बेहतर)/,
      /\bjeene\s+ka\s+man\s+nahi/i, /\bjeene\s+ki\s+ich+ha\s+nahi/i, /\bjeena\s+bekaa?r/i,
      /\bkhud\s+ko\s+khat[am]+\s+kar/i, /\bapni\s+jaan\s+le\s+l/i, /\bmar\s+jaa?un\s+to\s+(ach+a|theek|behtar)/i,
      /\bdo\s+not\s+want\s+to\s+(live|be\s+alive)\b/i, /\bbetter\s+off\s+dead\b/i, /\bno\s+point\s+(in\s+)?living\b/i,
      /\bnothing\s+to\s+live\s+for\b/i,
      // ── TAMIL / TELUGU / MALAYALAM (2026-09-03) — absent from BOTH detectors ──
      // until today. Written against the RAW copy of the probe (native script);
      // romanize() is lossy for these scripts, so the Latin tail cannot carry them.
      /வாழ\s*(?:ஆசை|விருப்பம்)\s*இல்லை/, /வாழ\s*விரும்பவில்லை/, /சாக(?:ணும்|\s*வேண்டும்)/, /தற்கொலை/,
      /బతకాలని\s*లేదు/, /బతకడం\s*ఇష్టం\s*లేదు/, /చనిపోవాలని\s*(?:ఉంది|అనిపిస్తుంది)/, /ఆత్మహత్య/,
      /ജീവിക്കാൻ\s*(?:താൽപ്പര്യ|താല്പര്യ|ഇഷ്ട)മില്ല/, /ജീവിക്കണ്ട/, /മരിക്കണം/, /മരിച്ചാൽ\s*മതി/, /ആത്മഹത്യ/,
      // Marathi
      /जगावंसं\s*वाटत\s*नाही/, /जगावसं\s*वाटत\s*नाही/, /जगायची\s*इच्छा\s*नाही/, /मरून\s*जावंसं/, /संपवून\s*टाक/,
      // Kannada
      /ಬದುಕೋಕೆ\s*ಇಷ್ಟ\s*ಇಲ್ಲ/, /ಬದುಕಲು\s*ಇಷ್ಟ\s*ಇಲ್ಲ/, /ಸಾಯಬೇಕು/, /ಆತ್ಮಹತ್ಯೆ/,
      // ── ENGLISH SPOKEN INTO AN INDIC-PINNED SESSION ────────────────────
      // A Kannada-pinned session writes "I want to die" as ಐ ವಾಂಟ್ ಟು ಡೈ; no
      // English regex can see it. callHandler now appends romanize() of the
      // Devanagari probe, which yields "ai vant tu da" / "susad" — matched here
      // on the spelling romanize actually emits (measured), not on English.
      /\b(ai\s+)?vant\s+tu\s+da[iy]?\b/i, /\bsu+sa+[iy]?d\b/i
    ]
  },
  {
    id: 'indic_script_english',
    label: 'English clinical words written in an Indic script',
    // Same mechanism as the self-harm tail above, routed to 108. Patterns are
    // written against what romanize(toDevanagari(x)) EMITS for each script
    // (measured 2026-08-29): "hart atyak" (kn), "hart atak" (te), "hart attak"
    // (ta), "hart etek" (gu), "hart ayatak" (bn); "chest pen"; "kyant brit";
    // "briting prablan"; "strok"; "an‌kanshas"; "bliding"; "sijar"; "phits".
    // Known gap, stated: Malayalam romanizes chest pain to "chesrr peyin".
    patterns: [
      /\bhart\s+\w{0,2}t+\w{0,2}k\b/i,           // heart attack, five scripts
      /\bches(?:t|rr)\s+pe[iy]*[nॻ]/iu,          // chest pain: te 'chest peyin', kn 'chest pen', ml 'chesrr peyiॻ' (measured)
      /\bk[iy]?a?nt\s+bri+t+h?\b/i,               // can't breathe
      /\bbriting\s+prabl/i,                        // breathing problem
      /\bbrit+h?\s+(nahi|nai)\b/i,                // breath nahi
      /\bstro+k\b/i,                               // stroke
      /\ban\W?kans?h?as\b/i,                      // unconscious
      /\bbli+ding\b/i,                             // bleeding
      /\bsi+[jz]h?ar\b/i, /\bphits\b/i          // seizure / fits
    ]
  }
];

// Pre-flatten for slightly faster matching on every transcript.
const FLAT_PATTERNS = EMERGENCY_PATTERNS.flatMap(group =>
  group.patterns.map(re => ({ re, id: group.id, label: group.label }))
);

/**
 * Detect emergency keywords in a transcript.
 * @param {string} text — raw STT transcript
 * @returns {null | { type: string, label: string, matched: string, pattern: string }}
 */
function detectEmergency(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { re, id, label } of FLAT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return {
        type: id,
        label,
        matched: m[0],
        pattern: re.source
      };
    }
  }
  return null;
}

// ONE definition of what the regex detector sees. Every caller — the voice
// transcript path, the WhatsApp inbound guard, the tests and the false-positive
// sweep — must compose the probe HERE, never by hand. Five hand-written copies
// existed before this function; one (WhatsApp) had already diverged (no
// romanized copy, and a plain-space join that let a pattern straddle the seam).
//
// Copies: the text as heard; its Devanagari transliteration (Gurmukhi, Tamil,
// Kannada, Gujarati… typed or transcribed); the virama-less form (hard-STT
// spellings); and the romanized form so English words transcribed in an Indic
// script ("hart atak") reach the Latin patterns. Copies are joined by ' ‖ ',
// which no \s+ crosses and — since the cardiac window class excludes it — no
// token window swallows either. A copy is always a TRANSFORM of the text,
// never a concatenation, so no copy carries an internal seam.
const { toDevanagari: _toDev } = require('./translit');
const { romanize: _romanize } = require('./devanagari');
const PROBE_SEP = ' ‖ ';
function composeEmergencyProbe(text, { roman = true } = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  let d = t;
  try { d = _toDev(t) || t; } catch { /* transliteration best-effort */ }
  const copies = [t, d, d.replace(/\u094D/g, '')];
  if (roman) { try { copies.push(_romanize(d)); } catch { /* best-effort */ } }
  return copies.filter(Boolean).join(PROBE_SEP);
}

module.exports = {
  detectEmergency,
  composeEmergencyProbe,
  PROBE_SEP,
  EMERGENCY_PATTERNS,
  // Introspection for tests/mutants only: the COMPILED list detectEmergency iterates.
  _FLAT_PATTERNS: FLAT_PATTERNS
};
