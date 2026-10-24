// ═══════════════════════════════════════════════════════════════════════════
// MACHINE DATE/TIME LEAKING INTO A SPOKEN REPLY
//
// LIVE CALL c394b280c4808227d8e28c957d231a8d, 2026-08-13, a Hindi call:
//
//     RITU  उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?
//
// "Thursday 17:00" — an English weekday and a 24-hour clock, read aloud by a
// Marathi/Hindi TTS voice to a caller who has spoken nothing but Hindi. It is
// the same class as the REQUEST_CALLBACK sentinel a patient heard two days
// earlier (42cb33f): machine-shaped text reaching a human ear because nothing
// stood between the model's output and the speaker.
//
// Nobody in an Indian clinic says "seventeen hundred hours". They say "shaam
// paanch baje". A caller hearing "Thursday 17:00" does not hear a small
// formatting slip — they hear a machine, and they stop trusting the rest of the
// sentence.
//
// WHY POST-PROCESS RATHER THAN INSTRUCT THE MODEL. The prompt already asks for
// the caller's language, and the model complies almost always. "Almost always"
// is not a property you can test, and this is the second time in three days
// that a rare model formatting choice has reached a patient. A deterministic
// pass is checkable; a prompt line is a hope.
//
// SCOPE, deliberately narrow: weekday names and clock times. Not a translator.
// If a reply carries English prose, that is a different defect and this must
// not paper over it — it is logged by the caller, not silently rewritten.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// The 11 languages the canned lines already ship in. A language absent here is
// left untouched and reported, rather than half-converted — a Bengali reply
// with an English weekday is a bug worth seeing, not worth hiding badly.
const WEEKDAYS = {
  'hi-IN': ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  'mr-IN': ['रविवार', 'सोमवार', 'मंगळवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  'kn-IN': ['ಭಾನುವಾರ', 'ಸೋಮವಾರ', 'ಮಂಗಳವಾರ', 'ಬುಧವಾರ', 'ಗುರುವಾರ', 'ಶುಕ್ರವಾರ', 'ಶನಿವಾರ'],
  'pa-IN': ['ਐਤਵਾਰ', 'ਸੋਮਵਾਰ', 'ਮੰਗਲਵਾਰ', 'ਬੁੱਧਵਾਰ', 'ਵੀਰਵਾਰ', 'ਸ਼ੁੱਕਰਵਾਰ', 'ਸ਼ਨੀਵਾਰ'],
  'ta-IN': ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி'],
  'te-IN': ['ఆదివారం', 'సోమవారం', 'మంగళవారం', 'బుధవారం', 'గురువారం', 'శుక్రవారం', 'శనివారం'],
  'bn-IN': ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'],
  'gu-IN': ['રવિવાર', 'સોમવાર', 'મંગળવાર', 'બુધવાર', 'ગુરુવાર', 'શુક્રવાર', 'શનિવાર'],
  'ml-IN': ['ഞായർ', 'തിങ്കൾ', 'ചൊവ്വ', 'ബുധൻ', 'വ്യാഴം', 'വെള്ളി', 'ശനി'],
  'od-IN': ['ରବିବାର', 'ସୋମବାର', 'ମଙ୍ଗଳବାର', 'ବୁଧବାର', 'ଗୁରୁବାର', 'ଶୁକ୍ରବାର', 'ଶନିବାର'],
};

// Part-of-day words, so a converted time is spoken the way it is spoken. A bare
// "5:00" is ambiguous in every one of these languages exactly as it is in
// English; the clinic runs evening OPD and morning OPD and the caller needs to
// know which.
const DAYPART = {
  'hi-IN': { morning: 'सुबह', afternoon: 'दोपहर', evening: 'शाम', night: 'रात' },
  'mr-IN': { morning: 'सकाळी', afternoon: 'दुपारी', evening: 'संध्याकाळी', night: 'रात्री' },
  'kn-IN': { morning: 'ಬೆಳಿಗ್ಗೆ', afternoon: 'ಮಧ್ಯಾಹ್ನ', evening: 'ಸಂಜೆ', night: 'ರಾತ್ರಿ' },
  'pa-IN': { morning: 'ਸਵੇਰੇ', afternoon: 'ਦੁਪਹਿਰੇ', evening: 'ਸ਼ਾਮ', night: 'ਰਾਤ' },
  'ta-IN': { morning: 'காலை', afternoon: 'மதியம்', evening: 'மாலை', night: 'இரவு' },
  'te-IN': { morning: 'ఉదయం', afternoon: 'మధ్యాహ్నం', evening: 'సాయంత్రం', night: 'రాత్రి' },
  'bn-IN': { morning: 'সকাল', afternoon: 'দুপুর', evening: 'বিকেল', night: 'রাত' },
  'gu-IN': { morning: 'સવારે', afternoon: 'બપોરે', evening: 'સાંજે', night: 'રાત્રે' },
  'ml-IN': { morning: 'രാവിലെ', afternoon: 'ഉച്ചയ്ക്ക്', evening: 'വൈകുന്നേരം', night: 'രാത്രി' },
  'od-IN': { morning: 'ସକାଳେ', afternoon: 'ଅପରାହ୍ନ', evening: 'ସନ୍ଧ୍ୟା', night: 'ରାତି' },
};

const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EN_DAY_RE = /\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|satur)(?:day)?\b/gi;
const EN_DAY_INDEX = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, wednes: 3, thu: 4, thur: 4, thurs: 4, fri: 5, satur: 6, sat: 6 };

// 24-hour clock: 13:00–23:59, and 00:xx. 1:00–12:59 is already how people say
// it, so it is left alone — rewriting "5:00" to "5:00" gains nothing and risks
// mangling a correct sentence.
const H24_RE = /\b(0?\d|1\d|2[0-3]):([0-5]\d)\b/g;

// MIDNIGHT IS NIGHT, NOT MORNING. The first version read `h24 < 12` as morning
// and turned 00:30 into "सुबह 12:30" — half past midnight announced as half past
// twelve in the morning. The boundaries below are the ones people actually use:
// 12-4am is रात, and the day starts at 5.
function daypart(h24, lang) {
  const d = DAYPART[lang];
  if (!d) return null;
  if (h24 < 5) return d.night;
  if (h24 < 12) return d.morning;
  if (h24 < 16) return d.afternoon;
  if (h24 < 20) return d.evening;
  return d.night;
}

/**
 * Rewrite machine-shaped weekdays and 24-hour clock times into the caller's
 * language. Returns { text, changed, leaks } — `leaks` names what was found, so
 * a caller can log it even when the language has no table and nothing was
 * rewritten.
 *
 * English calls are returned untouched: "Thursday 17:00" is still poor style in
 * en-IN, but it is not the defect this exists for and silently rewriting a
 * correct-language reply is its own risk.
 */
function localizeDateTime(text, languageCode) {
  const src = String(text || '');
  const lang = String(languageCode || '');
  const leaks = [];

  const foundDay = src.match(EN_DAY_RE);
  const found24 = [];
  src.replace(H24_RE, (m, h) => { if (Number(h) >= 13 || Number(h) === 0) found24.push(m); return m; });
  if (foundDay) leaks.push(...foundDay.map((d) => `weekday:${d}`));
  if (found24.length) leaks.push(...found24.map((t) => `24h:${t}`));

  // Nothing to do, or a language we have no words for — report, never guess.
  if (!leaks.length) return { text: src, changed: false, leaks: [] };
  if (!WEEKDAYS[lang]) return { text: src, changed: false, leaks };

  let out = src.replace(EN_DAY_RE, (m) => {
    const idx = EN_DAY_INDEX[m.toLowerCase().replace(/day$/, '')];
    return idx === undefined ? m : WEEKDAYS[lang][idx];
  });

  out = out.replace(H24_RE, (m, h, mm) => {
    const H = Number(h);
    if (H < 13 && H !== 0) return m;      // already spoken the way people speak
    const h12 = H === 0 ? 12 : H - 12;
    const part = daypart(H, lang);
    return part ? `${part} ${h12}:${mm}` : `${h12}:${mm}`;
  });

  return { text: out, changed: out !== src, leaks };
}

module.exports = { localizeDateTime, WEEKDAYS, DAYPART, _EN_DAYS: EN_DAYS };
