// ─── LOG REDACTION ───────────────────────────────────────────────────────────
// Patient phone numbers are a direct PII identifier. We keep call logs useful
// for debugging (callSid is the key) but mask phones so they don't sit in
// Railway's managed logs in the clear.
//
// THE HEADER HERE USED TO CLAIM THIS KEPT PHI OUT OF THE LOGS. It did not, and
// the phone number was the least sensitive thing going in. Twenty-four call
// sites were writing raw patient speech to stdout — symptoms, medications,
// allergies, and Ritu's replies with the caller's name in them — while this file
// masked eleven digits and declared the job done. A verified sample:
//
//     Patient said: यार मेरे को ना सर में दर्द हो रहा है
//     Patient said: हाँ वो Metformin की दवाई चल रही है
//
// That is health data in a third-party platform's log stream, retained on their
// schedule, readable by anyone with dashboard access. It is the live exposure
// under IT Act s.43A (negligence in security practices) today, and it is the
// ₹250 crore Schedule item under DPDP from May 2027 — a statute that prices
// security failures FIVE TIMES above consent defects.
//
// THE FIX IS NOT "STOP LOGGING". Every one of those sites logs speech to explain
// a DECISION — why a turn was dropped as echo, held for debounce, or re-asked as
// garble. Delete the text and the logs stop being diagnostic. So speech() keeps
// the properties we actually reason from and discards the words:
//
//     "मुझे सर में दर्द हो रहा है"  →  ‹19c/6w deva›
//     "HDFC Bank share analysis"    →  ‹24c/4w latn›
//     "हाँ वो Metformin की दवाई"    →  ‹22c/5w mixed›
//
// Script is in there deliberately: a Devanagari-vs-Latin switch is the failure
// mode this project spent a week measuring, and it stays visible without a
// single word of the sentence surviving.
//
// FULL TEXT IS STILL AVAILABLE, two ways that are both accountable:
//   · the DATABASE — calls.transcript (JSONB) already holds every turn, behind
//     credentials, in a store we control and can purge on request. That is where
//     transcripts belonged all along, and where the eval flywheel should read
//     them from rather than scraping log exports.
//   · DEBUG_SPEECH=true — opt-in, for a local session. Defaults OFF, so the safe
//     state is the one you get by doing nothing. The old arrangement had that
//     backwards.
'use strict';

// Mask a phone for logs — keep the last 4 digits, redact the rest.
//   "+918273500806" → "••••••0806"
function maskPhone(p) {
  if (!p || typeof p !== 'string') return p || '';
  const d = p.replace(/\D/g, '');
  return d.length < 4 ? '•••' : '••••••' + d.slice(-4);
}

// Read once at load: this is on the hot path of every transcript line, and a
// per-call process.env lookup on a live audio loop is a cost with no upside.
const SHOW_SPEECH = process.env.DEBUG_SPEECH === 'true';

// NOTE THE GAP IN THE DEVANAGARI RANGE. U+0964 and U+0965 are the danda and
// double danda — sentence punctuation SHARED across Indic scripts, which happen
// to be encoded in the Devanagari block. A naive [ऀ-ॿ] test therefore reports
// Punjabi as Devanagari, because "ਸਰ ਦੂਰ ਹੈ।" ends in one. This project has
// already withdrawn a finding once for exactly that reason — a log search for
// Devanagari and Latin missed a live Punjabi call entirely — so the script
// tests below match LETTERS only.
const SCRIPTS = [
  ['deva', /[ऀ-ॣ०-ॿ]/],  // Devanagari, minus the shared danda
  ['guru', /[਀-੿]/],               // Gurmukhi — Punjabi
  ['beng', /[ঀ-৿]/],
  ['gujr', /[઀-૿]/],
  ['orya', /[଀-୿]/],
  ['taml', /[஀-௿]/],
  ['telu', /[ఀ-౿]/],
  ['knda', /[ಀ-೿]/],
  ['mlym', /[ഀ-ൿ]/],
];
const LATIN = /[A-Za-z]/;

/**
 * Which script(s) the utterance is in — the one property worth keeping, and the
 * one this project spent a week measuring. Named per script rather than a flat
 * "indic": knowing a turn came back Gurmukhi instead of Devanagari is exactly
 * the signal that is useful, and collapsing them throws it away.
 */
function _script(s) {
  const found = [];
  for (const [name, re] of SCRIPTS) if (re.test(s)) found.push(name);
  const latin = LATIN.test(s);
  if (found.length && latin) return found.join('+') + '+latn';
  if (found.length) return found.join('+');
  if (latin) return 'latn';
  return 'other';
}

/**
 * Speech for logs. Returns a non-reversible descriptor unless DEBUG_SPEECH=true.
 *
 * Callers interpolate this WITHOUT surrounding quotes — the ‹› brackets mark it
 * as a descriptor so a redacted line never reads like a real transcript, which
 * would be its own kind of lie in an incident review.
 */
function speech(s) {
  if (s === null || s === undefined) return '‹none›';
  const t = String(s);
  if (SHOW_SPEECH) return JSON.stringify(t);
  if (!t.trim()) return '‹empty›';
  // Word count on whitespace: good enough for every filter that reasons about
  // token counts, and it never needs to be exact.
  const words = t.trim().split(/\s+/).length;
  return `‹${t.length}c/${words}w ${_script(t)}›`;
}

module.exports = { maskPhone, speech, SPEECH_VISIBLE: SHOW_SPEECH };
