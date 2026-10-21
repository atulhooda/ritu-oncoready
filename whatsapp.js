const { verifyMetaSignature, shouldAccept } = require('./metaSignature');
const axios = require('axios');
const config = require('./config');
const db = require('./db');
const reportIntake = require('./reportIntake');
const { getClinicWhatsAppCreds } = require('./clinicWhatsApp');
// The clinic's OWN number/token when it connected WhatsApp from the desk
// (Skin Essence did). Until 2026-09-18 only the booking confirmation, the
// media reply and the outbox looked it up; replies to patient messages,
// reminders, follow-ups, no-show and missed-call messages went out on the
// env token — which for a desk-connected clinic cannot act on its WABA, so
// patients replying on WhatsApp received nothing (SE log: "SEND FAILED after
// brain turn"). Every sender resolves this now. null → env credentials.
async function clinicCreds(clinicId) {
  try { return await getClinicWhatsAppCreds(clinicId || config.clinicId); } catch (_) { return null; }
}
// The WhatsApp receptionist is brain-lean — the SAME brain the phone runs —
// reached through a thin adapter. whatsappBrain.js (a second, smaller brain that
// could not book) is gone, and with it the action ladder it fed.
// NEVER require('./callHandler') from this file: callHandler → crm → whatsapp is
// a cycle and crm destructures at load time, so that import silently kills the
// voice path's post-call confirmation. See safetyText.js.
const whatsappChannel = require('./whatsappChannel');
const { runInboundGuards, alertEmergency } = require('./whatsappGuards');
const { loadPatientContext } = require('./whatsappChannel');
const { maskPhone } = require('./redact');
const { detectLanguageCode, pairLanguage } = require('./sarvam');

// Resolve the conversation language for an inbound text: a real Indic-script
// message wins (the patient is writing in it now); otherwise keep whatever the
// conversation was seeded with (from the call) or fall back to Hindi. Romanized
// Hinglish detects as en-IN → treated as "no strong signal", keeps the stored
// language so a Kannada caller typing "haan theek hai" stays in Kannada.
function resolveInboundLanguage(text, storedLanguage) {
  if (!text || !text.trim()) return storedLanguage || null; // no signal → keep stored
  // Only act on a real Indic-script hit; detectLanguageCode's no-Indic default
  // is en-IN, which we treat as "no strong signal" (keeps stored) so romanized
  // Hinglish from a Kannada caller doesn't flip the conversation to English.
  const detected = /[ऀ-ൿ]/.test(text) ? detectLanguageCode(text) : 'en-IN';
  // Hindi/Marathi is decided by the SAME rule as voice (sarvam.pairLanguage:
  // Marathi veto, three-token floors), with the thread's language as the
  // current one — not by the script detector alone, which read any marker-less
  // Devanagari line as Hindi and flipped a Marathi thread on "हाँ".
  if (detected === 'hi-IN' || detected === 'mr-IN') {
    const current = (storedLanguage === 'hi-IN' || storedLanguage === 'mr-IN') ? storedLanguage : detected;
    return pairLanguage(text, current);
  }
  if (detected && detected !== 'en-IN' && config.languageNames[detected]) return detected;
  return storedLanguage || null;
}

// ─── META CLOUD API CLIENT ────────────────────────────────────────────────────
// All WhatsApp sends go through graph.facebook.com/<api>/<phone_number_id>/messages.
// No retry logic on sends (intentional — prevents duplicate confirmations).

function metaUrl(creds) {
  const apiVersion = config.whatsapp.apiVersion;
  const phoneNumberId = (creds && creds.phoneNumberId) || config.whatsapp.phoneNumberId;
  return `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
}

function formatWhatsAppNumber(phone) {
  if (!phone) return null;
  // Meta expects plain E.164 digits: "919876543210". No "whatsapp:" prefix, no "+".
  return phone.replace(/^whatsapp:/, '').replace(/\D/g, '');
}

// ── Token alert (S7-T1) ──────────────────────────────────────────────────────
// Same alert path the rest of the app uses (n8n webhook, fire-and-forget —
// see callHandler.handleEmergency) + a distinctive console prefix so a dead
// token is loud in the logs even with no n8n configured.
function fireTokenAlert(reason, detail) {
  console.error(`[WA-TOKEN-ALERT] ${reason}${detail ? ` — ${detail}` : ''}`);
  if (config.n8n.webhookUrl) {
    axios.post(config.n8n.webhookUrl, {
      type: 'whatsapp_token_alert',
      reason,
      detail: detail || null,
      timestamp: new Date().toISOString()
    }, { timeout: 3000 }).catch(() => {});
  }
}

// ── Dead-letter a failed send (S7-T1) ────────────────────────────────────────
// Records the FULL /messages payload so the send can be replayed by hand
// (tools/redriveWhatsApp.js) after the cause is fixed. Must never throw into
// a send path — a DLQ failure is logged and swallowed. `indeterminate` = Meta
// never definitively rejected (timeout/connection drop): a wamid may exist on
// their side, so redrive skips those rows by default (no send idempotency
// key exists on Meta's API — a blind re-send could double-message).
async function dlqRecord(body, creds, err, phoneNumberId) {
  try {
    const metaErr = err && err.response && err.response.data && err.response.data.error;
    await db.pool.query(`
      INSERT INTO whatsapp_dlq
        (clinic_id, to_phone, message_kind, request_body, phone_number_id,
         used_clinic_creds, error_code, error_detail, indeterminate)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
      config.clinicId || null,
      body.to,
      body.type || 'template',
      JSON.stringify(body),
      phoneNumberId || null,
      !!(creds && creds.accessToken),
      (metaErr && metaErr.code) || null,
      err ? JSON.stringify(err.response?.data || err.message).slice(0, 2000) : 'not_configured',
      !!(err && !err.response) // no HTTP response = indeterminate (may have sent)
    ]);
    console.error(`[META-WA] dead-lettered send to ${body.to} (${body.type || 'template'})`);
  } catch (dlqErr) {
    if (dlqErr.code === '42P01') {
      console.error('[META-WA] whatsapp_dlq table missing — run db/migrations/006_whatsapp_dlq.sql; failed send NOT recorded');
    } else {
      console.error('[META-WA] whatsapp_dlq insert failed:', dlqErr.message);
    }
  }
}

// ── Dead-template registry (live 2026-07-23) ────────────────────────────────
// config defaults every template NAME (e.g. 'appointment_reminder'), but the
// demo WABA never had them created — so the reminder cron hit Meta error
// 132001 ("template name does not exist") every 30 minutes, the reminder was
// never marked sent, and the patient got NOTHING (the localized plain-text
// fallback below each template call was dead code behind an always-truthy
// name). On a definitive 132001 the template is remembered as dead for this
// boot: future sends skip straight to plain text, and the send that
// discovered it retries as plain text immediately (132001 is definitive —
// Meta rejected it, nothing was sent — so the retry can't double-message).
// Plain text only delivers inside an open 24h session window; the real fix is
// creating the template in WhatsApp Manager, which the log line spells out.
//
// RACE NOTE (panel 2026-07-24): the fallback decision must NOT re-read this
// global Set after the attempt — a CONCURRENT send B could mark the template
// dead between send A's POST and A's fallback check, tricking A into a plain
// send on top of a template that A's own (timed-out → indeterminate) POST may
// have delivered. So metaPost reports "THIS attempt proved it dead" via a
// call-local `opts.mark` object (single-threaded → no cross-send leakage); the
// global Set is used ONLY to skip FUTURE template attempts, never to gate the
// current send's fallback.
// KEYED BY NAME **AND** LANGUAGE. Meta approves a template per language, so
// "appointment_confirmation" can exist in hi and not in gu. Before the language
// was threaded through, every send used the default, and one key per name was
// therefore the same thing. It is not any more: a 132001 for the Gujarati
// version would otherwise mark the template dead for the whole boot and drop
// HINDI callers to plain text too — and plain text only delivers inside an open
// 24-hour window, so the ones outside it would get nothing at all. A clinic
// adding its first Gujarati caller would have quietly broken confirmations for
// everyone else.
const deadTemplates = new Set();
// Languages a template has actually delivered in this boot, per template. The
// ladder below tries these before guessing, so after one discovery every send
// goes straight to the language the WABA has.
const liveTemplateLangs = new Map();   // name → Set(lang)
// The order in which languages are tried for a template. The caller's own
// language first; then languages this template is already known to deliver in;
// then the fleet default; then English, which is what every WABA here was
// created with. Dead (name, lang) pairs are skipped.
function templateLadder(templateName, callerLang) {
  const order = [];
  const push = (l) => { if (l && !order.includes(l)) order.push(l); };
  push(metaLangCode(callerLang));
  for (const l of liveTemplateLangs.get(templateName) || []) push(l);
  push(config.whatsapp.defaultTemplateLanguage); push('en'); push('en_US');
  return order.filter((l) => templateUsable(templateName, l));
}
const templateKey = (name, lang) => `${name}|${lang || config.whatsapp.defaultTemplateLanguage}`;

// Meta wants a short code ('gu'), our call language is a locale ('gu-IN').
function metaLangCode(langCode) {
  if (!langCode) return null;
  const s = String(langCode).trim();
  return s.includes('-') ? s.split('-')[0].toLowerCase() : s.toLowerCase();
}
function templateUsable(name, lang) {
  return !!name && !deadTemplates.has(templateKey(name, lang));
}

async function metaPost(body, creds, opts = {}) {
  // TEST_MODE short-circuits all outbound WhatsApp sends so the test harness
  // can exercise the booking flow without spamming real numbers.
  if (process.env.TEST_MODE === 'true') {
    console.log(`[META-WA] TEST_MODE: skipped send to ${body.to} (${body.type || 'template'})`);
    return 'test_mode_skipped';
  }

  // Per-clinic coexistence creds when present (creds.*), else the env-configured
  // number/token (unchanged hospital behavior).
  const token = (creds && creds.accessToken) || config.whatsapp.accessToken;
  const phoneNumberId = (creds && creds.phoneNumberId) || config.whatsapp.phoneNumberId;
  if (!token || !phoneNumberId) {
    console.error('[META-WA] Not configured (no connected clinic token and no META_ACCESS_TOKEN/META_PHONE_NUMBER_ID).');
    if (!opts.noDlq) await dlqRecord(body, creds, null, phoneNumberId);
    return null;
  }
  try {
    const res = await axios.post(metaUrl(creds), body, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    const msgId = res.data?.messages?.[0]?.id || null;
    console.log(`[META-WA] sent to ${body.to}: status=${res.status}, id=${msgId}`);
    return msgId;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[META-WA] send error to ${body.to}:`, JSON.stringify(detail));
    // Error 190 = OAuthException, dead/expired token — the silent demo killer.
    // Every send will fail the same way until the token is replaced: page ops.
    if (err.response?.data?.error?.code === 190) {
      fireTokenAlert('send failed with error 190 — access token expired/invalid',
        err.response.data.error.message);
    }
    // Error 132001 = template doesn't exist on this WABA. Permanent for this
    // deploy — remember it so the 30-min reminder cron stops burning attempts
    // on a send that can never succeed.
    if (err.response?.data?.error?.code === 132001 && body.template?.name) {
      // Dead in THIS language only — the same template may be live in another.
      deadTemplates.add(templateKey(body.template.name, body.template?.language?.code));
      if (opts.mark) opts.mark.templateDead = true; // race-free per-attempt signal
      console.error(`[META-WA] template "${body.template.name}" does not exist on this WABA — ` +
        `plain-text fallback will be used where the caller supports it. FIX: create it in WhatsApp Manager ` +
        `(Business Settings → WhatsApp Accounts → Message Templates) or set the META_TEMPLATE_* env var to an existing template.`);
    }
    if (!opts.noDlq) await dlqRecord(body, creds, err, phoneNumberId);
    return null;
  }
}

async function sendWhatsAppMessage(to, body, creds) {
  const formattedTo = formatWhatsAppNumber(to);
  if (!formattedTo || !body) return null;

  return metaPost({
    messaging_product: 'whatsapp',
    to: formattedTo,
    type: 'text',
    text: { body }
  }, creds);
}

// Accepts either an old-style positional-key object ({"1": "name", "2": "time"})
// or an array of strings / parameter objects. Converts to Meta's components shape.
// mark: optional call-local object; metaPost sets mark.templateDead=true iff
// THIS attempt hit 132001. The caller uses that (not the global registry) to
// decide the plain-text fallback — race-free.
async function sendWhatsAppTemplate(to, templateName, variables = {}, language, creds, mark) {
  const formattedTo = formatWhatsAppNumber(to);
  if (!formattedTo || !templateName) return null;

  const langCode = language || config.whatsapp.defaultTemplateLanguage;

  let parameters = [];
  if (Array.isArray(variables)) {
    parameters = variables.map(v =>
      typeof v === 'string' ? { type: 'text', text: v } : v
    );
  } else if (variables && typeof variables === 'object') {
    const orderedKeys = Object.keys(variables).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    parameters = orderedKeys.map(k => ({ type: 'text', text: String(variables[k]) }));
  }

  const template = {
    name: templateName,
    language: { code: langCode }
  };
  if (parameters.length > 0) {
    template.components = [{ type: 'body', parameters }];
  }

  return metaPost({
    messaging_product: 'whatsapp',
    to: formattedTo,
    type: 'template',
    template
  }, creds, { mark });
}

// The ONE place that decides template-vs-plain. Try the approved template; fall
// back to plain text ONLY when the template is unset / already-known-dead (never
// attempted this send) OR when THIS attempt definitively proved it dead (132001,
// nothing sent). A timeout/token failure never falls through (a wamid may
// exist). Race-free: usability is captured BEFORE the attempt and the fallback
// keys off a per-attempt signal, never the global registry a concurrent send
// could mutate mid-flight. Used by every business + scheduler sender so the
// dead-template handling can never diverge (panel 2026-07-24: no_show /
// missed_call had drifted and silently sent nothing).
// `language` is the CALLER'S language, not the fleet default. It used to be
// passed as literal `undefined`, so sendWhatsAppTemplate fell to
// META_TEMPLATE_LANGUAGE ('hi') on every send — every approved-template message
// went out in Hindi no matter who was on the call, and the localised bodies
// below were only ever reached on the plain-text fallback path.
//
// The plain-text fallback IS localised, so the failure was invisible in testing:
// a clinic with no templates configured behaved perfectly. All five are
// configured here.
//
// MEASURED 2026-09-07 on the demo WABA: the caller's language went straight to
// the template request, the WABA has appointment_confirmation in "en" ONLY, so
// every confirmation to a Hindi/Marathi/Punjabi caller since 27 Aug hit 132001,
// fell to plain text, and Meta failed it with 131047 — outside the 24-hour
// window, undeliverable — while the desk, the Sheet and the call log said
// "WhatsApp sent". A template in the WRONG language still delivers; plain text
// outside a window never does. So the fallback from a dead language is the NEXT
// language on the ladder, and plain text is the last resort, said out loud.
async function sendTemplateOrText(to, templateName, variables, plainText, creds, language) {
  const want = metaLangCode(language) || config.whatsapp.defaultTemplateLanguage;
  const ladder = templateName ? templateLadder(templateName, language) : [];
  for (const lang of ladder) {
    const mark = {};
    const sid = await sendWhatsAppTemplate(to, templateName, variables, lang, creds, mark);
    if (sid) {
      if (!liveTemplateLangs.has(templateName)) liveTemplateLangs.set(templateName, new Set());
      liveTemplateLangs.get(templateName).add(lang);
      if (lang !== want) console.log(`[META-WA] template "${templateName}" sent in "${lang}" — the caller's "${want}" has no approved translation on this WABA`);
      return sid;
    }
    // A timeout / token failure is NOT "dead": a wamid may exist. Never fall through. (existing rule)
    if (!mark.templateDead) return null;
  }
  console.error(`[META-WA] ⚠ "${templateName || '(no template)'}" has no live template in [${ladder.join(', ') || 'none usable'}] for ${to} — sending PLAIN TEXT, which Meta delivers ONLY inside a 24-hour customer-service window. Approve the template in WhatsApp Manager.`);
  return sendWhatsAppMessage(to, plainText, creds);
}

// ─── BUSINESS MESSAGES ───────────────────────────────────────────────────────

async function sendConfirmation(patientData) {
  const { phone, name, appointmentTime, language, clinicId } = patientData;
  const patientId = await db.upsertPatient(phone, name);
  // Seed the conversation language from the CALL's language, so the patient's
  // very first WhatsApp reply is already answered in their language (before
  // they've typed anything for script-detection to work on).
  const langCode = config.langCodeForName(language);
  const conv = await db.getOrCreateConversation(phone, patientId, langCode);
  await db.updateConversationState(conv.id, 'post_booking');

  // Coexistence: send from the clinic's OWN connected number/token if it has one
  // (admin "Connect WhatsApp"); else fall back to the env-configured number.
  const creds = await getClinicWhatsAppCreds(clinicId || config.clinicId);

  const lang = language || 'Hindi';
  // Human-friendly IST datetime for the {{2}} template variable (was an ugly
  // "3/7/2026, 5:00:00 pm"). e.g. "Thu, 3 Jul, 5:00 pm".
  const _appt = new Date(appointmentTime);
  const timeStr = isNaN(_appt.getTime())
    ? 'your scheduled time'
    : new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).format(_appt);

  // Confirmation body follows the CALL's language (callHandler sets
  // languageDetected on pin/switch) — a Kannada booking used to get Hinglish.
  const CONFIRM_MSG = {
    english:   `${name}, your appointment is confirmed for ${timeStr}! 🙏\nReply here if you have any questions or need to reschedule. I'm here to help.`,
    marathi:   `${name} जी, तुमची अपॉइंटमेंट ${timeStr} ला कन्फर्म झाली आहे! 🙏\nकाही प्रश्न असल्यास इथे रिप्लाय करा — मी मदतीसाठी आहे.`,
    kannada:   `${name} ಅವರೇ, ನಿಮ್ಮ ಅಪಾಯಿಂಟ್\u200cಮೆಂಟ್ ${timeStr} ಕ್ಕೆ ಕನ್ಫರ್ಮ್ ಆಗಿದೆ! 🙏\nಪ್ರಶ್ನೆಗಳಿದ್ದರೆ ಇಲ್ಲಿ ರಿಪ್ಲೈ ಮಾಡಿ — ನಾನು ಸಹಾಯಕ್ಕೆ ಇದ್ದೇನೆ.`,
    punjabi:   `${name} ਜੀ, ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ${timeStr} ਲਈ ਕਨਫਰਮ ਹੋ ਗਈ ਹੈ! 🙏\nਕੋਈ ਸਵਾਲ ਹੋਵੇ ਤਾਂ ਇੱਥੇ ਰਿਪਲਾਈ ਕਰੋ — ਮੈਂ ਮਦਦ ਲਈ ਹਾਂ।`,
    tamil:     `${name}, உங்கள் அப்பாயின்ட்மென்ட் ${timeStr} க்கு உறுதி ஆகிவிட்டது! 🙏\nகேள்விகள் இருந்தால் இங்கே பதிலளியுங்கள்.`,
    telugu:    `${name} గారు, మీ అపాయింట్మెంట్ ${timeStr} కి కన్ఫర్మ్ అయింది! 🙏\nప్రశ్నలు ఉంటే ఇక్కడ రిప్లై చేయండి.`,
    bengali:   `${name}, আপনার অ্যাপয়েন্টমেন্ট ${timeStr}-এ কনফার্ম হয়েছে! 🙏\nকোনো প্রশ্ন থাকলে এখানে রিপ্লাই করুন।`,
    gujarati:  `${name}, તમારી એપોઇન્ટમેન્ટ ${timeStr} માટે કન્ફર્મ થઈ ગઈ છે! 🙏\nકોઈ પ્રશ્ન હોય તો અહીં રિપ્લાય કરો.`,
    malayalam: `${name}, നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ${timeStr}-ന് കൺഫേം ആയി! 🙏\nചോദ്യങ്ങളുണ്ടെങ്കിൽ ഇവിടെ റിപ്ലൈ ചെയ്യൂ.`,
    odia:      `${name}, ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ${timeStr} ପାଇଁ କନଫର୍ମ ହୋଇଛି! 🙏\nପ୍ରଶ୍ନ ଥିଲେ ଏଠାରେ ରିପ୍ଲାଇ କରନ୍ତୁ।`,
  };
  // Clinic address rides along when configured (CLINIC_ADDRESS) — the voice
  // side is told not to invent one, so this is where the patient gets it.
  const _addrLine = config.clinicAddress ? `\n📍 ${config.clinicAddress}` : '';
  let msg = (CONFIRM_MSG[lang.toLowerCase()]
    || `${name} ji, aapki appointment ${timeStr} baje confirm ho gayi hai! 🙏\nKoi bhi sawaal ho toh yahan reply karein — main hoon aapki madad ke liye.`) + _addrLine;
  // Report intake ask (flag-gated): invite old reports/prescriptions as photos
  // so the doctor gets a structured pre-read before the visit.
  //
  // ⚠ THIS ONLY SHIPS ON THE FALLBACK PATH, AND THAT IS USUALLY NEVER. `msg` is
  // handed to sendTemplateOrText as its plainText argument, which is sent ONLY
  // when the template is unusable or Meta rejected it as dead. `confirmation`
  // defaults to 'appointment_confirmation' (config.js) so the name is always
  // truthy, and this clinic's template is approved and sending — so on the
  // normal path the template goes out with {{1}}/{{2}} and every line below is
  // discarded. Same dead-fallback shape this file documents at ~line 106.
  //
  // The ask the patient actually hears is spoken on the CALL instead
  // (CANNED_LINES.reportAsk / callHandler._maybeReportAsk): a template send does
  // not open the 24h customer-service window, so free text cannot follow it,
  // and a photo cannot travel over voice — the call is the only place the ask
  // is both free and deliverable. To put it in writing for every patient, the
  // line has to go INSIDE the approved template and be re-approved by Meta.
  if (process.env.ENABLE_REPORT_INTAKE === 'true') {
    const REPORT_ASK = {
      english:   `\n\n📄 If you have old reports or prescriptions, just send a photo here — I'll have them ready for the doctor.`,
      marathi:   `\n\n📄 जुने रिपोर्ट्स किंवा प्रिस्क्रिप्शन असतील तर त्यांचा फोटो इथे पाठवा — मी डॉक्टरांसाठी आधीच तयार ठेवते.`,
      kannada:   `\n\n📄 ಹಳೆಯ ರಿಪೋರ್ಟ್ ಅಥವಾ ಪ್ರಿಸ್ಕ್ರಿಪ್ಷನ್ ಇದ್ದರೆ, ಫೋಟೋ ಇಲ್ಲಿ ಕಳುಹಿಸಿ — ಡಾಕ್ಟರ್\u200cಗೆ ಮೊದಲೇ ತಯಾರು ಮಾಡಿಡುತ್ತೇನೆ.`,
      punjabi:   `\n\n📄 ਪੁਰਾਣੀਆਂ ਰਿਪੋਰਟਾਂ ਜਾਂ ਪਰਚੀ ਹੋਵੇ ਤਾਂ ਫੋਟੋ ਇੱਥੇ ਭੇਜ ਦਿਓ — ਮੈਂ ਡਾਕਟਰ ਲਈ ਪਹਿਲਾਂ ਤੋਂ ਤਿਆਰ ਰੱਖਾਂਗੀ।`,
      tamil:     `\n\n📄 பழைய ரிப்போர்ட் அல்லது மருந்துச்சீட்டு இருந்தால், போட்டோ இங்கே அனுப்புங்கள் — டாக்டருக்கு முன்பே தயார் செய்து வைக்கிறேன்.`,
      telugu:    `\n\n📄 పాత రిపోర్టులు లేదా ప్రిస్క్రిప్షన్ ఉంటే, ఫోటో ఇక్కడ పంపండి — డాక్టర్ కోసం ముందే సిద్ధం చేసి ఉంచుతాను.`,
      bengali:   `\n\n📄 পুরনো রিপোর্ট বা প্রেসক্রিপশন থাকলে ছবি এখানে পাঠান — ডাক্তারের জন্য আগে থেকে তৈরি রাখব।`,
      gujarati:  `\n\n📄 જૂના રિપોર્ટ કે પ્રિસ્ક્રિપ્શન હોય તો ફોટો અહીં મોકલો — હું ડૉક્ટર માટે પહેલેથી તૈયાર રાખીશ.`,
      malayalam: `\n\n📄 പഴയ റിപ്പോർട്ടുകളോ കുറിപ്പടിയോ ഉണ്ടെങ്കിൽ ഫോട്ടോ ഇവിടെ അയയ്ക്കൂ — ഡോക്ടർക്കായി മുൻകൂട്ടി തയ്യാറാക്കി വയ്ക്കാം.`,
      odia:      `\n\n📄 ପୁରୁଣା ରିପୋର୍ଟ କିମ୍ବା ପ୍ରେସକ୍ରିପସନ ଥିଲେ ଫଟୋ ଏଠାରେ ପଠାନ୍ତୁ — ଡାକ୍ତରଙ୍କ ପାଇଁ ଆଗରୁ ପ୍ରସ୍ତୁତ ରଖିବି।`,
    };
    msg += REPORT_ASK[lang.toLowerCase()]
      || `\n\n📄 Agar purani reports ya prescription hain, unki photo yahin bhej dijiye — main doctor ke liye pehle se taiyaar rakh dungi.`;
  }

  const confirmTmpl = config.whatsapp.templates && config.whatsapp.templates.confirmation;
  const sid = await sendTemplateOrText(phone, confirmTmpl, { "1": name, "2": timeStr }, msg, creds, langCode);

  if (sid) {
    await db.saveWhatsAppMessage(conv.id, patientId, 'outbound', msg, 'confirmation', sid);
  }
}

// Localized reminder/followup bodies, keyed by the conversation's stored
// language code. {name}/{time} interpolated; digits/times stay Latin.
const REMINDER_MSG = {
  'hi-IN': '{name} जी, याद दिला दूँ कि आपकी अपॉइंटमेंट कल {time} बजे है। कृपया समय पर आएँ! 🙏',
  'mr-IN': '{name} जी, आठवण करून देते की तुमची अपॉइंटमेंट उद्या {time} वाजता आहे. कृपया वेळेवर या! 🙏',
  'en-IN': '{name}, a reminder that your appointment is tomorrow at {time}. Please come on time! 🙏',
  'kn-IN': '{name} ಅವರೇ, ನೆನಪಿಸುತ್ತೇನೆ — ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ನಾಳೆ {time} ಕ್ಕೆ ಇದೆ. ದಯವಿಟ್ಟು ಸಮಯಕ್ಕೆ ಬನ್ನಿ! 🙏',
  'pa-IN': '{name} ਜੀ, ਯਾਦ ਕਰਵਾ ਦਿਆਂ ਕਿ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਕੱਲ੍ਹ {time} ਵਜੇ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਸਮੇਂ ਸਿਰ ਆਓ! 🙏',
  'ta-IN': '{name}, நினைவூட்டல் — உங்கள் அப்பாயின்ட்மென்ட் நாளை {time} மணிக்கு. தயவுசெய்து சரியான நேரத்தில் வாருங்கள்! 🙏',
  'te-IN': '{name} గారు, గుర్తు చేస్తున్నాను — మీ అపాయింట్మెంట్ రేపు {time} కి ఉంది. దయచేసి సమయానికి రండి! 🙏',
  'bn-IN': '{name}, মনে করিয়ে দিচ্ছি — আপনার অ্যাপয়েন্টমেন্ট আগামীকাল {time}-এ। অনুগ্রহ করে সময়মতো আসুন! 🙏',
  'gu-IN': '{name}, યાદ કરાવું છું — તમારી એપોઇન્ટમેન્ટ કાલે {time} વાગ્યે છે. કૃપા કરીને સમયસર આવો! 🙏',
  'ml-IN': '{name}, ഓർമ്മിപ്പിക്കട്ടെ — നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് നാളെ {time}-ന് ആണ്. ദയവായി സമയത്ത് വരൂ! 🙏',
  'od-IN': '{name}, ମନେ ପକାଇ ଦେଉଛି — ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଆସନ୍ତାକାଲି {time}ରେ ଅଛି। ଦୟାକରି ସମୟରେ ଆସନ୍ତୁ! 🙏',
};

function localize(table, code, vars) {
  let t = table[code] || table['hi-IN'];
  for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(v);
  return t;
}

// Demo override: WHATSAPP_FORCE_LANG (e.g. "en-IN") forces the REPLY language of
// every outbound WhatsApp text, regardless of the conversation's detected/stored
// language. The multilingual machinery is untouched — inbound is still detected
// and the real language still persisted — only the surface language of replies
// is pinned. Unset it and full 11-language replies return.
function replyLang(lang) {
  return process.env.WHATSAPP_FORCE_LANG || lang || null;
}

// ─── THE SAME REMINDER, FOR AN APPOINTMENT LATER TODAY ──────────────────────
// Every line above says "tomorrow", because the reminder had one shape: a fixed
// 23–25 hour window. Skin Essence wants two hours' notice, and a message that
// says "your appointment is tomorrow at 5:30" about an appointment ninety
// minutes away is worse than no reminder — the patient reads it, relaxes, and
// misses the slot.
//
// Chosen by comparing the appointment's IST calendar date with today's, not by
// the offset: an appointment at 09:00 with a 120-minute lead is reminded at
// 07:00 the SAME day, while one at 00:30 is reminded at 22:30 the day BEFORE.
// The offset cannot tell those apart. The date can.
const REMINDER_MSG_TODAY = {
  'hi-IN': '{name} जी, याद दिला दूँ कि आपकी अपॉइंटमेंट आज {time} बजे है। कृपया समय पर आएँ! 🙏',
  'mr-IN': '{name} जी, आठवण करून देते की तुमची अपॉइंटमेंट आज {time} वाजता आहे. कृपया वेळेवर या! 🙏',
  'en-IN': '{name}, a reminder that your appointment is today at {time}. Please come on time! 🙏',
  'kn-IN': '{name} ಅವರೇ, ನೆನಪಿಸುತ್ತೇನೆ — ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಇಂದು {time} ಕ್ಕೆ ಇದೆ. ದಯವಿಟ್ಟು ಸಮಯಕ್ಕೆ ಬನ್ನಿ! 🙏',
  'pa-IN': '{name} ਜੀ, ਯਾਦ ਕਰਵਾ ਦਿਆਂ ਕਿ ਤੁਹਾਡੀ ਅਪਾਇੰਟਮੈਂਟ ਅੱਜ {time} ਵਜੇ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਸਮੇਂ ਸਿਰ ਆਓ! 🙏',
  'ta-IN': '{name}, நினைவூட்டல் — உங்கள் அப்பாயின்ட்மென்ட் இன்று {time} மணிக்கு. தயவுசெய்து சரியான நேரத்தில் வாருங்கள்! 🙏',
  'te-IN': '{name} గారు, గుర్తు చేస్తున్నాను — మీ అపాయింట్మెంట్ ఈరోజు {time} కి ఉంది. దయచేసి సమయానికి రండి! 🙏',
  'bn-IN': '{name}, মনে করিয়ে দিচ্ছি — আপনার অ্যাপয়েন্টমেন্ট আজ {time}-এ। অনুগ্রহ করে সময়মতো আসুন! 🙏',
  'gu-IN': '{name}, યાદ કરાવું છું — તમારી એપોઇન્ટમેન્ટ આજે {time} વાગ્યે છે. કૃપા કરીને સમયસર આવો! 🙏',
  'ml-IN': '{name}, ഓർമ്മിപ്പിക്കട്ടെ — നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ഇന്ന് {time}-ന് ആണ്. ദയവായി സമയത്ത് വരൂ! 🙏',
  'od-IN': '{name}, ମନେ ପକାଇ ଦେଉଛି — ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଆଜି {time}ରେ ଅଛି। ଦୟାକରି ସମୟରେ ଆସନ୍ତୁ! 🙏',
};

/** Is this instant on the same IST calendar day as now? */
function isSameIstDay(when, now = new Date()) {
  const f = (d) => new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return f(new Date(when)) === f(now);
}

async function sendReminder(appointmentData) {
  const { id, phone_number, patient_id, scheduled_at, patient_name } = appointmentData;
  const conv = await db.getOrCreateConversation(phone_number, patient_id);
  const creds = await clinicCreds(appointmentData.clinicId);
  await db.updateConversationState(conv.id, 'awaiting_confirmation');

  const timeStr = new Date(scheduled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
  // "today" vs "tomorrow" by the calendar, not by the configured lead — see the
  // note at REMINDER_MSG_TODAY.
  const table = isSameIstDay(scheduled_at) ? REMINDER_MSG_TODAY : REMINDER_MSG;
  const msg = localize(table, replyLang(conv.language), { name: patient_name || 'Patient', time: timeStr });

  // The template's {{2}} carries the DAY as well ("Tue, 16 Sep, 5:30 pm"), the
  // confirmation's format: a template cannot say "today"/"tomorrow" (only the
  // plain text above chooses that per send), so a bare "5:30 pm" was ambiguous
  // at any reminder lead over a few hours. tools/metaTemplates.js VARS pins it.
  const whenStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(scheduled_at));
  const remindTmpl = config.whatsapp.templates && config.whatsapp.templates.reminder;
  const sid = await sendTemplateOrText(phone_number, remindTmpl,
    { "1": patient_name || 'Patient', "2": whenStr }, msg, creds, replyLang(conv.language));

  if (sid) {
    await db.saveWhatsAppMessage(conv.id, patient_id, 'outbound', msg, 'reminder', sid);
    await db.markReminderSent(id);
  }
}

const FOLLOWUP_MSG = {
  'hi-IN': 'नमस्ते {name} जी! आशा करती हूँ आपका स्वास्थ्य अब बेहतर होगा। {clinic} में आपका अनुभव कैसा रहा?',
  'mr-IN': 'नमस्कार {name} जी! आशा करते तुमची तब्येत आता बरी असेल. {clinic} मधला तुमचा अनुभव कसा होता?',
  'en-IN': 'Hello {name}! I hope you are feeling better now. How was your experience at {clinic}?',
  'kn-IN': 'ನಮಸ್ಕಾರ {name} ಅವರೇ! ಈಗ ನಿಮ್ಮ ಆರೋಗ್ಯ ಸುಧಾರಿಸಿದೆ ಎಂದು ಭಾವಿಸುತ್ತೇನೆ. {clinic} ನಲ್ಲಿ ನಿಮ್ಮ ಅನುಭವ ಹೇಗಿತ್ತು?',
  'pa-IN': 'ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ {name} ਜੀ! ਉਮੀਦ ਹੈ ਹੁਣ ਤੁਹਾਡੀ ਸਿਹਤ ਬਿਹਤਰ ਹੋਵੇਗੀ। {clinic} ਵਿੱਚ ਤੁਹਾਡਾ ਅਨੁਭਵ ਕਿਵੇਂ ਰਿਹਾ?',
  'ta-IN': 'வணக்கம் {name}! இப்போது நீங்கள் நலமாக இருப்பீர்கள் என நம்புகிறேன். {clinic}-ல் உங்கள் அனுபவம் எப்படி இருந்தது?',
  'te-IN': 'నమస్తే {name} గారు! ఇప్పుడు మీ ఆరోగ్యం మెరుగైందని ఆశిస్తున్నాను. {clinic}లో మీ అనుభవం ఎలా ఉంది?',
  'bn-IN': 'নমস্কার {name}! আশা করি এখন আপনি ভালো আছেন। {clinic}-এ আপনার অভিজ্ঞতা কেমন ছিল?',
  'gu-IN': 'નમસ્તે {name}! આશા છે હવે તમારી તબિયત સારી હશે. {clinic}માં તમારો અનુભવ કેવો રહ્યો?',
  'ml-IN': 'നമസ്കാരം {name}! ഇപ്പോൾ നിങ്ങൾക്ക് സുഖം തോന്നുന്നുണ്ടാകുമെന്ന് കരുതുന്നു. {clinic}-ലെ നിങ്ങളുടെ അനുഭവം എങ്ങനെയായിരുന്നു?',
  'od-IN': 'ନମସ୍କାର {name}! ଆଶା କରୁଛି ଏବେ ଆପଣଙ୍କ ସ୍ୱାସ୍ଥ୍ୟ ଭଲ ଅଛି। {clinic}ରେ ଆପଣଙ୍କ ଅନୁଭବ କେମିତି ଥିଲା?',
};

async function sendFollowup(appointmentData) {
  const { id, phone_number, patient_id, patient_name } = appointmentData;
  const conv = await db.getOrCreateConversation(phone_number, patient_id);
  const creds = await clinicCreds(appointmentData.clinicId);
  await db.updateConversationState(conv.id, 'post_visit');

  const clinicName = config.greetingClinicName || 'the clinic';
  const msg = localize(FOLLOWUP_MSG, replyLang(conv.language), { name: patient_name || 'Patient', clinic: clinicName });

  const followupTmpl = config.whatsapp.templates && config.whatsapp.templates.followup;
  const sid = await sendTemplateOrText(phone_number, followupTmpl,
    { "1": patient_name || 'Patient' }, msg, creds, replyLang(conv.language));

  if (sid) {
    await db.saveWhatsAppMessage(conv.id, patient_id, 'outbound', msg, 'followup', sid);
    await db.markFollowupSent(id);
  }
}

async function sendRescheduleOptions(patientData, availableSlots) {
  const { phone, name } = patientData;
  const patientId = await db.upsertPatient(phone, name);
  const conv = await db.getOrCreateConversation(phone, patientId);
  await db.updateConversationState(conv.id, 'rescheduling');

  const slotStrings = availableSlots.map(s => new Date(s).toLocaleString('en-IN')).join('\n');
  const msg = `${name} ji, aap in naye slots mein se kya chunenge?\n${slotStrings}`;

  const creds = await clinicCreds(patientData.clinicId);
  const sid = await sendWhatsAppMessage(phone, msg, creds);
  if (sid) {
    await db.saveWhatsAppMessage(conv.id, patientId, 'outbound', msg, 'reschedule', sid);
  }
}

// ─── INBOUND WEBHOOK HANDLERS ────────────────────────────────────────────────

// GET /whatsapp/incoming — Meta verification handshake.
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[META-WA] Webhook verified ✓');
    return res.status(200).type('text/plain').send(challenge);
  }
  console.warn(`[META-WA] Webhook verify failed (mode=${mode}, token match=${token === config.whatsapp.verifyToken})`);
  return res.sendStatus(403);
}

// Diagnostic firehose: persist every webhook POST raw. Meta delivery has been
// silently broken before (zero inbound ever, invisible because statuses were
// never logged) — this table is the ground truth for "did Meta POST at all".
const webhookEventsReady = db.pool.query(`
  CREATE TABLE IF NOT EXISTS webhook_events (
    id BIGSERIAL PRIMARY KEY,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(err => console.error('[META-WA] webhook_events table create failed:', err.message));

// POST /whatsapp/incoming — Meta delivers inbound messages + status updates.
async function handleIncomingWhatsApp(req, res) {
  // ─── AUTHENTICATE FIRST ───────────────────────────────────────────────────
  // Before the 200, before the webhook_events insert, before anything touches
  // the database. Until 2026-08-07 the only check was body.object, a field the
  // SENDER chooses — so any POST to this URL could create patient rows, inject
  // conversation history under a real patient's number, and fire the emergency
  // alert at a number of the caller's choosing.
  //
  // Ordering matters as much as the check: acking 200 and then verifying would
  // still have written the attacker's payload to webhook_events.
  // config.whatsapp, NOT config.meta — there is no config.meta. Writing one
  // threw a TypeError on every inbound delivery for 20 hours; see
  // tests/test-whatsapp-inbound.js, which drives this function rather than
  // reading it.
  const verdict = verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsapp.appSecret);
  if (!shouldAccept(verdict)) {
    // 403, not 200. Meta retries a non-2xx for up to 36 hours, which is the
    // correct behaviour for a delivery WE failed to verify and the wrong
    // problem to have with a forgery, since a forger controls their own retries.
    console.warn(`[META-WA] REJECTED inbound — signature ${verdict}`);
    return res.sendStatus(403);
  }
  if (verdict === 'unconfigured') {
    // Loud, every time, not once at boot. An unauthenticated webhook that has
    // been quiet for a month is not safer than one that is noisy about it.
    console.warn('[META-WA] ⚠ inbound NOT AUTHENTICATED — META_APP_SECRET is unset, so anyone with this URL can post. Set it to enforce.');
  } else if (verdict === 'no-body') {
    console.warn('[META-WA] ⚠ raw body missing — the express.json verify hook is not wired; signatures cannot be checked');
  }

  // Ack Meta immediately — we must respond 200 within a few seconds.
  res.sendStatus(200);

  webhookEventsReady.then(() =>
    db.pool.query('INSERT INTO webhook_events (payload) VALUES ($1)', [JSON.stringify(req.body || null)])
  ).catch(err => console.error('[META-WA] webhook_events insert failed:', err.message));

  try {
    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') {
      console.log('[META-WA] inbound ignored (not a whatsapp_business_account payload)');
      return;
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];

        // Delivery verdicts. Until 2026-09-07 these were written to webhook_events

        // as raw JSON and read by nobody; a week of failed confirmations was

        // invisible. The verdict goes onto the outbound row (migration 018).

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        for (const st of statuses) {

          const err = st && Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;

          const code = err && Number.isFinite(Number(err.code)) ? Number(err.code) : null;

          if (st.status === 'failed') {

            console.error(`[META-WA] ✗ delivery FAILED to ${st.recipient_id} id=${st.id} code=${code} ${err ? err.title || '' : ''}` +

              (code === 131047 ? ' — plain text outside the 24h window; a TEMPLATE was needed' : ''));

          }

          db.pool.query('UPDATE whatsapp_messages SET delivery_status = $1, delivery_error = $2, delivery_at = NOW() WHERE message_sid = $3', [st.status || null, code, st.id || null])

            .catch((e) => console.error('[META-WA] delivery status write failed:', e.message));

        }

        if (messages.length === 0) {
          // Status-only payload (delivery receipt / read) — ignore for now.
          continue;
        }

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const contact = contacts[i] || contacts[0] || {};
          await processInboundMessage(msg, contact);
        }
      }
    }
  } catch (error) {
    console.error('[META-WA] Inbound handler error:', error.message);
  }
}

// The roster slice needs the WHOLE complaint, not the trailing window. A voice
// call carries it in a per-call accumulator; a WhatsApp thread has no such
// object and spans days, so the original symptom ("सिर में दर्द") falls out of
// the history window long before the patient says "haan book kar do". Without
// this the slice narrows on whatever the last few messages happened to mention.
async function collectInboundText(conversationId, limit = 40) {
  try {
    const res = await db.pool.query(
      `SELECT body FROM whatsapp_messages
        WHERE conversation_id = $1 AND direction = 'inbound' AND COALESCE(type, '') <> 'intake-marker'
        ORDER BY sent_at DESC LIMIT $2`,
      [conversationId, limit]
    );
    return res.rows.reverse().map(r => r.body || '').join(' \n ');
  } catch (err) {
    console.error('[META-WA] collectInboundText:', err.message);
    return '';
  }
}

async function processInboundMessage(msg, contact) {
  try {
    const from = msg.from; // plain "919876543210"
    const messageId = msg.id;
    const profileName = contact?.profile?.name || 'Patient';
    const creds = await clinicCreds(config.clinicId); // every reply below sends with the clinic's own number

    // Report intake: image/document messages carry patient reports — handled
    // by reportIntake (flag ENABLE_REPORT_INTAKE; off → logged and skipped).
    if (msg.type === 'image' || msg.type === 'document') {
      const token = (creds && creds.accessToken) || config.whatsapp.accessToken;
      // Reply to the report upload in the patient's language (from the
      // conversation seeded at booking time).
      const cp = String(msg.from || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
      const existingConv = await db.getOrCreateConversation(cp, null).catch(() => null);
      const handled = await reportIntake.handleInboundMedia(msg, contact, {
        token,
        language: replyLang(existingConv && existingConv.language),
        sendMessage: (to, body) => sendWhatsAppMessage(to, body, creds)
      });
      if (handled) return;
    }

    // Only plain text beyond this point. Interactive / button replies could be added later.
    // An image CAPTION counts: "papa ko chest pain ho raha hai, report bhej raha hoon"
    // is the message that matters, and before this it reached no detector at all —
    // the media branch above returns early and text was read only from msg.text.
    const text = msg.text?.body || msg.button?.text || msg.image?.caption || msg.document?.caption || '';
    if (!from || !text) {
      console.log(`[META-WA] inbound skipped (type=${msg.type}, from=${from})`);
      return;
    }

    const cleanPhone = from.replace(/^whatsapp:/, '').replace(/\D/g, '');

    // ── DETERMINISTIC SAFETY GUARDS, BEFORE ANYTHING ELSE ────────────────────
    // Ahead of the patient lookup and the brain: an emergency must not wait on a
    // database round-trip, and must never reach a model that could ask which
    // doctor they would prefer. Same four detectors, same order, as the voice
    // path. See whatsappGuards.js.
    {
      const guardConv = await db.getOrCreateConversation(cleanPhone, null).catch(() => null);
      const guardLang = replyLang(resolveInboundLanguage(text, guardConv && guardConv.language));
      const lastOutbound = guardConv
        ? await db.getConversationHistory(guardConv.id, 4).then((h) => (([...h].reverse().find((m) => m && m.role === 'assistant') || {}).content || '')).catch(() => '')
        : '';
      const hit = runInboundGuards(text, guardLang, { lastOutbound, historyStage: whatsappChannel.hydrateIntake(guardConv).stage });
      if (hit) {
        console.warn(`[META-WA] GUARD ${hit.kind} — ${hit.detail} — replying deterministically, brain skipped`);
        if (hit.kind === 'emergency' || hit.kind === 'self_harm') {
          alertEmergency({ phone: cleanPhone, kind: hit.kind, detail: hit.detail, text });
        }
        const gSid = await sendWhatsAppMessage(cleanPhone, hit.reply, creds);
        // Persist BOTH turns even on this path. A conversation whose history is
        // missing the emergency exchange would let the brain, on the next
        // message, answer as if nothing had happened.
        if (guardConv) {
          const pid = await db.upsertPatient(cleanPhone, profileName).catch(() => null);
          await db.saveWhatsAppMessage(guardConv.id, pid, 'inbound', text, hit.kind, messageId).catch(() => {});
          if (gSid) await db.saveWhatsAppMessage(guardConv.id, pid, 'outbound', hit.reply, hit.kind, gSid).catch(() => {});
        }
        if (!gSid) {
          console.error(`[META-WA] EMERGENCY REPLY FAILED TO SEND to ${maskPhone(cleanPhone)} — patient received nothing`);
        }
        return;
      }
    }

    const context = await loadPatientContext(cleanPhone);
    const patientId = context.patientId || await db.upsertPatient(cleanPhone, profileName);

    // Language: existing conversation's stored language, then let this message's
    // script refine it (patient may switch languages). Persisted so replies,
    // reminders, and followups all match — end the monolingual WhatsApp gap.
    const existing = await db.getOrCreateConversation(cleanPhone, patientId);
    const language = resolveInboundLanguage(text, existing && existing.language);
    const conv = await db.getOrCreateConversation(cleanPhone, patientId, language);

    await db.saveWhatsAppMessage(conv.id, patientId, 'inbound', text, 'general', messageId);


    // ── THE SAME BRAIN THE PHONE USES ────────────────────────────────────────
    // Was: a second, smaller brain (whatsappBrain) returning an ACTION STRING
    // that this function then executed. That design produced two bugs at once —
    // it could not book at all, and its 'reschedule' branch discarded the slots
    // it fetched, wrote a conversation state nothing reads, never touched the
    // appointment, and still sent the model's "ho gaya" reply.
    //
    // brain-lean executes its own sentinels through the real booking tools, so
    // there is nothing left for this function to "action". Whatever came back
    // is what happened.
    const result = await whatsappChannel.runTurn({
      patientId,
      phone: cleanPhone,
      conv,
      patientName: context.name,
      patientTextAll: await collectInboundText(conv.id),
    });

    if (result.endCall) await db.updateConversationState(conv.id, 'idle');

    // ── THE INVARIANT ────────────────────────────────────────────────────────
    // Send result.text and NOTHING ELSE. It is deliberately NOT wrapped in
    // `if (actionSucceeded)`: on every failure path brain-lean has already
    // REPLACED the model's text with an audited canned line, so the unconditional
    // send is correct by construction. Adding a success check here would leave
    // the model's own sentence as the success message — which is the exact
    // shape of the false-confirmation bug this product has fixed twice.
    const outSid = await sendWhatsAppMessage(cleanPhone, result.text, creds);
    if (outSid) {
      await db.saveWhatsAppMessage(conv.id, patientId, 'outbound', result.text, 'general', outSid);
    } else {
      // metaPost returns null on a Meta error and the send is swallowed, so a
      // committed booking can reach nobody and leave no history row. This is the
      // one hole the invariant cannot close from inside brain-lean, because the
      // failure is downstream of it. Loud, because it is otherwise invisible.
      console.error(`[META-WA] SEND FAILED after brain turn (booked=${!!result.booked}) — ` +
        `patient ${maskPhone(cleanPhone)} received nothing`);
    }
  } catch (err) {
    console.error('[META-WA] processInboundMessage error:', err.message);
  }
}

// ─── TOKEN HEALTH CHECK (S7-T1) ──────────────────────────────────────────────
// Daily probe of Meta's debug_token for the env-configured token. A System-User
// token minted with "Never" expiry reports expires_at=0 (healthy forever); a
// regular user token reports a unix expiry — alert when <14 days out or when
// the token is already invalid, so the 190 class dies BEFORE sends start
// failing. Gated behind TOKEN_HEALTH_CHECK=on (default OFF — shadow
// discipline: nothing calls Meta until the operator enables it).
// debug_token inspects input_token using the same token as access_token —
// valid for a token owned by the app; an already-dead token fails the call
// itself, which we also treat as an alert.
async function checkWhatsAppTokenHealth() {
  const token = config.whatsapp.accessToken;
  if (!token) {
    fireTokenAlert('no META_ACCESS_TOKEN configured — all env-fallback sends will fail');
    return;
  }
  try {
    const res = await axios.get(`https://graph.facebook.com/${config.whatsapp.apiVersion}/debug_token`, {
      params: { input_token: token, access_token: token },
      timeout: 10000
    });
    const data = res.data?.data || {};
    if (!data.is_valid) {
      fireTokenAlert('token INVALID per debug_token', data.error?.message || JSON.stringify(data).slice(0, 300));
      return;
    }
    if (!data.expires_at) {
      // expires_at = 0 → never expires (System-User token). The healthy state.
      console.log(`[META-WA] token health: valid, never expires (type=${data.type || '?'}, scopes=${(data.scopes || []).join(',')})`);
      return;
    }
    const daysLeft = (data.expires_at * 1000 - Date.now()) / 86400000;
    console.log(`[META-WA] token health: valid, expires in ${daysLeft.toFixed(1)} days (${new Date(data.expires_at * 1000).toISOString()})`);
    if (daysLeft < 14) {
      fireTokenAlert(`token expires in ${daysLeft.toFixed(1)} days — mint a System-User never-expire token (see WHATSAPP_TOKEN_SETUP.md)`);
    }
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    fireTokenAlert('debug_token call failed (token likely dead or network issue)', detail);
  }
}

// ─── WEBHOOK ROUTE CHECK ─────────────────────────────────────────────────────
// One Meta app has ONE app-level callback URL — the demo server's. Every clinic
// runs its own server, so a clinic's WABA must carry a WABA-level override to
// its own /whatsapp/incoming (Meta precedence: phone-number override → WABA
// override → app-level URL). Without it, patient replies and delivery receipts
// land on the demo: the desk says "Connected", the demo logs someone else's
// patients, and nothing here ever sees a message. This reads the truth from
// Meta and compares it with where THIS server lives. Read-only. Alerts on the
// token-alert channel. Repair: `railway ssh -s ritu-desk -- npm run wa:webhook -- --set`.
//   expected  = PUBLIC_WEBHOOK_URL || https://$RAILWAY_PUBLIC_DOMAIN/whatsapp/incoming
//   effective = WABA override (read with the clinic's stored token)
//               || app-level callback (read with the app token, app id from debug_token)
function effectiveWebhookRoute({ override, appLevel }) { return override || appLevel || null; }
function webhookRouteVerdict(effective, expected) { return !!effective && effective === expected; }

async function checkWhatsAppWebhookRoute({ clinicId = config.clinicId } = {}) {
  const expected = (process.env.PUBLIC_WEBHOOK_URL || '').trim()
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/whatsapp/incoming` : null);
  if (!expected) {
    console.warn('[META-WA] webhook route: cannot check — no RAILWAY_PUBLIC_DOMAIN; set PUBLIC_WEBHOOK_URL');
    return { skipped: 'no-expected-url' };
  }
  const v = config.whatsapp.apiVersion;
  let wabaId = null;
  try {
    const { rows } = await db.pool.query('SELECT waba_id, whatsapp_status FROM clinics WHERE id = $1', [clinicId]);
    wabaId = rows[0] && rows[0].whatsapp_status === 'connected' ? rows[0].waba_id : null;
  } catch (err) {
    console.warn('[META-WA] webhook route: clinics.waba_id unreadable —', err.message);
    return { skipped: 'no-clinic-row' };
  }
  const creds = await getClinicWhatsAppCreds(clinicId);
  if (!wabaId || !creds) {
    console.log('[META-WA] webhook route: clinic not connected via the desk (env-fallback sends only) — nothing to check');
    return { skipped: 'not-connected' };
  }
  const H = { headers: { Authorization: `Bearer ${creds.accessToken}` }, timeout: 10000 };
  const why = [];   // every read that fails is named in the alert — "unreadable" alone helps nobody
  const graphErr = (err) => (err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message);
  let apps = [];
  try {
    const res = await axios.get(`https://graph.facebook.com/${v}/${wabaId}/subscribed_apps`, H);
    apps = Array.isArray(res.data && res.data.data) ? res.data.data : [];
  } catch (err) {
    const detail = graphErr(err);
    fireTokenAlert('webhook route check: subscribed_apps unreadable with the clinic token', detail);
    return { error: 'subscribed_apps', detail };
  }
  // Our app id: the subscription entry carries it (whatsapp_business_api_data.id).
  // debug_token is only consulted to pick between several subscribed apps.
  let tokenAppId = null;
  if (apps.length > 1) {
    try {
      const dt = await axios.get(`https://graph.facebook.com/${v}/debug_token`, { params: { input_token: creds.accessToken, access_token: creds.accessToken }, timeout: 10000 });
      tokenAppId = (dt.data && dt.data.data && dt.data.data.app_id) || null;
    } catch (err) { why.push(`debug_token: ${graphErr(err)}`); }
  }
  const ours = (tokenAppId && apps.find((a) => String((a.whatsapp_business_api_data || {}).id || '') === String(tokenAppId))) || apps[0] || null;
  if (!ours) {
    fireTokenAlert(`webhook route ✗ our app is NOT subscribed to WABA ${wabaId} — no message from this clinic's patients can reach any server`, 'reconnect WhatsApp from the desk');
    return { ok: false, expected, override: null, appLevel: null, effective: null, apps: 0, why };
  }
  const appId = String((ours.whatsapp_business_api_data || {}).id || tokenAppId || '');
  const override = ours.override_callback_uri || null;
  let appLevel = null;
  if (!override) {
    if (!appId) why.push('app id unknown (subscription entry carries none)');
    else if (!config.whatsapp.appSecret) why.push('META_APP_SECRET unset — the app-level URL needs the app token');
    else {
      try {
        const subs = await axios.get(`https://graph.facebook.com/${v}/${appId}/subscriptions`, { params: { access_token: `${appId}|${config.whatsapp.appSecret}` }, timeout: 10000 });
        const wa = (subs.data && subs.data.data || []).find((s) => s.object === 'whatsapp_business_account');
        appLevel = wa ? wa.callback_url || null : null;
        if (!wa) why.push('app has no whatsapp_business_account subscription');
      } catch (err) { why.push(`app subscriptions: ${graphErr(err)}`); }
    }
  }
  const effective = module.exports.effectiveWebhookRoute({ override, appLevel });
  const ok = module.exports.webhookRouteVerdict(effective, expected);
  const where = override ? `WABA override ${override}` : appLevel ? `the APP-LEVEL URL ${appLevel} (no override on this WABA)` : `UNKNOWN (no override; app-level URL unreadable: ${why.join('; ') || 'no reason recorded'})`;
  if (ok) console.log(`[META-WA] webhook route ✓ this clinic's replies reach this server (${where})`);
  else fireTokenAlert(`webhook route ✗ this clinic's patient replies go to ${where}, not ${expected}`, 'repair: railway ssh -s ritu-desk -- npm run wa:webhook -- --set');
  return { ok, expected, override, appLevel, effective, apps: apps.length, why };
}

// ─── DLQ REDRIVE (S7-T1) ─────────────────────────────────────────────────────
// Replays dead-lettered sends after the operator fixes the cause (token swap,
// template approval, …). Hand-run only via tools/redriveWhatsApp.js — never
// scheduled. Skips indeterminate rows by default (their wamid may exist on
// Meta's side; re-sending could double-message the patient) and rows older
// than maxAgeHours (a confirmation for a long-past appointment is noise —
// same 48h discipline as the no-show job in scheduler.js).
async function sendDlqRedrive({ limit = 50, includeIndeterminate = false, maxAgeHours = 48, dryRun = false } = {}) {
  const { rows } = await db.pool.query(`
    SELECT id, clinic_id, to_phone, message_kind, request_body, indeterminate, created_at
      FROM whatsapp_dlq
     WHERE status = 'dead'
       AND ($1 OR NOT indeterminate)
       AND created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY id
     LIMIT $3`, [includeIndeterminate, String(maxAgeHours), limit]);

  const result = { candidates: rows.length, sent: 0, failed: 0 };
  for (const row of rows) {
    const tag = `dlq#${row.id} → ${row.to_phone} (${row.message_kind}, ${row.indeterminate ? 'INDETERMINATE' : 'definitive'}, ${row.created_at.toISOString()})`;
    if (dryRun) {
      console.log(`[REDRIVE] would send ${tag}`);
      continue;
    }
    // Same creds resolution as the original send sites: clinic's own connected
    // number when present, else the (freshly rotated) env token.
    const creds = await getClinicWhatsAppCreds(row.clinic_id || config.clinicId);
    const wamid = await metaPost(row.request_body, creds, { noDlq: true });
    if (wamid) {
      await db.pool.query(
        `UPDATE whatsapp_dlq SET status = 'redriven', redriven_at = NOW(), redrive_wamid = $1 WHERE id = $2`,
        [wamid, row.id]);
      console.log(`[REDRIVE] ✓ sent ${tag} wamid=${wamid}`);
      result.sent++;
    } else {
      await db.pool.query(
        `UPDATE whatsapp_dlq SET redrive_attempts = redrive_attempts + 1,
                last_redrive_error = 'send returned no wamid (see server logs)' WHERE id = $1`,
        [row.id]);
      console.error(`[REDRIVE] ✗ still failing ${tag}`);
      result.failed++;
    }
  }
  return result;
}

module.exports = {
  resolveInboundLanguage,
  _templateLadder: templateLadder, _liveTemplateLangs: liveTemplateLangs,   // introspection for tests
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendTemplateOrText,
  sendConfirmation,
  sendReminder,
  sendFollowup,
  sendRescheduleOptions,
  handleIncomingWhatsApp,
  verifyWebhook,
  formatWhatsAppNumber,
  checkWhatsAppTokenHealth,
  checkWhatsAppWebhookRoute, effectiveWebhookRoute, webhookRouteVerdict,
  sendDlqRedrive
};
