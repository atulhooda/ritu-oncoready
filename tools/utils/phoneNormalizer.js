// ═══════════════════════════════════════════════════════════════════════════
// Phone normalization — single source of truth for all tools + db.js.
//
// Patient might call from any of these formats; they all refer to the same
// person and must hash to the same patient row:
//   "9876543210"
//   "98765 43210"        (spaces)
//   "98765-43210"        (dashes)
//   "(987) 654-3210"     (Western punctuation)
//   "09876543210"        (leading zero)
//   "919876543210"       (country code, no plus)
//   "+919876543210"      (E.164)
//   "+91 98765 43210"    (E.164 with spaces)
//
// Canonical form is the 10-digit Indian mobile number ("9876543210") — what
// gets stored in patients.phone, patients.phone_e164 isn't a column we have.
// At the WhatsApp boundary (whatsapp.js) we re-prepend "91" when needed.
//
// Why 10-digit canonical and not E.164:
//   - Sai Shradha is single-country (India). No country-code disambiguation.
//   - Saves 3 chars per row.
//   - Matches how receptionists actually read patient numbers out loud
//     (they'll say "98765 43210", not "plus 91 98765 43210").
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a raw phone string to a 10-digit Indian mobile.
 *
 * Returns null when the input clearly isn't a valid Indian mobile —
 * caller decides whether to error, default, or skip the lookup.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // Strip every non-digit. This collapses "+", " ", "-", "(", ")" in one go.
  let digits = str.replace(/\D+/g, '');
  if (!digits) return null;

  // Trim leading country code or leading zero.
  // Order matters: "+91" already lost the "+", so we look at "91" prefix
  // on a 12-digit string.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.substring(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.substring(1);

  // What remains must be 10 digits and start with a valid Indian mobile
  // prefix (6, 7, 8, 9). Reject obviously bad input.
  if (digits.length !== 10) return null;
  if (!/^[6-9]/.test(digits)) return null;

  return digits;
}

/**
 * Best-effort normalize: returns the original string when normalization
 * fails so callers that don't want to bounce invalid input can still log
 * what came in. Useful for callbacks where we want to record whatever the
 * STT picked up even if it's malformed.
 */
function normalizePhoneSoft(raw) {
  return normalizePhone(raw) || (raw === null || raw === undefined ? null : String(raw));
}

/**
 * Convert a normalized 10-digit number back to E.164 (+91XXXXXXXXXX).
 * Use at the WhatsApp boundary where Meta's API requires E.164.
 */
function toE164(normalized) {
  if (!normalized || !/^[6-9]\d{9}$/.test(normalized)) return null;
  return `+91${normalized}`;
}

/**
 * Every stored form a handset may already be sitting under, for lookups.
 *
 * WHY THIS EXISTS. Line 3 of this file has claimed since it was written that it
 * is the "single source of truth for all tools + db.js" — and db.js never
 * imported it. The tools normalized; db.js compared `phone = $2` against
 * whatever string the carrier happened to send. MEASURED on production
 * 2026-08-11, scoped per clinic the way db.js actually queries:
 *
 *     Smile Dental ....... 30 phone strings ->  22 real handsets   (8 split)
 *     Sai Shradha ........  5 phone strings ->   3 real handsets   (2 split)
 *
 * One handset held all three of "9945450845", "919945450845" and
 * "+919945450845". Whether a patient was recognised came down to how Exotel
 * formatted the number that day. A miss is silent and costs, in order:
 * the medication prior (accuracy), the returning-caller greeting, and the
 * appointment lookup — "मुझे कोई appointment नहीं दिख रहा" to somebody holding
 * a confirmation.
 *
 * A backfill was the other option and was NOT taken: nine tables carry an FK to
 * patients.id and five rows would collide under UNIQUE (clinic_id, phone, name),
 * so merging means repointing children and picking survivors. Matching on the
 * variant set heals the same misses with no rows moved, and `= ANY($2)` still
 * uses the index — it is an equality against a short list, not a scan.
 *
 * Writes go out canonical (10-digit) so the fragmentation stops growing; reads
 * accept every legacy form so the rows already in the table stay reachable.
 */
function phoneVariants(raw) {
  const n = normalizePhone(raw);
  // Un-normalizable input (a landline, a garbled STT capture) can still match
  // itself — returning [] here would turn "no valid mobile" into "match every
  // row", which is how a lookup guard becomes a data leak.
  if (!n) {
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    return s ? [s] : [];
  }
  return [n, `91${n}`, `+91${n}`, `0${n}`, `+${n}`];
}

module.exports = { normalizePhone, normalizePhoneSoft, toE164, phoneVariants };
