// ─── ONCOREADY SPEECH: text -> Sarvam voice, for the doctor's records assistant ─
// POST /v1/speech  {text, language?, voice?: {speaker, pace, temperature}}  -> audio/wav (24 kHz)
// HMAC-signed exactly like /v1/browser-sessions (oncoreadyIntake.verify). OncoReady
// only reads out answers it has already built; Ritu just gives them a voice.

const oncoready = require('./oncoreadyIntake');
const sarvam = require('./sarvam');
const config = require('./config');

const MAX_CHARS = 2000;
const SPEAKER = /^[a-z][a-z_]{1,30}$/;

function validate(body) {
  const b = body || {};
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return { error: 'text is required' };
  if (text.length > MAX_CHARS) return { error: `text must be at most ${MAX_CHARS} characters` };
  const language = b.language || 'en-IN';
  if (!config.languageNames || !config.languageNames[language]) return { error: 'unsupported language' };
  const v = b.voice || {};
  if (v.speaker !== undefined && !SPEAKER.test(String(v.speaker))) return { error: 'voice.speaker is invalid' };
  if (v.pace !== undefined && (typeof v.pace !== 'number' || v.pace < 0.5 || v.pace > 2)) return { error: 'voice.pace must be 0.5-2.0' };
  if (v.temperature !== undefined && (typeof v.temperature !== 'number' || v.temperature < 0.01 || v.temperature > 2)) return { error: 'voice.temperature must be 0.01-2.0' };
  return { value: { text, languageCode: language, speaker: v.speaker, pace: v.pace, temperature: v.temperature } };
}

async function speechHandler(req, res, synth = sarvam.textToSpeechWav) {
  if (!oncoready.enabled()) return res.status(503).json({ error: 'OncoReady integration is not configured' });
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (!oncoready.verify(req.get('X-Ritu-Timestamp'), req.get('X-Ritu-Signature'), raw)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  const { value, error } = validate(req.body);
  if (error) return res.status(422).json({ error });
  try {
    const wav = await synth(value.text, value);
    console.log(`[ONCOREADY] speech: ${value.text.length} chars -> ${wav.length} bytes (${value.languageCode}, ${value.speaker || 'default voice'})`);
    res.set('Content-Type', 'audio/wav').set('Cache-Control', 'no-store').send(wav);
  } catch (e) {
    console.error('[ONCOREADY] speech failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'speech synthesis failed' });
  }
}

module.exports = { speechHandler, validate };
