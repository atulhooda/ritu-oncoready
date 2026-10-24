// ═══════════════════════════════════════════════════════════════════════════
// ONCOREADY PRE-VISIT INTAKE — browser sessions run by Ritu
//
// OncoReady (a separate app) lets a patient press "Start session" in the
// browser and talk to Ritu, who asks about their symptoms now, then about the
// records they already have. Contract: ritu-oncoready/docs/VOICE_INTEGRATION.md.
//
//   1. OncoReady → POST /v1/browser-sessions (HMAC-signed). We keep the request
//      under a single-use, short-lived token and return {session_id, ws_url, token}.
//   2. The patient's browser opens /media-stream and sends the token in the
//      `start` event's customParameters.session_token. index.js consumes it here
//      INSTEAD of the Exotel account_sid check — a browser has no account_sid.
//   3. CallHandler runs in intake mode: this file's prompt, not the booking
//      receptionist; booking sentinels never parsed; END_CALL still ends it.
//   4. At endCall, the transcript is POSTed back to OncoReady (HMAC-signed,
//      retried). The clinic's own call log, Sheet and WhatsApp are not touched —
//      these are not clinic calls and the patient is not a clinic caller.
//
// OncoReady owns WHAT is asked (the script). Ritu owns HOW: voice, language,
// turn-taking, and every existing safety guard (emergency detector, medical-
// advice deflection, sensitive-data refusal) still runs on every turn.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { SPOKEN_SET } = require('./spokenLanguages');

const MAX_SKEW_SECONDS = 300;
const TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_SESSIONS = 200;                 // in-memory: one Ritu instance per deploy
const RETRY_DELAYS_MS = [0, 2000, 10000, 30000];

const sessions = new Map();               // token → session

function sharedSecret() {
  return process.env.ONCOREADY_SHARED_SECRET || '';
}

function enabled() {
  return !!sharedSecret();
}

// hex(HMAC_SHA256(secret, timestamp + "." + body)) — the same on both sides.
function sign(timestamp, body, secret = sharedSecret()) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

function verify(timestamp, signature, body, now = Date.now()) {
  const secret = sharedSecret();
  if (!secret || !timestamp || !signature || !body) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(sign(String(timestamp), body, secret), 'hex');
  let given;
  try { given = Buffer.from(String(signature), 'hex'); } catch (_) { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ─── REQUEST VALIDATION ─────────────────────────────────────────────────────
// Everything here ends up in a system prompt, so it is bounded and typed. A
// script is OncoReady's data, but a prompt is still not a place for surprises.
function str(v, max) {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

function validateRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const externalRef = str(body.external_ref, 200);
  if (!externalRef) return { error: 'external_ref is required' };
  const language = SPOKEN_SET.has(body.language) ? body.language : null;
  if (!language) return { error: `language must be one of ${[...SPOKEN_SET].join(', ')}` };
  let callbackUrl = null;
  try {
    const u = new URL(body.callback_url);
    if (u.protocol === 'http:' || u.protocol === 'https:') callbackUrl = u.toString();
  } catch (_) { /* invalid */ }
  if (!callbackUrl) return { error: 'callback_url must be an http(s) URL' };

  const s = body.script || {};
  const steps = Array.isArray(s.steps) ? s.steps.slice(0, 10) : [];
  const cleanSteps = steps.map((st) => ({
    id: str(st && st.id, 60),
    goal: str(st && st.goal, 1000),
    prompts: Array.isArray(st && st.prompts) ? st.prompts.map((p) => str(p, 300)).filter(Boolean).slice(0, 8) : [],
  })).filter((st) => st.id && st.goal);
  if (!cleanSteps.length) return { error: 'script.steps must contain at least one step with id and goal' };

  // Optional voice style. Bounded to what Sarvam bulbul:v3 accepts.
  const v = body.voice || {};
  const voice = {};
  if (v.speaker !== undefined) {
    if (typeof v.speaker !== 'string' || !/^[a-z]{2,20}$/.test(v.speaker)) return { error: 'voice.speaker must be a Sarvam speaker id' };
    voice.speaker = v.speaker;
  }
  if (v.pace !== undefined) {
    if (typeof v.pace !== 'number' || v.pace < 0.5 || v.pace > 2) return { error: 'voice.pace must be 0.5-2.0' };
    voice.pace = v.pace;
  }
  if (v.temperature !== undefined) {
    if (typeof v.temperature !== 'number' || v.temperature < 0.01 || v.temperature > 2) return { error: 'voice.temperature must be 0.01-2.0' };
    voice.temperature = v.temperature;
  }

  const ctx = body.context || {};
  return {
    value: {
      externalRef,
      language,
      callbackUrl,
      patientName: str(ctx.patient_display_name, 120),
      clinicName: str(ctx.clinic_display_name, 120),
      script: {
        purpose: str(s.purpose, 60) || 'pre_visit_intake',
        // What kind of conversation this is, and how to open it (defaults: a pre-visit check-in).
        intro: str(s.intro, 200),
        opening: str(s.opening, 400),
        rules: Array.isArray(s.rules) ? s.rules.map((r) => str(r, 400)).filter(Boolean).slice(0, 8) : [],
        background: str(s.background, 800),
        steps: cleanSteps,
        closing: str(s.closing, 400),
      },
      maxDurationS: Math.min(Math.max(parseInt(body.max_duration_s, 10) || 600, 60), 1200),
      voice: Object.keys(voice).length ? voice : null,
    },
  };
}

// ─── TOKENS ────────────────────────────────────────────────────────────────
function sweep(now = Date.now()) {
  for (const [token, s] of sessions) {
    if (s.used || s.expiresAt < now) sessions.delete(token);
  }
}

function createSession(value, now = Date.now()) {
  sweep(now);
  if (sessions.size >= MAX_SESSIONS) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    ...value,
    sessionId: 'rs_' + crypto.randomBytes(9).toString('hex'),
    token,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    used: false,
  };
  sessions.set(token, session);
  return session;
}

// Single use: a token that connected once cannot connect again, even within
// its two minutes. An expired or unknown token returns null.
function consumeToken(token, now = Date.now()) {
  const s = token && sessions.get(String(token));
  if (!s || s.used || s.expiresAt < now) return null;
  s.used = true;
  sessions.delete(s.token);
  return s;
}

function publicWsUrl(req) {
  const base = (process.env.ONCOREADY_PUBLIC_WS_BASE || '').replace(/\/+$/, '');
  if (base) return `${base}/media-stream?sample-rate=8000`;
  // Fallback: the host OncoReady used to reach us. Correct when the browser can
  // reach that same host; set ONCOREADY_PUBLIC_WS_BASE when it cannot (Docker).
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' ? 'wss' : 'ws';
  return `${proto}://${req.headers.host}/media-stream?sample-rate=8000`;
}

// POST /v1/browser-sessions
function createSessionHandler(req, res) {
  if (!enabled()) return res.status(503).json({ error: 'OncoReady integration is not configured' });
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (!verify(req.get('X-Ritu-Timestamp'), req.get('X-Ritu-Signature'), raw)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const { value, error } = validateRequest(req.body);
  if (error) return res.status(422).json({ error });
  const session = createSession(value);
  if (!session) return res.status(503).json({ error: 'too many pending sessions' });
  console.log(`[ONCOREADY] session ${session.sessionId} created (${session.language}, ${session.script.steps.length} steps)`);
  return res.status(201).json({
    session_id: session.sessionId,
    ws_url: publicWsUrl(req),
    token: session.token,
    expires_at: new Date(session.expiresAt).toISOString(),
  });
}

// ─── THE CONVERSATION ──────────────────────────────────────────────────────
function buildIntakePrompt(session, languageName) {
  const s = session.script;
  const steps = s.steps.map((st, i) =>
    `${i + 1}. [${st.id}] ${st.goal}` +
    (st.prompts.length ? `\n   Example questions (say them in ${languageName}, naturally): ${st.prompts.map((p) => `"${p}"`).join(' / ')}` : '')
  ).join('\n');
  const rules = s.rules.length ? s.rules.map((r) => `- ${r}`).join('\n') : '';
  return `You are Ritu, a warm voice assistant doing ${s.intro || 'a short PRE-VISIT check-in'}${session.clinicName ? ` for ${session.clinicName}` : ''}.
You are talking to ${session.patientName || 'the patient'} in their web browser. This is NOT a booking call.

${s.background ? `WHAT YOU ALREADY KNOW: ${s.background}

` : ''}LANGUAGE: Speak ONLY ${languageName}, in the script ${languageName} is normally written in. Short, simple spoken sentences.

YOUR JOB: collect information for the doctor, in this order:
${steps}

HOW TO TALK:
- ONE question at a time. Wait for the answer. Brief acknowledgement, then the next question.
- Keep the patient's own words in mind; never correct them, never summarise their condition.
- When a step's goal is met (they have nothing more to add), move to the next step.
- If the patient asks a medical question, say kindly that their doctor will go through it with them, then continue.
- Never diagnose, never say what a symptom means, never suggest medicines, tests, or treatment.
- Never book, move, or cancel appointments, and never ask for phone numbers or ID numbers.
${rules ? `\nRULES FROM THE CLINIC:\n${rules}\n` : ''}
ENDING: when every step is done, close the conversation in ${languageName}${s.closing ? `, following this guidance: ${s.closing}` : ' by thanking the patient'}
Then, on its own final line, write exactly:
END_CALL:true
If the patient wants to stop early, thank them, close the same way, and end.`;
}

const SENTINEL_LINE = /^\s*[A-Z][A-Z_]{2,}\s*:.*$/gm;

// The model's reply → {text, endCall}. Any sentinel-shaped line is removed so
// a stray BOOK_APPOINTMENT (from habit) can never be spoken or acted on.
function parseReply(raw) {
  const s = String(raw || '');
  const endCall = /END_CALL\s*:\s*true/i.test(s);
  const text = s.replace(SENTINEL_LINE, '').replace(/\n{2,}/g, '\n').trim();
  return { text, endCall };
}

const OPENING_INSTRUCTION = 'The session has just connected. Greet the patient by name, say in one short sentence that you will ask a few questions for their doctor before the visit, and ask the first question.';

function openingInstruction(session) {
  const opening = session && session.script && session.script.opening;
  return opening ? `The session has just connected. ${opening}` : OPENING_INSTRUCTION;
}

// ─── THE RESULT BACK TO ONCOREADY ──────────────────────────────────────────
function buildResult(session, { transcript, startedAt, endedAt, endTrigger, criticalErrors, emergency }) {
  const turns = (transcript || [])
    .filter((t) => t && (t.role === 'patient' || t.role === 'ritu') && String(t.text || '').trim())
    .map((t) => ({ role: t.role, text: String(t.text), time: t.time || null }));
  const patientTurns = turns.filter((t) => t.role === 'patient').length;
  let status = 'completed';
  if (!patientTurns) status = criticalErrors ? 'failed' : 'no_input';
  return {
    session_id: session.sessionId,
    external_ref: session.externalRef,
    status,
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    ended_at: new Date(endedAt || Date.now()).toISOString(),
    language: session.language,
    end_trigger: endTrigger || null,
    emergency: !!emergency,
    transcript: turns,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signed POST with retries. OncoReady ignores duplicates, so a retry after a
// timeout that actually landed is harmless. Never throws: this runs in endCall.
async function postResult(session, result, { delays = RETRY_DELAYS_MS, post = axios.post } = {}) {
  const body = JSON.stringify(result);
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const r = await post(session.callbackUrl, body, {
        headers: { 'Content-Type': 'application/json', 'X-Ritu-Timestamp': ts, 'X-Ritu-Signature': sign(ts, body) },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        console.log(`[ONCOREADY] ${session.sessionId} result delivered (${result.status}, ${result.transcript.length} turns)`);
        return true;
      }
      console.warn(`[ONCOREADY] ${session.sessionId} callback attempt ${attempt + 1} → HTTP ${r.status}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return false; // won't get better
    } catch (err) {
      console.warn(`[ONCOREADY] ${session.sessionId} callback attempt ${attempt + 1} failed: ${err.code || err.message}`);
    }
  }
  console.error(`[ONCOREADY] ${session.sessionId} result NOT delivered after ${delays.length} attempts`);
  return false;
}

module.exports = {
  enabled,
  sign,
  verify,
  validateRequest,
  createSession,
  consumeToken,
  createSessionHandler,
  buildIntakePrompt,
  parseReply,
  buildResult,
  postResult,
  OPENING_INSTRUCTION,
  openingInstruction,
  _sessions: sessions,
};
