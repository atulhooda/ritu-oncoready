// ═══════════════════════════════════════════════════════════════════════════
// reportIntake.js — WhatsApp report-photo intake (flag ENABLE_REPORT_INTAKE)
//
// After a booking, the WhatsApp confirmation asks the patient to photograph
// any old reports/prescriptions. Inbound image/document messages land here:
// download the media from Meta, store it against the patient, and run a
// vision pass that ORGANIZES the document for the doctor's pre-visit review.
//
// SAFETY: the vision prompt extracts and structures ONLY what is visibly
// written on the document. It never diagnoses, never interprets beyond the
// page, never adds medical advice — the doctor decides. (Decision-support,
// not decision-making: the doctor-judge rule.)
//
// Flag OFF (default): inbound media is logged and skipped — byte-identical
// behavior to before this module existed.
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const config = require('./config');
const db = require('./db');

const ENABLED = process.env.ENABLE_REPORT_INTAKE === 'true';
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10MB guard
const GRAPH_VERSION = process.env.META_API_VERSION || 'v20.0';

// ── Meta media download: media-id → { buffer, mimeType } ────────────────────
async function downloadWaMedia(mediaId, token) {
  const meta = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 15000
  });
  const { url, mime_type: mimeType, file_size: fileSize } = meta.data || {};
  if (!url) throw new Error('media lookup returned no URL');
  if (fileSize && fileSize > MAX_MEDIA_BYTES) throw new Error(`media too large (${fileSize} bytes)`);
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer', timeout: 30000,
    maxContentLength: MAX_MEDIA_BYTES
  });
  return { buffer: Buffer.from(bin.data), mimeType: mimeType || bin.headers['content-type'] || 'image/jpeg' };
}

// ── Vision pre-read: organize-only, never diagnose ───────────────────────────
const VISION_PROMPT = `You are organizing a photo of a medical document (lab report, prescription, or discharge summary) for a doctor's pre-visit review at an Indian clinic.

Extract and structure ONLY what is visibly written on the document. Rules:
- Do NOT diagnose, do NOT interpret findings, do NOT add medical advice or conclusions.
- Do NOT guess unreadable values — omit them.
- Copy names/values/units exactly as printed.

Return ONLY minified JSON, no markdown, in this shape:
{"document_type":"lab_report|prescription|discharge_summary|scan_report|other|unreadable","title":"","date_on_document":"","patient_name_on_document":"","key_values":[{"name":"","value":"","unit":"","reference_range":""}],"medications":[{"name":"","dose":"","frequency":""}],"doctor_or_lab":"","notes":""}`;

async function summarizeReport(buffer, mimeType) {
  const key = config.llm.geminiApiKey;
  if (!key) return null;
  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`,
      {
        contents: [{ parts: [
          { text: VISION_PROMPT },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      },
      { timeout: 30000 }
    );
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonStr = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr);
    return { json: parsed, text: renderSummary(parsed) };
  } catch (err) {
    console.error('[REPORT] vision summary failed:', err.message);
    return null; // image still stored — the doctor sees the photo either way
  }
}

// Patient-facing replies, localized to the conversation language (deps.language).
const GOT_IT = {
  'hi-IN': 'मिल गई 🙏 आपकी रिपोर्ट डॉक्टर साहब के लिए तैयार कर दी है — अपॉइंटमेंट पर वो इसे पहले से देख लेंगे।\n(और रिपोर्ट्स हों तो फोटो यहीं भेजते रहिए।)',
  'mr-IN': 'मिळाली 🙏 तुमची रिपोर्ट डॉक्टरांसाठी तयार केली आहे — अपॉइंटमेंटला ते ती आधीच बघतील.\n(आणखी रिपोर्ट्स असतील तर फोटो इथेच पाठवा.)',
  'en-IN': 'Got it 🙏 Your report is ready for the doctor — they will review it before your appointment.\n(Send photos of any other reports here too.)',
  'kn-IN': 'ಸಿಕ್ಕಿತು 🙏 ನಿಮ್ಮ ರಿಪೋರ್ಟ್ ಡಾಕ್ಟರ್‌ಗೆ ಸಿದ್ಧ ಮಾಡಿದ್ದೇನೆ — ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗೆ ಮೊದಲೇ ಅವರು ನೋಡುತ್ತಾರೆ.\n(ಬೇರೆ ರಿಪೋರ್ಟ್ ಇದ್ದರೆ ಫೋಟೋ ಇಲ್ಲಿಯೇ ಕಳುಹಿಸಿ.)',
  'pa-IN': 'ਮਿਲ ਗਈ 🙏 ਤੁਹਾਡੀ ਰਿਪੋਰਟ ਡਾਕਟਰ ਲਈ ਤਿਆਰ ਕਰ ਦਿੱਤੀ ਹੈ — ਅਪਾਇੰਟਮੈਂਟ ਤੋਂ ਪਹਿਲਾਂ ਉਹ ਵੇਖ ਲੈਣਗੇ।\n(ਹੋਰ ਰਿਪੋਰਟਾਂ ਹੋਣ ਤਾਂ ਫੋਟੋ ਇੱਥੇ ਭੇਜੋ।)',
  'ta-IN': 'கிடைத்தது 🙏 உங்கள் ரிப்போர்ட் டாக்டருக்குத் தயார் — அப்பாயின்ட்மென்ட்டுக்கு முன்பே பார்த்துக்கொள்வார்.\n(வேறு ரிப்போர்ட் இருந்தால் இங்கே அனுப்புங்கள்.)',
  'te-IN': 'వచ్చింది 🙏 మీ రిపోర్ట్ డాక్టర్ కోసం సిద్ధం చేశాను — అపాయింట్మెంట్‌కి ముందే చూస్తారు.\n(వేరే రిపోర్టులు ఉంటే ఫోటో ఇక్కడ పంపండి.)',
  'bn-IN': 'পেয়েছি 🙏 আপনার রিপোর্ট ডাক্তারের জন্য তৈরি — অ্যাপয়েন্টমেন্টের আগেই দেখে নেবেন।\n(আরও রিপোর্ট থাকলে ছবি এখানে পাঠান।)',
  'gu-IN': 'મળી ગઈ 🙏 તમારો રિપોર્ટ ડૉક્ટર માટે તૈયાર છે — એપોઇન્ટમેન્ટ પહેલાં તેઓ જોઈ લેશે.\n(બીજા રિપોર્ટ હોય તો ફોટો અહીં મોકલો.)',
  'ml-IN': 'കിട്ടി 🙏 നിങ്ങളുടെ റിപ്പോർട്ട് ഡോക്ടർക്കായി തയ്യാർ — അപ്പോയിന്റ്മെന്റിന് മുൻപേ അവർ നോക്കും.\n(വേറെ റിപ്പോർട്ടുകൾ ഉണ്ടെങ്കിൽ ഫോട്ടോ ഇവിടെ അയയ്ക്കൂ.)',
  'od-IN': 'ମିଳିଲା 🙏 ଆପଣଙ୍କ ରିପୋର୍ଟ ଡାକ୍ତରଙ୍କ ପାଇଁ ପ୍ରସ୍ତୁତ — ଆପଏଣ୍ଟମେଣ୍ଟ ପୂର୍ବରୁ ସେ ଦେଖିନେବେ।\n(ଅନ୍ୟ ରିପୋର୍ଟ ଥିଲେ ଫଟୋ ଏଠାରେ ପଠାନ୍ତୁ।)',
};
const RETRY_ASK = {
  'hi-IN': 'माफ़ कीजिए, फोटो receive नहीं हो पाई — एक बार फिर भेज दीजिए? 🙏',
  'mr-IN': 'माफ करा, फोटो मिळाला नाही — पुन्हा एकदा पाठवाल का? 🙏',
  'en-IN': "Sorry, the photo didn't come through — could you send it once more? 🙏",
  'kn-IN': 'ಕ್ಷಮಿಸಿ, ಫೋಟೋ ಸಿಗಲಿಲ್ಲ — ಇನ್ನೊಮ್ಮೆ ಕಳುಹಿಸುತ್ತೀರಾ? 🙏',
  'pa-IN': 'ਮਾਫ਼ ਕਰਨਾ, ਫੋਟੋ ਨਹੀਂ ਮਿਲੀ — ਇੱਕ ਵਾਰ ਫਿਰ ਭੇਜੋਗੇ? 🙏',
  'ta-IN': 'மன்னிக்கவும், போட்டோ வரவில்லை — மீண்டும் அனுப்புவீர்களா? 🙏',
  'te-IN': 'క్షమించండి, ఫోటో అందలేదు — మళ్ళీ పంపుతారా? 🙏',
  'bn-IN': 'দুঃখিত, ছবিটা আসেনি — আরেকবার পাঠাবেন? 🙏',
  'gu-IN': 'માફ કરજો, ફોટો મળ્યો નહીં — ફરી મોકલશો? 🙏',
  'ml-IN': 'ക്ഷമിക്കണം, ഫോട്ടോ കിട്ടിയില്ല — ഒന്നുകൂടി അയയ്ക്കാമോ? 🙏',
  'od-IN': 'କ୍ଷମା କରିବେ, ଫଟୋ ମିଳିଲା ନାହିଁ — ପୁଣି ଥରେ ପଠାଇବେ? 🙏',
};
function reply(table, lang) { return table[lang] || table['hi-IN']; }

// Human line for the dashboard card ("Lab report · 12 Mar 2026 · 8 values").
function renderSummary(j) {
  if (!j || j.document_type === 'unreadable') return 'Document stored (unreadable for auto-summary)';
  const bits = [String(j.document_type || 'document').replace(/_/g, ' ')];
  if (j.title) bits.push(j.title);
  if (j.date_on_document) bits.push(j.date_on_document);
  if (Array.isArray(j.key_values) && j.key_values.length) bits.push(`${j.key_values.length} values`);
  if (Array.isArray(j.medications) && j.medications.length) bits.push(`${j.medications.length} medication(s)`);
  return bits.join(' · ');
}

// ── Inbound entry point (called from whatsapp.js for image/document msgs) ────
// deps: { sendMessage, token } injected by the caller — no require cycle.
async function handleInboundMedia(msg, contact, deps) {
  if (!ENABLED) {
    console.log(`[REPORT] inbound ${msg.type} ignored (ENABLE_REPORT_INTAKE off)`);
    return false;
  }
  const media = msg.image || msg.document;
  const from = msg.from;
  if (!media || !media.id || !from) return false;
  const cleanPhone = String(from).replace(/^whatsapp:/, '').replace(/\D/g, '');
  const profileName = contact?.profile?.name || 'Patient';
  try {
    console.log(`[REPORT] inbound ${msg.type} from ••••••${cleanPhone.slice(-4)} (media ${media.id})`);
    const { buffer, mimeType } = await downloadWaMedia(media.id, deps.token);

    const patientId = await db.upsertPatient(cleanPhone, profileName);
    const summary = await summarizeReport(buffer, mimeType);

    await db.savePatientDocument({
      clinicId: config.clinicId,
      patientId,
      phone: cleanPhone,
      waMediaId: media.id,
      mimeType,
      caption: media.caption || null,
      content: buffer,
      summary: summary ? summary.text : null,
      summaryJson: summary ? summary.json : null
    });
    console.log(`[REPORT] ✓ stored ${Math.round(buffer.length / 1024)}KB ${mimeType} for patient ${patientId} — ${summary ? summary.text : 'no auto-summary'}`);

    if (deps.sendMessage) {
      await deps.sendMessage(cleanPhone, reply(GOT_IT, deps.language));
    }
    return true;
  } catch (err) {
    console.error('[REPORT] intake failed:', err.message);
    if (deps.sendMessage) {
      await deps.sendMessage(cleanPhone, reply(RETRY_ASK, deps.language)).catch(() => {});
    }
    return true; // handled (don't fall through to the text brain)
  }
}

module.exports = { handleInboundMedia, downloadWaMedia, summarizeReport, renderSummary };
