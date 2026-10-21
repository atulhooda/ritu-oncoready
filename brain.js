const { checkAvailability, bookAppointment, getNextAvailableSlots, updateAppointment } = require('./calendar');
const { completeWithFailover } = require('./llm');

// ─── CLINIC CONFIG (will be per-tenant later) ────────────────────────────────
const CLINIC_NAME = process.env.CLINIC_NAME || 'Sai Shradha Health Care Centre';
const CLINIC_TIMINGS = process.env.CLINIC_TIMINGS || 'Monday–Saturday, 10 AM – 6 PM';
const CLINIC_CLOSED = process.env.CLINIC_CLOSED || 'Sunday';
const CLINIC_LOCATION = process.env.CLINIC_LOCATION || '';
const CLINIC_CONTACT = process.env.CLINIC_CONTACT || '';
const APPOINTMENT_DURATION = process.env.APPOINTMENT_DURATION || '30 minutes';

// ─── SYSTEM PROMPT (token-optimized; ~450 tokens vs ~850 prior) ──────────────
// Preserves every load-bearing behavior catalogued in BEHAVIOR_SPEC.md:
// identity, 12 languages, Indic-script-mix prohibition, conversation flow,
// edge cases, emergency script, all 5 sentinels, "no bare sentinels" rule.
// Cuts duplication, verbose explanations, and instructional repetition that
// the LLM doesn't need restated three ways.
const SYSTEM_PROMPT = `Tu ${CLINIC_NAME} ki AI receptionist Ritu hai — warm professional female.

CLINIC: ${CLINIC_NAME} | ${CLINIC_TIMINGS} | ${CLINIC_CLOSED} closed | Slot: ${APPOINTMENT_DURATION}${CLINIC_LOCATION ? ` | ${CLINIC_LOCATION}` : ''}${CLINIC_CONTACT ? ` | ${CLINIC_CONTACT}` : ''}

LANGUAGE — Tu MULTILINGUAL hai. Yeh saari languages FLUENTLY bol sakti hai:
Hindi, English, Marathi, Punjabi, Gujarati, Bengali, Tamil, Telugu, Kannada, Malayalam, Odia.
Patient jo bhi language bole, ya jis language mein baat karne ko kahe, TURANT usi mein switch kar ke poora jawab de.
KABHI mat bol "main yeh language nahi bol sakti", "मराठी में नहीं", ya "I can't help with that" — yeh GALAT hai. Har listed language tujhe aati hai. Marathi maange toh Marathi mein bol, Tamil maange toh Tamil mein.

CONSISTENCY (bahut zaroori): Ek hi call mein EK hi language rakho — jo patient bol raha hai. Beech mein language mat badlo. Agar patient Marathi mein hai toh greeting, sawal, wrap-up, goodbye — SAB Marathi mein. Hindi-Marathi mat milao.
Niche jo example phrases diye hain (jaise "कुछ और मदद चाहिए?", "मतलब कौनसी तकलीफ़ है?") woh Hindi mein sirf GUIDE ke liye hain — inhe patient ki language mein TRANSLATE kar ke bol, jaise-ka-taisa Hindi mat copy kar. Marathi call mein "कुछ और मदद चाहिए?" ki jagah "आणखी काही मदत हवी का?" bol.

EK HI SCRIPT PER REPLY (warna TTS odd lagti hai):
- Hindi/Hinglish → POORA jawab DEVANAGARI (हिंदी). English words bhi Devanagari mein: appointment→अपॉइंटमेंट, slot→स्लॉट, doctor→डॉक्टर, time→समय. Roman/Latin letters mein Hindi KABHI mat likh ("aapka", "kya", "baje" — galat).
- English → POORA jawab English mein (Latin).
- Marathi → POORA jawab Marathi mein (Devanagari script).
- Punjabi → Gurmukhi script. Bengali → Bengali script. Tamil → Tamil script. Telugu/Kannada/Malayalam/Gujarati/Odia → har ek apni script mein.
- Ek reply mein DO script kabhi mat milao. No romanized Hindi.

TONE: Warm, calm, female (मैं करती हूँ, बोल रही हूँ). Naam ke saath "जी". Natural, robotic nahi.

FORMAT: Phone call — max 1-2 chhote sentence (≤15 words). Ek baar mein EK sawal. Numbers natural (दो मार्च, ग्यारह बजे).

FLOW (order mein, koi step skip mat kar):
1. GREET → naam pooch. Naam milte hi apne AGLE jawab mein naam use kar (jaise "अच्छा सिद्धार्थ जी, ...") — taaki agar tune galat suna ho toh patient turant theek kar de. Yeh natural rakhe, alag se "sahi suna?" mat pooch.
2. REASON → takleef pooch. Vague jawab ("हाँ") → dobara: "मतलब कौनसी तकलीफ़ है?"
3. SCHEDULE → din/time pooch
4. BOOK → patient ki "हाँ" pe BOOK_APPOINTMENT emit kar
5. WRAP → booking ke baad: "कुछ और मदद चाहिए?"
6. END → "नहीं/बाय" pe goodbye + END_CALL:true

EDGE CASES (Devanagari mein bol):
- Slot unavailable → alternatives de
- Vague time → "कल या किसी और दिन? सुबह या शाम?"
- Medical/fees sawal → "यह डॉक्टर बताएंगे"
- Patient correct kare → accept kar, chhoti si sorry
- Rude → "मैं समझ सकती हूँ, पूरी मदद करती हूँ"

EMERGENCY (chest pain, saans nahi, accident, behoshi, bleeding, stroke):
Bilkul YEH bol (Devanagari): "यह इमरजेंसी है। अभी 108 कॉल करें या हॉस्पिटल जाएं।"
Phir: EMERGENCY_DETECTED:true
No questions, no alternatives.

SENTINELS (machine-only, never speak aloud, always on new line after spoken reply):
PATIENT_NAME:Name
PATIENT_REASON:Reason
BOOK_APPOINTMENT:{"patientName":"X","reason":"Y","dateTime":"2026-03-01T11:00:00+05:30"}
UPDATE_APPOINTMENT:{"dateTime":"2026-03-01T15:00:00+05:30"}
END_CALL:true

RULES:
- EVERY response MUST have spoken text + sentinels on new lines. Never sentinels only.
- After successful booking, don't emit BOOK_APPOINTMENT again.
- After END_CALL, no other sentinels.`;

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function extractBookingIntent(text) {
  const match = text.match(/BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.error('Failed to parse BOOK_APPOINTMENT JSON:', match[1]);
      return null;
    }
  }
  return null;
}

function extractUpdateIntent(text) {
  const match = text.match(/UPDATE_APPOINTMENT:\s*(\{[\s\S]*?\})/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.error('Failed to parse UPDATE_APPOINTMENT JSON:', match[1]);
      return null;
    }
  }
  return null;
}

// Tokens the LLM sometimes emits as a "name" or "reason" when the patient
// hasn't actually given one yet (e.g. "मेरा नाम है..." pauses; LLM emits
// "नहीं मिला अभी तक" meaning "not received yet" as the value itself).
const FIELD_FRAGMENTS = new Set([
  // Name pronouns / auxiliaries
  'naam', 'naam hai', 'mera naam', 'mera naam hai',
  'my name', 'my name is', 'name', 'name is',
  'ji', 'haan', 'haan ji', 'sir', 'madam', 'hai', 'hain',
  'नाम', 'मेरा', 'मेरा नाम', 'मेरा नाम है', 'जी', 'हाँ', 'है', 'हैं',
  // "Not yet known" placeholders the LLM hallucinates as values
  'unknown', 'na', 'none', 'null', 'n/a', 'not provided', 'not received',
  'not received yet', 'not given', 'not given yet', 'not yet',
  'pata nahi', 'pata nahi hai', 'nahi pata', 'abhi nahi',
  'नहीं मिला', 'नहीं मिला अभी तक', 'अभी तक नहीं', 'पता नहीं', 'अभी नहीं'
]);

function isValidFieldValue(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 2) return false;
  if (FIELD_FRAGMENTS.has(normalized)) return false;
  return true;
}

// Backwards-compat alias for the BOOK_APPOINTMENT JSON path.
const isValidName = isValidFieldValue;

function extractPatientName(text) {
  const match = text.match(/PATIENT_NAME:\s*(.+)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!isValidFieldValue(candidate)) {
    console.log(`[BRAIN] Rejected fragment as name: "${candidate}"`);
    return null;
  }
  return candidate;
}

function extractPatientReason(text) {
  const match = text.match(/PATIENT_REASON:\s*(.+)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!isValidFieldValue(candidate)) {
    console.log(`[BRAIN] Rejected fragment as reason: "${candidate}"`);
    return null;
  }
  return candidate;
}

// Every machine sentinel the prompts can emit. SINGLE SOURCE — the payload
// regex and the line filter below are both derived from it.
//
// CANCEL_APPOINTMENT was missing from BOTH for as long as it has existed. The
// consequence was invisible on voice (the TTS reads the JSON aloud as garbage)
// and glaring on WhatsApp, where the patient reads
//     CANCEL_APPOINTMENT:{"patientName":"Sid","doctor":""}
// at the exact moment they are trying to cancel a medical appointment. It only
// surfaces when the payload does not parse, because a parsed sentinel is
// consumed upstream — so the bug hid behind the happy path.
//
// Deriving both passes from one array is the actual fix: adding a sentinel to a
// prompt and forgetting it here is what happened, and a hand-maintained second
// list is how it happens again. tests/test-sentinel-leak.js locks it.
// ─── THE SENTINEL LIST. ONE LIST. ───────────────────────────────────────────
// Every name a model may emit as machine-only text. Anything here is stripped
// from spoken output by cleanResponse and, in brain-streaming.js, both stops
// sentence emission and forces the non-streaming path.
//
// REQUEST_CALLBACK WAS MISSING, AND A PATIENT HEARD IT. Live call
// c791e4114d5658031b7b6bbdf3f81a8b, 2026-08-11 09:54:50 IST. The sentinel was
// added to brain-lean.js the previous day (79f2677) and to NOTHING else, so
// Ritu spoke, in Marathi TTS, character by character:
//
//   "कॅन्सर स्पेशलिस्टसाठी डॉ. रेखा सरदेसाई आहेत.
//    REQUEST_CALLBACK:{"patientName":"Siddharth","specialty":"Oncologist",...}"
//
// 24 seconds of it. And because the streaming path never handed the turn to
// processLeanRaw, no callbacks row was written either — the exact failure
// 79f2677 existed to fix, reintroduced by the fix itself.
//
// There were FOUR lists of sentinel names: this one, brain-streaming's
// SENTINEL_LINE, brain-streaming's scanForBookingIntent, and the declarations
// in brain-lean's prompt. Adding a sentinel meant remembering all four. Now
// this is the only one that is hand-maintained; the others derive from it, and
// tests/test-sentinel-coverage.js fails if a sentinel declared in the prompt
// is missing from here.
const SENTINEL_NAMES = ['BOOK_APPOINTMENT', 'UPDATE_APPOINTMENT', 'CANCEL_APPOINTMENT', 'REQUEST_CALLBACK'];

function cleanResponse(text) {
  let cleaned = String(text || '');
  for (const name of SENTINEL_NAMES) {
    // Well-formed payload first (non-greedy, so two sentinels in one reply do
    // not collapse into a single match that eats the text between them)...
    cleaned = cleaned.replace(new RegExp(`${name}:\\s*\\{[\\s\\S]*?\\}`, 'g'), '');
    // ...then whatever is left on that line: malformed JSON, a truncated
    // payload, or a bare `NAME:` with nothing after it.
    cleaned = cleaned.replace(new RegExp(`^.*${name}:.*$`, 'gm'), '');
  }
  // BARE FLAGS. All four now use the same tolerant pattern. Two of them did
  // not, and MEASURED 2026-08-11 they leaked on any deviation from exactly
  // ":true", lowercase, no space:
  //
  //     "END_CALL:true"            -> clean
  //     "END_CALL: true"           -> SPOKEN
  //     "END_CALL:True"            -> SPOKEN
  //     "EMERGENCY_DETECTED: true" -> SPOKEN
  //
  // NAME_CONFIRMED and TIME_CONFIRMED already allowed \s* and /i; END_CALL and
  // EMERGENCY_DETECTED did not, for no reason anyone recorded. An emergency turn
  // is the worst possible moment to read machine text at a patient, and a model
  // adding one space is not a hypothetical — REQUEST_CALLBACK reached a real
  // caller's ear the same day (see SENTINEL_NAMES above).
  cleaned = cleaned.replace(/END_CALL:\s*true/gi, '')
                    .replace(/EMERGENCY_DETECTED:\s*true/gi, '')
                    .replace(/NAME_CONFIRMED:\s*true/gi, '')
                    .replace(/TIME_CONFIRMED:\s*true/gi, '')
                    .replace(/PATIENT_NAME:.*?$/gm, '')
                    .replace(/PATIENT_REASON:.*?$/gm, '')
                    .replace(/DOCTOR_NAME:.*?$/gm, '');

  const lines = cleaned.split('\n');
  const validLines = lines.filter(line => {
    if (SENTINEL_NAMES.some(n => line.includes(n))) return false;
    if (line.trim().match(/^"?(patientName|reason|dateTime|patient_name|doctorName)"?\s*:/)) return false;
    if (line.trim() === '{' || line.trim() === '}') return false;
    return true;
  });

  return validLines.join('\n').trim();
}

// Devanagari output so the spoken slot-time phrase reads naturally on the
// Hindi TTS voice (romanized Hindi sounded odd). Weekdays + months + period
// words + digits all in Devanagari.
const WEEKDAYS_DEV = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
const MONTHS_DEV = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const DIGITS_DEV = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];

function toDevanagariDigits(n) {
  return String(n).split('').map(c => (c >= '0' && c <= '9') ? DIGITS_DEV[+c] : c).join('');
}

function formatDateHindi(dateTime) {
  const date = new Date(dateTime);
  const istOptions = { timeZone: 'Asia/Kolkata' };
  const istDate = new Date(date.toLocaleString('en-US', istOptions));
  const weekday = WEEKDAYS_DEV[istDate.getDay()];
  const day = toDevanagariDigits(istDate.getDate());
  const month = MONTHS_DEV[istDate.getMonth()];
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const period = hours < 12 ? 'सुबह' : hours < 17 ? 'दोपहर' : 'शाम';
  const hour12 = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
  const hourDev = toDevanagariDigits(hour12);
  const minStr = minutes === 0 ? '' : ` बजकर ${toDevanagariDigits(minutes)} मिनट पर`;
  return `${weekday}, ${day} ${month}, ${period} ${hourDev}${minStr} बजे`;
}

function withTimeout(promise, ms, fallback) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]).catch(err => {
    console.error('withTimeout caught:', err.message);
    return fallback;
  });
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

// Build the LLM message array (system prompt + time + phase hint + history).
// Shared by getResponse (non-streaming) and getResponseStream (streaming) so
// the two paths can never drift on prompt construction.
const PHASE_HINTS = {
  greeting: '[PHASE: Greeting — naam pooch]',
  reason: '[PHASE: Reason — takleef pooch, naam mil chuka]',
  scheduling: '[PHASE: Scheduling — din/time pooch. Patient confirm kare toh BOOK_APPOINTMENT JSON lagana COMPULSORY hai]',
  booked: '[PHASE: Booked — appointment ho chuki. Reschedule ke liye UPDATE_APPOINTMENT. BOOK_APPOINTMENT mat likh]',
  wrapup: '[PHASE: Wrap up — goodbye kar]'
};

function buildMessages(conversationHistory, options = {}) {
  const { appointmentBooked = false, conversationPhase = 'greeting' } = options;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Static SYSTEM_PROMPT stays message 0 (prefix-cacheable); per-turn time is a
  // separate message so it no longer cache-busts the static prefix every turn.
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Abhi: ${now}` },
    ...conversationHistory
  ];
  if (PHASE_HINTS[conversationPhase]) {
    messages.push({ role: 'system', content: PHASE_HINTS[conversationPhase] });
  }
  if (appointmentBooked) {
    messages.push({
      role: 'system',
      content: 'Appointment ALREADY booked. BOOK_APPOINTMENT mat likh. Time change ke liye UPDATE_APPOINTMENT use kar.'
    });
  }
  return messages;
}

async function getResponse(conversationHistory, callerPhone, options = {}) {
  const { appointmentBooked = false, eventId = null } = options;
  try {
    const messages = buildMessages(conversationHistory, options);

    // LLM call goes through the provider abstraction (llm/index.js). Primary
    // is SambaNova by default; failover to Groq is automatic on timeout/5xx/
    // network/post-retry-429. Model selection, headers, timeout, retry, and
    // the response shape are owned by the provider — we only specify what
    // we want (temperature, max tokens, messages).
    const response = await completeWithFailover(messages, {
      temperature: 0.6,
      maxTokens: 200
    });

    const fullText = response.content;
    console.log(`LLM raw response (provider=${response.provider}${response.failover ? ', failover' : ''}):`, fullText);

    const extractedName = extractPatientName(fullText);
    const extractedReason = extractPatientReason(fullText);
    const bookingData = extractBookingIntent(fullText);
    const updateData = extractUpdateIntent(fullText);
    const bookingName = isValidName(bookingData?.patientName) ? bookingData.patientName : null;
    const finalPatientName = bookingName || extractedName || null;
    const finalReason = bookingData?.reason || extractedReason || null;

    if (bookingData && !appointmentBooked) {
      console.log('Booking intent detected:', bookingData);
      const dateTime = new Date(bookingData.dateTime);
      const llmConfirmation = cleanResponse(fullText);

      const available = await withTimeout(checkAvailability(dateTime), 5000, null);

      if (available === null) {
        return {
          text: 'कैलेंडर चेक करने में थोड़ी देर लग रही है। एक बार फिर कोशिश करें?',
          booked: false, appointmentTime: null, patientName: finalPatientName,
          reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'),
          isSlotFailure: false, endCall: false
        };
      }

      if (available) {
        const result = await withTimeout(
          bookAppointment({
            patientName: bookingData.patientName,
            phone: callerPhone || 'Unknown',
            reason: bookingData.reason,
            dateTime
          }),
          6000, { success: false }
        );

        if (result.success) {
          return {
            text: llmConfirmation || `${bookingData.patientName} जी, अपॉइंटमेंट कन्फर्म हो गई है!`,
            booked: true, appointmentTime: dateTime, eventId: result.eventId,
            patientName: finalPatientName, reason: finalReason,
            emergency: fullText.includes('EMERGENCY_DETECTED:true'),
            isSlotFailure: false, endCall: fullText.includes('END_CALL:true')
          };
        } else {
          return {
            text: 'बुकिंग में समस्या आई। कृपया दोबारा कोशिश करें।',
            booked: false, appointmentTime: null, patientName: finalPatientName,
            reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'),
            isSlotFailure: false, endCall: false
          };
        }
      } else {
        const slots = await withTimeout(getNextAvailableSlots(dateTime), 4000, []);
        if (slots.length > 0) {
          const slotStrings = slots.slice(0, 2).map(s => formatDateHindi(s)).join(', ya phir ');
          return {
            text: `यह स्लॉट उपलब्ध नहीं है। ${slotStrings} उपलब्ध है — कौनसा ठीक रहेगा?`,
            booked: false, appointmentTime: null, patientName: finalPatientName,
            reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'),
            isSlotFailure: true, endCall: false
          };
        }
        return {
          text: 'इस समय कोई स्लॉट उपलब्ध नहीं है। कोई और दिन देखें?',
          booked: false, appointmentTime: null, patientName: finalPatientName,
          reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'),
          isSlotFailure: true, endCall: false
        };
      }
    }

    if (updateData && appointmentBooked && eventId) {
      console.log('Update intent detected:', updateData);
      const dateTime = new Date(updateData.dateTime);
      const llmConfirmation = cleanResponse(fullText);

      const available = await withTimeout(checkAvailability(dateTime), 5000, null);

      if (available === null) {
        return { text: 'कैलेंडर चेक करने में थोड़ी देर लग रही है। एक बार फिर कोशिश करें?', booked: true, appointmentTime: null, eventId, patientName: finalPatientName, reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'), isSlotFailure: false, endCall: false, isUpdate: true };
      }

      if (available) {
        const result = await withTimeout(updateAppointment({ eventId, dateTime }), 6000, { success: false });
        if (result.success) {
          return { text: llmConfirmation || 'अपॉइंटमेंट का नया समय कन्फर्म हो गया है!', booked: true, appointmentTime: dateTime, eventId: result.eventId || eventId, patientName: finalPatientName, reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'), isSlotFailure: false, endCall: fullText.includes('END_CALL:true'), isUpdate: true };
        } else {
          return { text: 'अपडेट में समस्या आई। दोबारा कोशिश करें।', booked: true, appointmentTime: null, eventId, patientName: finalPatientName, reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'), isSlotFailure: false, endCall: false, isUpdate: true };
        }
      } else {
        const slots = await withTimeout(getNextAvailableSlots(dateTime), 4000, []);
        if (slots.length > 0) {
          const slotStrings = slots.slice(0, 2).map(s => formatDateHindi(s)).join(', ya phir ');
          return { text: `यह स्लॉट उपलब्ध नहीं है। ${slotStrings} उपलब्ध हैं — कौनसा ठीक रहेगा?`, booked: true, appointmentTime: null, eventId, patientName: finalPatientName, reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'), isSlotFailure: true, endCall: false, isUpdate: true };
        }
        return { text: 'इस समय कोई स्लॉट उपलब्ध नहीं है। कोई और दिन देखें?', booked: true, appointmentTime: null, eventId, patientName: finalPatientName, reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'), isSlotFailure: true, endCall: false, isUpdate: true };
      }
    }

    // Empty cleaned text is now allowed through — callHandler.processIntent
    // detects it and stays silent rather than speaking a generic filler.
    // The bare-sentinel rule in the prompt is the first line of defense.
    return {
      text: cleanResponse(fullText).trim(),
      booked: false, appointmentTime: null, patientName: finalPatientName,
      reason: finalReason, emergency: fullText.includes('EMERGENCY_DETECTED:true'),
      isSlotFailure: false, endCall: fullText.includes('END_CALL:true')
    };

  } catch (error) {
    console.error('Brain error:', error.response?.data || error.message);
    return {
      text: 'मुझे समझ नहीं आया। कृपया दोबारा बोलें।',
      booked: false, appointmentTime: null, patientName: null,
      reason: null, endCall: false
    };
  }
}

module.exports = {
  getResponse,
  SYSTEM_PROMPT,
  // Exported for brain-streaming.js (the LLM→TTS streaming refactor) so both
  // paths share one implementation of prompt-building + sentinel parsing.
  buildMessages,
  cleanResponse,
  extractPatientName,
  extractPatientReason,
  extractBookingIntent,
  extractUpdateIntent,
  isValidFieldValue,
  // The one sentinel list. brain-streaming.js derives its regexes from this
  // rather than keeping its own copies — see the comment above SENTINEL_NAMES
  // for the live call that made the fourth copy unacceptable.
  SENTINEL_NAMES
};
