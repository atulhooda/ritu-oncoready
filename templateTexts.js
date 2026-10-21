'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// templateTexts.js — the WhatsApp template set, as data. NO side effects.
//
// Required by two callers with opposite needs: tools/metaTemplates.js (which
// submits these to Meta and sets SKIP_BOOT_AUDIO at require time — a tool,
// never the server) and outbox.js (the server, at boot, which must NOT
// inherit that). So the texts, the VARS contract, the per-language clinic
// name rule and the payload builder live here, importable by both.
//
// One definition per template, in gu/hi/mr/en, with EXACTLY the body
// variables the server sends. {clinic} is filled per language: the local-
// script name for the clinic's own language, the Latin name everywhere else.
// See tools/metaTemplates.js for the Meta rules these satisfy.
// ═══════════════════════════════════════════════════════════════════════════

// ── the contract: how many body variables the SERVER sends, per template ───
//   whatsapp.js sendConfirmation  {1 name, 2 "Wed, 16 Sept, 5:30 pm"}
//   whatsapp.js sendReminder      {1 name, 2 "Wed, 16 Sept, 5:30 pm"}
//   whatsapp.js sendFollowup      {1 name}
//   scheduler.js runNoShowJob     {}
//   scheduler.js runMissedCallJob {}
//   outbox (module 4)             {1 name, 2 doctor, 3 "Wed, 16 Sept, 5:30 pm"}
//   staff alert (module 2b)       {1 patient, 2 phone, 3 reason}
const VARS = {
  appointment_confirmation: 2,
  appointment_reminder: 2,
  appointment_followup: 1,
  no_show_recovery: 0,
  missed_call_recovery: 0,
  doctor_leave_reschedule: 3,
  staff_callback_alert: 3,
};

// ── the texts: no marketing, no offers, nothing Meta could call promotional ─
const TEMPLATE_TEXT = {
  appointment_confirmation: {
    gu: 'નમસ્તે {{1}}, {clinic} ખાતે તમારી એપોઇન્ટમેન્ટ {{2}} માટે નક્કી થઈ ગઈ છે. કૃપા કરીને સમયસર પધારો. સમય બદલવો હોય તો ક્લિનિકને કૉલ કરો.',
    hi: 'नमस्ते {{1}}, {clinic} में आपकी अपॉइंटमेंट {{2}} के लिए तय हो गई है। कृपया समय पर आएँ। समय बदलना हो तो क्लिनिक को कॉल करें।',
    mr: 'नमस्कार {{1}}, {clinic} येथे तुमची अपॉइंटमेंट {{2}} साठी निश्चित झाली आहे. कृपया वेळेवर या. वेळ बदलायची असल्यास क्लिनिकला कॉल करा.',
    en: 'Hello {{1}}, your appointment at {clinic} is confirmed for {{2}}. Please arrive on time. To change the time, please call the clinic.',
  },
  // {{2}} carries the day as well as the time: the template cannot say
  // "today"/"tomorrow" (the plain-text fallback picks that per send), so a
  // bare "5:30 pm" was ambiguous at any reminder lead over a few hours.
  appointment_reminder: {
    gu: 'નમસ્તે {{1}}, યાદ અપાવવા માટે: {clinic} ખાતે તમારી એપોઇન્ટમેન્ટ {{2}} છે. કૃપા કરીને સમયસર પધારો.',
    hi: 'नमस्ते {{1}}, याद दिलाने के लिए: {clinic} में आपकी अपॉइंटमेंट {{2}} है। कृपया समय पर आएँ।',
    mr: 'नमस्कार {{1}}, आठवण: {clinic} येथे तुमची अपॉइंटमेंट {{2}} आहे. कृपया वेळेवर या.',
    en: 'Hello {{1}}, a reminder: your appointment at {clinic} is on {{2}}. Please arrive on time.',
  },
  appointment_followup: {
    gu: 'નમસ્તે {{1}}, આજે {clinic} ની મુલાકાત લેવા બદલ આભાર. તમારી સારવાર વિશે કોઈ પ્રશ્ન હોય કે ફોલો-અપ એપોઇન્ટમેન્ટ જોઈતી હોય, તો અહીં જવાબ આપો અથવા ક્લિનિકને કૉલ કરો.',
    hi: 'नमस्ते {{1}}, आज {clinic} आने के लिए धन्यवाद। अपने इलाज के बारे में कोई सवाल हो या फ़ॉलो-अप अपॉइंटमेंट चाहिए, तो यहाँ जवाब दें या क्लिनिक को कॉल करें।',
    mr: 'नमस्कार {{1}}, आज {clinic} येथे आल्याबद्दल धन्यवाद. तुमच्या उपचारांबद्दल काही प्रश्न असल्यास किंवा फॉलो-अप अपॉइंटमेंट हवी असल्यास इथे उत्तर द्या किंवा क्लिनिकला कॉल करा.',
    en: 'Hello {{1}}, thank you for visiting {clinic} today. If you have any questions about your treatment or need a follow-up appointment, reply here or call the clinic.',
  },
  no_show_recovery: {
    gu: '{clinic} ખાતે આજની તમારી એપોઇન્ટમેન્ટ પર તમે આવી શક્યા નહીં. નવો સમય નક્કી કરવો હોય તો અહીં જવાબ આપો અથવા ક્લિનિકને કૉલ કરો.',
    hi: '{clinic} में आज की आपकी अपॉइंटमेंट पर आप नहीं आ सके। नया समय तय करना हो तो यहाँ जवाब दें या क्लिनिक को कॉल करें।',
    mr: '{clinic} येथील आजच्या तुमच्या अपॉइंटमेंटला तुम्ही येऊ शकला नाहीत. नवीन वेळ ठरवायची असल्यास इथे उत्तर द्या किंवा क्लिनिकला कॉल करा.',
    en: 'We missed you at your appointment at {clinic} today. To book a new time, reply here or call the clinic.',
  },
  missed_call_recovery: {
    gu: 'તમે {clinic} ને કૉલ કર્યો હતો પણ અમે વાત કરી શક્યા નહીં. અમે કેવી રીતે મદદ કરી શકીએ? અહીં જવાબ આપો, અમે તમારો સંપર્ક કરીશું.',
    hi: 'आपने {clinic} को कॉल किया था पर बात नहीं हो पाई। हम कैसे मदद कर सकते हैं? यहाँ जवाब दें, हम आपसे संपर्क करेंगे।',
    mr: 'तुम्ही {clinic} ला कॉल केला होता पण बोलणे होऊ शकले नाही. आम्ही कशी मदत करू शकतो? इथे उत्तर द्या, आम्ही तुमच्याशी संपर्क करू.',
    en: 'You called {clinic} and we could not take your call. How can we help? Reply here and we will get back to you.',
  },
  doctor_leave_reschedule: {
    gu: 'નમસ્તે {{1}}, {clinic} ખાતે {{2}} સાથેની તમારી {{3}} ની એપોઇન્ટમેન્ટ તે દિવસે ડૉક્ટર ઉપલબ્ધ ન હોવાથી થઈ શકશે નહીં. અસુવિધા બદલ માફ કરશો. તમને અનુકૂળ દિવસ અને સમય અહીં લખી મોકલો અથવા ક્લિનિકને કૉલ કરો, અમે નવી એપોઇન્ટમેન્ટ ગોઠવી આપીશું.',
    hi: 'नमस्ते {{1}}, {clinic} में {{2}} के साथ आपकी {{3}} की अपॉइंटमेंट उस दिन डॉक्टर के उपलब्ध न होने के कारण नहीं हो पाएगी। असुविधा के लिए खेद है। अपना सुविधाजनक दिन और समय यहाँ लिखकर भेजें या क्लिनिक को कॉल करें, हम आपकी अपॉइंटमेंट फिर से तय कर देंगे।',
    mr: 'नमस्कार {{1}}, {clinic} येथे {{2}} सोबतची तुमची {{3}} ची अपॉइंटमेंट त्या दिवशी डॉक्टर उपलब्ध नसल्याने होऊ शकणार नाही. गैरसोयीबद्दल क्षमस्व. तुम्हाला सोयीचा दिवस आणि वेळ इथे लिहून पाठवा किंवा क्लिनिकला कॉल करा, आम्ही तुमची अपॉइंटमेंट पुन्हा निश्चित करू.',
    en: 'Hello {{1}}, your appointment with {{2}} at {clinic} on {{3}} cannot go ahead because the doctor will be away that day. We are sorry for the inconvenience. Reply here with a day and time that suits you, or call the clinic, and we will book you again.',
  },
  staff_callback_alert: {
    gu: 'ઋતુ: {{1}} ({{2}}) એ {clinic} પાસેથી કૉલ બેક માંગ્યો છે. કારણ: {{3}}. કૃપા કરીને તેમને કૉલ કરો અને ડેસ્ક પર પૂર્ણ થયું માર્ક કરો.',
    hi: 'ऋतु: {{1}} ({{2}}) ने {clinic} से कॉल बैक माँगा है। कारण: {{3}}। कृपया उन्हें कॉल करें और डेस्क पर पूरा हुआ मार्क करें।',
    mr: 'ऋतू: {{1}} ({{2}}) यांनी {clinic} कडून कॉल बॅक मागितला आहे. कारण: {{3}}. कृपया त्यांना कॉल करा आणि डेस्कवर पूर्ण झाले असे मार्क करा.',
    en: 'Ritu: {{1}} ({{2}}) has asked {clinic} for a call back. Reason: {{3}}. Please call them and mark it done on the desk.',
  },
};

// Sample values Meta requires at submission — the shapes the server really
// sends. Dates and times are Latin in every language (the senders format with
// en-IN), so the samples are too.
const WHEN = 'Wed, 16 Sept, 5:30 pm'; // exactly what Intl en-IN (ICU 77) prints for the senders' formatter
const EXAMPLES = {
  appointment_confirmation: { gu: ['રીના', WHEN], hi: ['रीना', WHEN], mr: ['रीना', WHEN], en: ['Reena', WHEN] },
  appointment_reminder:     { gu: ['રીના', WHEN], hi: ['रीना', WHEN], mr: ['रीना', WHEN], en: ['Reena', WHEN] },
  appointment_followup:     { gu: ['રીના'], hi: ['रीना'], mr: ['रीना'], en: ['Reena'] },
  no_show_recovery:         { gu: [], hi: [], mr: [], en: [] },
  missed_call_recovery:     { gu: [], hi: [], mr: [], en: [] },
  doctor_leave_reschedule:  { gu: ['રીના', 'ડૉ. દક્ષા પટેલ', WHEN], hi: ['रीना', 'डॉ. दक्षा पटेल', WHEN], mr: ['रीना', 'डॉ. दक्षा पटेल', WHEN], en: ['Reena', 'Dr. Daksha Patel', WHEN] },
  staff_callback_alert:     { gu: ['રીના શાહ', '+91 98765 43210', 'સમય બદલવો છે'], hi: ['रीना शाह', '+91 98765 43210', 'समय बदलना है'], mr: ['रीना शाह', '+91 98765 43210', 'वेळ बदलायची आहे'], en: ['Reena Shah', '+91 98765 43210', 'Wants to change the time'] },
};
const LANGS = ['gu', 'hi', 'mr', 'en'];

// Which clinic name goes into a template in `lang`. An explicit --name-<lang>
// wins; the clinic's own language gets the local-script name; every other
// language gets the Latin name (falling back to whichever one exists).
function nameFor(lang, names, localLang) {
  if (names[lang]) return names[lang];
  const latin = names.en || names.local || '';
  return lang === localLang ? (names.local || names.en || '') : latin;
}

// The rules a body must satisfy before it is worth Meta's review queue.
// Returns the first problem as a string, or null.
function checkText(name, text) {
  const n = VARS[name];
  if (n === undefined) return `unknown template ${name}`;
  const found = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const want = Array.from({ length: n }, (_, i) => i + 1);
  if (JSON.stringify(found) !== JSON.stringify(want)) return `variables ${JSON.stringify(found)}, the server sends ${JSON.stringify(want)}`;
  if (/\}\}\s*\{\{/.test(text)) return 'adjacent variables';
  if (/^\s*\{\{/.test(text) || /\}\}\s*$/.test(text)) return 'a body may not start or end with a variable';
  if (/[\n\t]/.test(text)) return 'newline or tab in the body';
  if (text.length > 1024) return `body is ${text.length} chars (max 1024)`;
  if (/\{clinic\}/.test(text)) return 'clinic placeholder left in';
  if (!text.trim()) return 'empty body';
  return null;
}

function buildTemplate(name, lang, names, opts = {}) {
  const texts = TEMPLATE_TEXT[name];
  if (!texts || !texts[lang]) throw new Error(`no text for ${name} in ${lang}`);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`template name "${name}" (lowercase letters, digits, underscores)`);
  const localLang = opts.localLang || 'en';
  const clinic = nameFor(lang, names, localLang);
  if (!clinic) throw new Error('clinic name missing (--name-en / CLINIC_NAME)');
  const text = texts[lang].split('{clinic}').join(clinic);
  const problem = checkText(name, text);
  if (problem) throw new Error(`${name} [${lang}]: ${problem}`);
  const body = { type: 'BODY', text };
  const sample = (EXAMPLES[name] && EXAMPLES[name][lang]) || [];
  if (VARS[name] > 0) {
    if (sample.length !== VARS[name]) throw new Error(`${name} [${lang}]: ${sample.length} sample value(s) for ${VARS[name]} variable(s)`);
    body.example = { body_text: [sample] };
  }
  return { name, language: lang, category: 'UTILITY', components: [body] };
}

// The readiness table: one row per template, one column per language.
function readiness(existing, langs) {
  const cell = (name, lang) => {
    const rows = existing.filter((t) => t.name === name && t.language === lang);
    if (!rows.length) return 'MISSING';
    const live = rows.find((t) => t.status === 'APPROVED') || rows.find((t) => t.status !== 'REJECTED') || rows[0];
    return live.status === 'REJECTED' && live.rejected_reason && live.rejected_reason !== 'NONE' ? `REJECTED(${live.rejected_reason})` : live.status;
  };
  const table = Object.keys(TEMPLATE_TEXT).map((name) => ({ name, ...Object.fromEntries(langs.map((l) => [l, cell(name, l)])) }));
  const approved = table.reduce((n, r) => n + langs.filter((l) => r[l] === 'APPROVED').length, 0);
  return { table, approved, total: table.length * langs.length };
}


/**
 * The plain-text rendering of a template for one recipient — what goes out
 * when no approved template is live (Meta only delivers it inside a 24h
 * window) and what the delivery ledger records. Same words as the template.
 */
function renderText(name, lang, variables, clinic) {
  const texts = TEMPLATE_TEXT[name];
  if (!texts) throw new Error(`no text for ${name}`);
  const l = texts[lang] ? lang : 'en';
  let text = texts[l].split('{clinic}').join(clinic || 'the clinic');
  for (const [k, v] of Object.entries(variables || {})) text = text.split(`{{${k}}}`).join(String(v));
  return text;
}

module.exports = { TEMPLATE_TEXT, EXAMPLES, VARS, LANGS, buildTemplate, nameFor, checkText, readiness, renderText };
