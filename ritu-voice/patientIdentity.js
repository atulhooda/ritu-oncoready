// ═══════════════════════════════════════════════════════════════════════════
// WHO IS THIS CALLER — one implementation, used by everybody
//
// There were THREE, and they disagreed:
//
//   db.js upsertPatient ............ phoneVariants + case-folded name reuse +
//                                    placeholder rename        (fixed 21e6cc1)
//   tools/bookAppointment.js:134 ... EXACT phone string, EXACT name, else INSERT
//   db/seed-sample-patients.js ..... its own again
//
// Only the first had any of the identity fixes. bookAppointment — the path that
// actually runs during a booking — had none of them, which is why they did not
// help.
//
// THE COST, live call 5b261b844e65a68bbe1aeb5512a11a8e, 2026-08-14, Bengali.
// One human, one handset (9749563568), three rows in 2m19s:
//
//     07:58:15  3402e8d6  "Aman Nambaria"
//     07:59:00  6d7fdcba  "আমন নাম্বারিয়া"      <- the same name, Bengali script
//     08:00:34  be74f240  "[Patient Name]"     <- the prompt's own placeholder
//
// The appointment committed against the first. When the caller asked to confirm
// it, bookAppointment's idempotency check ran against a DRIFTED patient_id,
// found nothing, and the insert collided with uniq_doctor_slot — the slot was
// held BY HIM. The tool returned failure, and brain-lean.js:889 spoke
// cannedLine('slotNoAlt'): "that time is not available".
//
// MEASURED across all rows, 2026-08-14:
//     handsets with >1 patient row .............. 10 of 28
//     rows minted <10min apart on one handset ... 16
//     placeholders that became patients ......... 15
//
// Same root cause as the household medication prior (79f2677), the wrong-name
// greeting (21e6cc1) and cancel ambiguity (556b9b4). Four bugs, one cause.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { cleanPersonName } = require('./nameGuard');
const { hasIndic, toDevanagari, romanize } = require('./devanagari');
const { phoneVariants } = require('./tools/utils/phoneNormalizer');

const fold = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ─── A READABLE FORM, ALONGSIDE THE REAL ONE ────────────────────────────────
// The desk lists callers by name, and on 2026-08-15 that list stacked Kannada,
// Bengali and Latin on top of each other — unreadable to staff who do not read
// all three. `name` keeps exactly what the caller said; this is a reading aid
// stored beside it, never a replacement. The doctor may need the original.
//
// Null for Latin names (they romanize to themselves, so a copy adds nothing)
// and null when romanization yields nothing usable — the desk renders
// `name_latin ?? name`, so absent degrades to today's behaviour rather than to
// a blank row. A guess would be worse than a gap: this is somebody's name.
function latinFormOf(name) {
  const n = cleanPersonName(name);
  if (!n || !hasIndic(n)) return null;
  const r = romanize(toDevanagari(n)).trim();
  if (!r || !/[a-z]{2,}/i.test(r)) return null;
  // Title case — a name in a list, not a token in a matcher.
  return r.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Which writing system a name is in. Used ONLY to decide whether two names on
// ONE handset are the same person re-transcribed, never to judge a name.
//
// WHY SCRIPT AND NOT SIMILARITY. Transliterating across eleven scripts is a
// research problem; deciding whether two strings are in the SAME script is not.
// And the distinction happens to be exactly the one that matters here:
//
//   "Aman Nambaria" -> "আমন নাম্বারিয়া"   different script, one caller  -> SAME
//   "Siddharth"     -> "सिद्धार्थ"          different script, one caller  -> SAME
//   "Aman Nambaria" -> "Priya Sharma"     SAME script, one handset      -> two people
//
// A household shares a handset and its members' names arrive in the same script
// as each other; a re-transcription of one name arrives in a different one.
// That is a real signal, not a convenience.
function scriptOf(name) {
  const s = String(name || '');
  if (/[ঀ-৿]/.test(s)) return 'beng';
  if (/[ऀ-ॿ]/.test(s)) return 'deva';
  if (/[ಀ-೿]/.test(s)) return 'knda';
  if (/[਀-੿]/.test(s)) return 'guru';
  if (/[஀-௿]/.test(s)) return 'taml';
  if (/[ఀ-౿]/.test(s)) return 'telu';
  if (/[઀-૿]/.test(s)) return 'gujr';
  if (/[ഀ-ൿ]/.test(s)) return 'mlym';
  if (/[଀-୿]/.test(s)) return 'orya';
  if (/[A-Za-z]/.test(s)) return 'latn';
  return 'other';
}

/**
 * Resolve the caller to exactly one patient row, creating it only when this
 * handset has no plausible match.
 *
 * @param {object} pool           a pg Pool (or anything with .query)
 * @param {string} clinicId
 * @param {string} rawPhone       whatever the carrier sent
 * @param {string|null} rawName   whatever was heard, may be junk or absent
 * @returns {Promise<{id: string, name: string}|null>}
 */
async function resolvePatient(pool, clinicId, rawPhone, rawName) {
  if (!clinicId || !rawPhone) return null;

  const variants = phoneVariants(rawPhone);
  if (!variants.length) return null;
  const canonicalPhone = variants[0];
  const name = cleanPersonName(rawName);   // null for junk, placeholders, absent

  const { rows: onHandset } = await pool.query(
    `SELECT id, name, created_at FROM patients
      WHERE clinic_id = $1 AND phone = ANY($2)
      ORDER BY created_at DESC`,
    [clinicId, variants]
  );

  const real = onHandset.filter((r) => cleanPersonName(r.name));
  const placeholders = onHandset.filter((r) => !cleanPersonName(r.name));

  // ── nothing usable was heard ──────────────────────────────────────────────
  // Reuse whoever is on this handset rather than minting another "Unknown".
  // Fifteen placeholder rows exist because this path used to insert.
  if (!name) {
    if (real.length === 1) return { id: real[0].id, name: real[0].name };
    if (real.length > 1) return null;    // a household and no name — caller decides
    if (placeholders.length) return { id: placeholders[0].id, name: placeholders[0].name };
    const { rows: [p] } = await pool.query(
      `INSERT INTO patients (clinic_id, phone, name) VALUES ($1, $2, 'Unknown')
       ON CONFLICT (clinic_id, phone, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [clinicId, canonicalPhone]
    );
    return p;
  }

  // ── the same name we already hold ─────────────────────────────────────────
  const exact = onHandset.find((r) => fold(r.name) === fold(name));
  if (exact) return { id: exact.id, name: exact.name };

  // ── the same person, re-transcribed into another script ───────────────────
  // Only when this handset holds exactly ONE real name: with two or more we are
  // looking at a household and cannot tell which member is speaking, and the
  // safe answer there is a new row, not a guess that overwrites somebody.
  if (real.length === 1 && scriptOf(real[0].name) !== scriptOf(name)) {
    const { rows: [p] } = await pool.query(
      `UPDATE patients SET name = $2, name_latin = $3 WHERE id = $1 RETURNING id, name`,
      [real[0].id, name, latinFormOf(name)]
    );
    if (p) return p;
  }

  // ── a real name arriving on a handset that only had a placeholder ─────────
  if (placeholders.length && !real.length) {
    const { rows: [p] } = await pool.query(
      `UPDATE patients SET name = $2, name_latin = $3 WHERE id = $1 RETURNING id, name`,
      [placeholders[0].id, name, latinFormOf(name)]
    );
    if (p) return p;
  }

  // ── genuinely new: a different person on a shared handset ─────────────────
  const { rows: [p] } = await pool.query(
    `INSERT INTO patients (clinic_id, phone, name, name_latin) VALUES ($1, $2, $3, $4)
     ON CONFLICT (clinic_id, phone, name)
       DO UPDATE SET name = EXCLUDED.name, name_latin = EXCLUDED.name_latin
     RETURNING id, name`,
    [clinicId, canonicalPhone, name, latinFormOf(name)]
  );
  return p;
}

module.exports = { resolvePatient, scriptOf, latinFormOf, _fold: fold };
