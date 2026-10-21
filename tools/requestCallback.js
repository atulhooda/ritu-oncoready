// ═══════════════════════════════════════════════════════════════════════════
// tools/requestCallback.js
//
// Records a callback request for an on-call specialist. Used by Ritu when
// find_doctor returns a doctor with is_on_call=true — booking is not
// possible for those specialists, but the clinic staff calls the patient
// back within the ETA window.
//
// Specialty is validated against the on-call doctors registered for this
// clinic so the LLM can't invent an unsupported specialty
// ("Dermatologist" if the clinic has no dermatology on-call).
//
// Dedup: a pending callback for the same phone + specialty created within
// the last CALLBACK_DEDUP_WINDOW_HOURS hours is returned instead of inserting
// a duplicate row. Prevents the receptionist from seeing the same request
// three times when a patient calls back to check status.
//
// Context: { pool, clinicId, patientPhone, currentDatetime (optional) }
// ═══════════════════════════════════════════════════════════════════════════

const { normalizePhone } = require('./utils/phoneNormalizer');

const CALLBACK_DEDUP_WINDOW_HOURS = 2;
const ETA_TEXT = '2-4 ghante mein callback karenge';

// Specialty alias map. The seed clinic stores canonical specialty names
// (Neurologist, Urology, Pediatric, etc.) but patients/LLMs say them in
// many forms ("Neurology", "Pediatrician", "Anaesthesia"). Used to match
// LLM input against the on-call doctor roster. Each row's first entry is
// the canonical stored value; subsequent entries are accepted variants.
//
// Prefix matching ALONE doesn't cover this — "neurology" and "neurologist"
// share 8 common chars but neither is a prefix of the other (they diverge
// at char 9: 'y' vs 'i'). Explicit aliases are clearer than a fuzzy matcher.
const ON_CALL_SPECIALTY_ALIASES = {
  Neurology:   ['neurology', 'neurologist'],
  Nephrology:  ['nephrology', 'nephrologist'],
  Urology:     ['urology', 'urologist'],
  Pediatric:   ['pediatric', 'pediatrics', 'pediatrician', 'paediatric', 'paediatrician'],
  Anesthesia:  ['anesthesia', 'anaesthesia', 'anesthetist', 'anaesthetist', 'anesthesiologist', 'anaesthesiologist'],
  Surgery:     ['surgery', 'surgeon', 'surgical']
};

// Build a reverse lookup: lowercased-alias → canonical. Used at match time.
const ALIAS_TO_CANONICAL = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(ON_CALL_SPECIALTY_ALIASES)) {
    for (const a of aliases) m.set(a, canonical);
    m.set(canonical.toLowerCase(), canonical);
  }
  return m;
})();

function canonicalSpecialty(input) {
  if (!input) return null;
  return ALIAS_TO_CANONICAL.get(input.toLowerCase().trim()) || null;
}

const schema = {
  type: 'function',
  function: {
    name: 'request_callback',
    description: 'Create a callback request for an on-call specialist (Neurologist, Nephrologist, Urologist, Pediatrician, Anesthetist, Surgeon — whichever the clinic has on its on-call roster). Use when find_doctor returns is_on_call=true. Patient is told the clinic will call back within 2-4 hours.',
    parameters: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: "Patient's full name" },
        specialty:    { type: 'string', description: 'Specialty needed (e.g. Neurology, Nephrology, Urology, Pediatric, Anesthesia, Surgery). Must match an on-call doctor at this clinic.' },
        reason:       { type: 'string', description: 'Brief reason for callback' }
      },
      required: ['patient_name', 'specialty', 'reason']
    }
  }
};

async function execute({ patient_name, specialty, reason }, context) {
  if (!context || !context.pool)  throw new Error('request_callback: context.pool required');
  if (!context.clinicId)          throw new Error('request_callback: context.clinicId required');
  if (!context.patientPhone)      throw new Error('request_callback: context.patientPhone required');

  // ─── Input validation ────────────────────────────────────────────────
  if (!patient_name || !patient_name.trim()) {
    return { success: false, error_message: 'patient_name is required and cannot be empty.' };
  }
  if (!specialty || !specialty.trim()) {
    return { success: false, error_message: 'specialty is required and cannot be empty.' };
  }

  const phone = normalizePhone(context.patientPhone);
  if (!phone) {
    return { success: false, error_message: `Invalid patient phone: "${context.patientPhone}".` };
  }

  const { pool, clinicId } = context;
  const now = context.currentDatetime ? new Date(context.currentDatetime) : new Date();

  // ─── Specialty must match an on-call doctor at this clinic ────────────
  // Canonicalize the LLM input using the alias map ("Neurology" /
  // "Neurologist" both → "Neurology"; "Pediatrician" → "Pediatric"; etc.).
  // Then check if any on-call doctor's stored specialty also canonicalizes
  // to the same value. Explicit aliases are clearer than fuzzy matching
  // and avoid the substring-/prefix-falsity bugs we hit earlier.
  // ─── THE ROSTER DECIDES WHAT IS ON-CALL, NOT THIS FILE ──────────────────
  // ON_CALL_SPECIALTY_ALIASES above lists SIX specialties. It used to be the
  // gate: an input that did not canonicalize was rejected before the roster was
  // ever read. LIVE CALL a386bf9938438087ab12a072fb331a8c, 2026-08-12 06:52 IST:
  //
  //   patient  मला कॅन्सर स्पेशालिस्टला भेटायाचे आहे
  //   Ritu     ...डॉ. रेखा सरदेसाई (ऑनकोलॉजिस्ट) आहेत... कॉलबॅक लावून देऊ का?
  //   Ritu     Specialty "Oncologist" is not recognized as an on-call specialty.
  //   patient  हो लावा।
  //   Ritu     Specialty "Oncologist" is not recognized as an on-call specialty.
  //
  // Dr. Rekha Sardesai is a real, active, on-call Oncologist in this clinic —
  // the ONLY on-call doctor it has. The prompt offered her correctly. This map
  // had simply never heard of oncology, so a hand-written list of six overruled
  // the database, and the caller hung up.
  //
  // Same shape as the four sentinel lists that spoke REQUEST_CALLBACK at a
  // patient the day before: a constant that must agree with reality, kept by
  // hand, silently drifting. The roster is the reality. Aliases now only help
  // MATCH variants ("neurology"/"neurologist"), and never decide what exists.
  const { rows: onCallDoctors } = await pool.query(
    `SELECT id, name, specialty FROM doctors
      WHERE clinic_id = $1 AND active = TRUE AND is_on_call = TRUE`,
    [clinicId]
  );
  if (!onCallDoctors.length) {
    return { success: false, error_message: `This clinic has no on-call doctors.` };
  }
  const canonicalInput = canonicalSpecialty(specialty);
  const want = String(specialty || '').toLowerCase().trim();
  const matched =
    // 1. both sides canonicalize to the same known alias group
    (canonicalInput && onCallDoctors.find((d) => canonicalSpecialty(d.specialty) === canonicalInput)) ||
    // 2. the stored specialty matches literally, case-insensitively
    onCallDoctors.find((d) => String(d.specialty || '').toLowerCase().trim() === want) ||
    // 3. the SHARED STEM. "-ology" and "-ologist" name the same thing and
    //    diverge late: oncology/oncologist part at char 8, neurology/neurologist
    //    at char 9 (this file's own header notes the second and then gated on a
    //    fixed list anyway). A fixed-width compare is therefore wrong at any
    //    width — the longest common prefix is the actual signal.
    //
    //    SIX is the bar, measured against the pairs that must and must not match:
    //      oncology / oncologist ..... 7 shared  -> match
    //      cardiology / cardiologist . 9 shared  -> match
    //      gynecology / gynecologist . 9 shared  -> match
    //      neurology / neurosurgery .. 5 shared  -> NO, correctly
    //      surgery / surgeon ......... 5 shared  -> NO (the alias map covers it)
    //      dermatologist / oncologist. 0 shared  -> NO
    //
    //    Only ever compared ACROSS THE ON-CALL ROSTER — a handful of rows, not
    //    the whole doctor table — so a loose match cannot reach a doctor who is
    //    not on call in the first place.
    onCallDoctors.find((d) => {
      const have = String(d.specialty || '').toLowerCase().replace(/[^a-z]/g, '');
      const w = want.replace(/[^a-z]/g, '');
      if (have.length < 6 || w.length < 6) return false;
      let i = 0;
      while (i < have.length && i < w.length && have[i] === w[i]) i++;
      return i >= 6;
    });
  if (!matched) {
    return {
      success: false,
      error_message: `No on-call doctor at this clinic matches specialty "${specialty}". ` +
        `On call: ${onCallDoctors.map((d) => d.specialty).join(', ')}.`
    };
  }
  const matchedSpecialty = matched.specialty;

  // ─── Dedup: same patient+specialty pending within window? ─────────────
  const cutoff = new Date(now.getTime() - CALLBACK_DEDUP_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { rows: dupes } = await pool.query(
    `SELECT id, patient_name, specialty, created_at FROM callbacks
      WHERE clinic_id = $1 AND patient_phone = $2 AND status = 'pending'
        AND LOWER(specialty) = LOWER($3)
        AND created_at > $4
      ORDER BY created_at DESC
      LIMIT 1`,
    [clinicId, phone, matchedSpecialty, cutoff]
  );
  if (dupes.length > 0) {
    return {
      success: true,
      callback_id: dupes[0].id,
      idempotent: true,
      eta_text: ETA_TEXT,
      specialty: matchedSpecialty,
      confirmation_text: `Aapka callback request pehle se record kar diya hai. ${ETA_TEXT}.`
    };
  }

  // ─── Insert ───────────────────────────────────────────────────────────
  // created_at is set explicitly to `now` so tests pinning currentDatetime
  // get deterministic dedup-window behavior. In production currentDatetime
  // is unset → `now = new Date()` → same as DEFAULT NOW().
  const { rows: [cb] } = await pool.query(
    `INSERT INTO callbacks (clinic_id, patient_name, patient_phone, specialty, reason, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id, created_at`,
    [clinicId, patient_name.trim(), phone, matchedSpecialty, reason || null, now.toISOString()]
  );

  // Staff phones get a WhatsApp too (clinics.staff_alert_phones, module 2b).
  // Never costs the callback: the row above is already committed.
  try {
    await require('../db').queueStaffAlert({ clinicId, callbackId: cb.id, patientName: patient_name.trim(), phone, reason: reason || matchedSpecialty }, pool);
  } catch (_) { /* queued nothing */ }

  return {
    success: true,
    callback_id: cb.id,
    eta_text: ETA_TEXT,
    specialty: matchedSpecialty,
    confirmation_text: `Hum ${matchedSpecialty} doctor se ${ETA_TEXT}.`
  };
}

module.exports = { schema, execute, CALLBACK_DEDUP_WINDOW_HOURS, ETA_TEXT };
