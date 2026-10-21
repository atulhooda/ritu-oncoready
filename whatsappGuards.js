// ═══════════════════════════════════════════════════════════════════════════
// THE DETERMINISTIC SAFETY GUARDS, ON THE WHATSAPP PATH.
//
// The inbound WhatsApp path had NONE. Zero calls to any detector. That was
// survivable while Ritu could only confirm and cancel an existing appointment;
// it stopped being survivable the moment she could hold a conversation and book,
// because people now type what is actually wrong with them. Somebody writing
//     "papa ko chest pain ho raha hai"
// must not be answered with a question about which doctor they would prefer.
//
// Same four detectors as the voice path, in the same order (callHandler.js
// :1192, :1216, :1471, :1490), because the ordering is itself a decision:
// emergency outranks a privacy probe, which outranks a request for medical
// advice. A message can look like more than one; the most dangerous reading
// wins.
//
// EVERY GUARD RETURNS TEXT, NOT AUDIO. handleEmergency plays a pre-cached clip
// and hangs up; neither exists here. safetyText.emergencyTextFor() adapts the
// same wording for a channel with no call to end — see the reasoning there, and
// note the self-harm line keeps Tele-MANAS 14416 and never mentions 108.
//
// WHY THIS FILE AND NOT INSIDE whatsapp.js: it must be testable without a
// webhook, a Meta token, or a database. And it must NEVER require('./callHandler')
// — callHandler → crm → whatsapp is a cycle that silently breaks the voice
// path's post-call confirmation (see safetyText.js).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const config = require('./config');
const { detectEmergency, composeEmergencyProbe } = require('./emergencyDetector');
const { detectEmergencyV2, v2Enforces } = require('./emergencyDetectorV2');
const { detectSensitiveProbe } = require('./sensitiveDataGuard');
const { detectMedicalAdvice, adviceGuardSuppressed } = require('./medicalAdviceGuard');
const { emergencyTextFor } = require('./safetyText');
const { maskPhone } = require('./redact');

/**
 * Run every deterministic guard over one inbound message.
 *
 * @param {string} text   what the patient typed (or an image caption)
 * @param {string} lang   ISO code for the reply, e.g. 'hi-IN'
 * @returns {{kind:string, reply:string, detail?:string}|null}
 *          null = nothing fired, carry on to the brain.
 */
// Ritu's last outbound line asked about medicines/allergies → the patient's
// answer ("Betnovate lagata hoon") must not be deflected as an advice request.
// Voice carries historyStage for this; WhatsApp passes the last outbound text.
const ASKS_MEDS = /दवा|दवाई|medicine|medication|allerg|एलर्जी|औषध|ઔષધ|દવા|ಔಷಧ|ਦਵਾਈ|மருந்து|మందు|ওষুধ|മരുന്ന്|ଔଷଧ/i;
function runInboundGuards(text, lang, { lastOutbound = '', historyStage } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Detectors are written in Devanagari. A patient typing Gurmukhi, Tamil or
  // Kannada must hit the same patterns, so the transliterated form is appended
  // rather than substituted — the original still has to match Latin patterns.
  // ONE definition, shared with the voice path — emergencyDetector.composeEmergencyProbe.
  const probe = composeEmergencyProbe(raw);

  // 1 ── EMERGENCY. First, always. Nothing outranks it.
  const em = detectEmergency(probe);
  if (em) {
    const selfHarm = em.type === 'self_harm';
    return {
      kind: selfHarm ? 'self_harm' : 'emergency',
      reply: emergencyTextFor(lang, selfHarm),
      detail: `${em.type}: "${em.matched}"`,
    };
  }

  // 2 ── EMERGENCY v2, flag-gated and RED-tier only, exactly as on voice.
  // Wrapped: a detector that throws must never stop a patient being answered,
  // and on this path a throw would surface as total silence.
  {
    try {
      const v2 = detectEmergencyV2(raw, {});
      if (v2 && v2.tier === 'RED' && v2Enforces(v2.category)) {
        const selfHarm = v2.category === 'selfharm';   // v2 returns {tier, category}; voice maps the same way
        return {
          kind: selfHarm ? 'self_harm' : 'emergency',
          reply: emergencyTextFor(lang, selfHarm),
          detail: `v2 ${v2.category || 'RED'}`,
        };
      }
    } catch (err) {
      console.error('[WA-GUARD] emergencyDetectorV2 threw:', err.message);
    }
  }

  // 3 ── SENSITIVE-DATA PROBE (asking for someone else's records, staff numbers…)
  const probeHit = detectSensitiveProbe(probe, lang);
  if (probeHit) return { kind: 'sensitive', reply: probeHit.response, detail: probeHit.type };

  // 4 ── MEDICAL ADVICE ("what should I take for…"). Deflected deterministically,
  // never sent to the model — a receptionist does not prescribe.
  const advice = detectMedicalAdvice(probe, lang);
  // The thread's persisted intake stage (whatsapp_conversations.intake) is the
  // same signal voice keys on; the regex on the last outbound is the fallback
  // for a thread that predates the column.
  const stage = Number.isFinite(historyStage) ? historyStage : (ASKS_MEDS.test(String(lastOutbound || '')) ? 2 : 0);
  if (advice && !adviceGuardSuppressed(advice, { historyStage: stage })) return { kind: 'medical_advice', reply: advice.response, detail: advice.type };

  return null;
}

/**
 * Escalate an emergency that arrived as TEXT.
 *
 * On a call the patient hears the 108 line immediately and a human can ring
 * back. On WhatsApp nobody is listening — the message may arrive at 2am — so
 * this alert is the ONLY escalation, which makes it more important here than on
 * voice, not less. Fire-and-forget: an alert failure must never stop the reply.
 */
function alertEmergency({ phone, kind, detail, text }) {
  console.error(`[WA-EMERGENCY] ${kind} from ${maskPhone(phone)} — ${detail}`);
  const url = config.n8n && config.n8n.webhookUrl;
  if (!url) return;
  const axios = require('axios');
  axios.post(url, {
    type: 'whatsapp_emergency',
    kind,
    detail,
    phone,
    // Truncated: enough for a human to judge urgency, not a transcript dump
    // into a third-party automation tool.
    message: String(text || '').slice(0, 300),
    timestamp: new Date().toISOString(),
  }, { timeout: 3000 }).catch(() => {});
}

module.exports = { runInboundGuards, alertEmergency };
