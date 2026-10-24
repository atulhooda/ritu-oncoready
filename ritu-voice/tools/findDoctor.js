// ═══════════════════════════════════════════════════════════════════════════
// tools/findDoctor.js
//
// Match the patient's request to a doctor — by symptom (mapped through
// symptomMapping), by explicit specialty, or by doctor name. For each
// matched doctor returns availability for today (computed from
// doctor_schedules + doctor_exceptions) and the next available day if
// today doesn't work.
//
// Context required by execute():
//   { pool, clinicId, currentDatetime (optional, defaults to now) }
//
// Returns: { doctors: [{ id, name, specialty, fee_inr, is_on_call,
//   today_available, today_hours, walk_in, notes,
//   next_available_day: { date, day_name, hours, suggested_time } | null }] }
// ═══════════════════════════════════════════════════════════════════════════

const { specialtiesForSymptom } = require('./symptomMapping');
const config = require('../config');

const schema = {
  type: 'function',
  function: {
    name: 'find_doctor',
    description: 'Find the appropriate doctor based on patient symptoms, specialty, or doctor name. Returns doctor info including availability for today and upcoming days. Use this whenever the patient mentions a symptom, asks for a specialty, or names a doctor.',
    parameters: {
      type: 'object',
      properties: {
        symptom: {
          type: 'string',
          description: "Patient symptom in any language (e.g. 'ghutne ka dard', 'fever', 'pregnancy')"
        },
        specialty: {
          type: 'string',
          description: "Specialty if patient explicitly named one (e.g. 'ortho', 'gynec', 'orthopedic doctor')"
        },
        doctor_name: {
          type: 'string',
          description: "Doctor name if patient explicitly named one (e.g. 'Dr. Bhosale', 'Bhosale madam')"
        }
      }
    }
  }
};

// How many days ahead to scan for next_available_day before giving up.
const NEXT_AVAILABLE_HORIZON_DAYS = 14;

// Returns day-of-week (0=Sun..6=Sat) for a given Date in the clinic's TZ.
function dayOfWeekInTz(date, timezone) {
  // toLocaleString in en-US with weekday: 'long' gives "Monday", "Tuesday" etc.
  const weekday = date.toLocaleString('en-US', { timeZone: timezone, weekday: 'long' });
  return { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }[weekday];
}

// Returns YYYY-MM-DD in clinic TZ for a Date.
function isoDateInTz(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Format a TIME column value (which pg returns either as 'HH:MM:SS' string
// or as a Date depending on parsers) into a clean 'HH:MM' string.
function formatTime(t) {
  if (!t) return null;
  if (t instanceof Date) {
    return t.toISOString().substring(11, 16);
  }
  // String 'HH:MM:SS' or 'HH:MM'
  return String(t).substring(0, 5);
}

// Minutes since midnight for `date`, evaluated in `timezone` (00:00–23:59).
function timeOfDayMinutesInTz(date, timezone) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date); // "HH:MM"
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// 'HH:MM:SS' | 'HH:MM' → minutes since midnight.
function hhmmToMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// Where a bookable window ends is defined ONCE, in tools/utils/offerWindow.js,
// because db.js's lean roster has to agree with it exactly. See that file for
// the call this cost us.
const { offerableEnd, offerableRange } = require('./utils/offerWindow');

// Words the patient adds to a doctor's name or specialty that aren't part
// of the canonical stored value. Stripped before matching so "Dr. Bhosale",
// "Bhosale madam", "Priyanka Bhosale" all hit the same row.
const HONORIFICS = new Set([
  'dr', 'doctor', 'doc',
  'sir', 'madam', 'sahab', 'sahib',
  'ji', 'mam', "ma'am",
  'the', 'a', 'an'
]);
// Generic modifiers patients add to specialty terms ("orthopedic doctor",
// "skin specialist"). Stripped so the surviving token matches the stored
// specialty column directly.
const SPECIALTY_NOISE = new Set([
  'doctor', 'specialist', 'consultant', 'wala', 'wale', 'wali',
  'sahab', 'sahib', 'ji', 'sir', 'madam',
  'the', 'a', 'an'
]);

// Approximate Devanagari → Latin transliteration for doctor-name matching.
// Doctors are stored in Latin ("Dr. Priyanka Bhosale"); if the LLM passes the
// patient's Devanagari name ("प्रियंका") it won't match. We transliterate to a
// Latin approximation good enough for substring matching against stored names.
// Tuned toward common Indian-name romanization (single vowels: ा→a, ी→i).
const DEVA_CONS = {
  'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
  'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
  'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v',
  'श':'sh','ष':'sh','स':'s','ह':'h','ळ':'l','क़':'q','ख़':'kh','ग़':'g','ज़':'z','फ़':'f','ड़':'r','ढ़':'rh'
};
const DEVA_VOWEL = { 'अ':'a','आ':'a','इ':'i','ई':'i','उ':'u','ऊ':'u','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऋ':'ri' };
const DEVA_MATRA = { 'ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','े':'e','ै':'ai','ो':'o','ौ':'au','ृ':'ri','ॉ':'o','ॅ':'e' };
const DEVA_NASAL = { 'ं':'n','ँ':'n','ः':'h' };
const DEVA_HALANT = '्';

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function transliterateDevanagari(str) {
  const chars = [...String(str || '')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (DEVA_CONS[c]) {
      out += DEVA_CONS[c];
      const next = chars[i + 1];
      if (next === DEVA_HALANT) { i++; }              // suppress inherent 'a'
      else if (next && DEVA_MATRA[next]) { out += DEVA_MATRA[next]; i++; }
      else {
        // Inherent 'a' — but apply schwa deletion at a word boundary
        // (Hindi: निकम = "nikam", not "nikama").
        const wordFinal = !next || /\s/.test(next) || !/[ऀ-ॿ]/.test(next);
        if (!wordFinal) out += 'a';
      }
    } else if (DEVA_VOWEL[c]) { out += DEVA_VOWEL[c]; }
    else if (DEVA_NASAL[c])   { out += DEVA_NASAL[c]; }
    else if (DEVA_MATRA[c])   { out += DEVA_MATRA[c]; } // stray matra
    else if (c === DEVA_HALANT) { /* skip */ }
    else { out += c; }                                // pass through Latin/space
  }
  return out;
}

function tokenize(input, noiseSet) {
  return String(input || '')
    .toLowerCase()
    // Keep ASCII letters + Devanagari + whitespace; everything else → space.
    .replace(/[^a-zऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 0 && !noiseSet.has(t));
}

// Normalize a specialty to a comparison key so patient phrasing matches the
// stored value across the common variants:
//   "neurologist" ⇄ "Neurology", "gynecologist" ⇄ "Gynecology", etc.
// Substring matching can't bridge -ology/-ologist (they diverge at the tail),
// so we fold "-ologist" → "-ology" and drop a trailing plural 's'.
function specialtyKey(s) {
  if (!s) return '';
  let k = String(s).toLowerCase().trim();
  k = k.replace(/ologists?\b/, 'ology'); // neurologist(s) → neurology
  k = k.replace(/s\b/, '');              // pediatrics → pediatric
  return k;
}

// Get all candidate doctors based on input. Returns rows from doctors table
// joined with nothing yet — availability is computed in a second step.
async function selectCandidates({ pool, clinicId, doctorName, specialty, symptomSpecialties }) {
  // Precedence: explicit doctor_name beats specialty beats symptom.
  if (doctorName) {
    let tokens = tokenize(doctorName, HONORIFICS);
    // If the name came in Devanagari, also try a Latin transliteration so it
    // matches the Latin-stored doctor names ("प्रियंका" → "priyanka").
    if (/[ऀ-ॿ]/.test(doctorName)) {
      tokens = [...new Set(tokens.concat(tokenize(transliterateDevanagari(doctorName), HONORIFICS)))];
    }
    if (tokens.length > 0) {
      // Match if any patient-supplied token appears as a substring of the
      // doctor's name. Catches "Dr. Bhosale", "Bhosale", "Priyanka Bhosale",
      // "Bhosale madam", etc.
      const orClauses = tokens.map((_, i) => `LOWER(name) LIKE $${i + 2}`).join(' OR ');
      const params = [clinicId, ...tokens.map(t => `%${t}%`)];
      const { rows } = await pool.query(
        `SELECT id, name, specialty, fee_inr, is_on_call, notes
         FROM doctors
         WHERE clinic_id = $1 AND active = TRUE AND (${orClauses})
         ORDER BY name`,
        params
      );
      if (rows.length > 0) return rows;

      // Fuzzy fallback: transliteration is approximate and conventional Latin
      // spellings diverge ("पटवर्धन" → "patavardhan" vs stored "Patwardhan").
      // Edit-distance match each query token against each stored name token.
      const { rows: all } = await pool.query(
        `SELECT id, name, specialty, fee_inr, is_on_call, notes
         FROM doctors WHERE clinic_id = $1 AND active = TRUE`,
        [clinicId]
      );
      const scored = all
        .map(d => {
          const nameToks = String(d.name).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
          let best = 0;
          for (const qt of tokens) for (const nt of nameToks) {
            if (qt.length < 3) continue;
            const sim = 1 - levenshtein(qt, nt) / Math.max(qt.length, nt.length);
            if (sim > best) best = sim;
          }
          return { d, best };
        })
        .filter(x => x.best >= 0.7)         // ~1 typo on a short surname
        .sort((a, b) => b.best - a.best);
      if (scored.length > 0) return [scored[0].d];
    }
    // Fall through to specialty/symptom if name didn't match.
  }

  if (specialty) {
    const tokens = tokenize(specialty, SPECIALTY_NOISE);
    if (tokens.length > 0) {
      // PRECISE first: normalized-key EXACT match (neurologist→neurology too).
      // This must run BEFORE the loose substring matcher below, otherwise a
      // full word like "neurology" loosely matches "Urology" (it contains the
      // substring "urology") and returns the wrong specialist.
      const keys = new Set(tokens.map(specialtyKey).filter(Boolean));
      if (keys.size > 0) {
        const { rows: all } = await pool.query(
          `SELECT id, name, specialty, fee_inr, is_on_call, notes
           FROM doctors WHERE clinic_id = $1 AND active = TRUE
           ORDER BY is_on_call ASC, name`,
          [clinicId]
        );
        const matched = all.filter(d => keys.has(specialtyKey(d.specialty)));
        if (matched.length > 0) return matched;
      }

      // Fallback: bidirectional substring for abbreviations/phrases the exact
      // key can't bridge — "ortho" → "Orthopedic" (user-in-stored) and
      // "orthopedic doctor" → "Orthopedic" (stored-in-user after noise removal).
      const clauses = tokens.flatMap((_, i) => [
        `LOWER(specialty) LIKE $${i + 2}`,
        `$${i + 2} LIKE '%' || LOWER(specialty) || '%'`
      ]);
      const params = [clinicId, ...tokens.map(t => `%${t}%`)];
      const { rows } = await pool.query(
        `SELECT id, name, specialty, fee_inr, is_on_call, notes
         FROM doctors
         WHERE clinic_id = $1 AND active = TRUE AND (${clauses.join(' OR ')})
         ORDER BY is_on_call ASC, name`,
        params
      );
      if (rows.length > 0) return rows;

      // Last resort: treat the specialty phrase as a symptom. Catches
      // colloquial requests the LLM passes as `specialty` — "ladies doctor"
      // → Gynecology, "bone doctor" → Orthopedic, "skin" → (no match) etc.
      const viaSymptom = specialtiesForSymptom(specialty);
      if (viaSymptom.length > 0) {
        const lowered = viaSymptom.map(s => s.toLowerCase());
        const { rows } = await pool.query(
          `SELECT id, name, specialty, fee_inr, is_on_call, notes
           FROM doctors WHERE clinic_id = $1 AND active = TRUE AND LOWER(specialty) = ANY($2::text[])
           ORDER BY is_on_call ASC, name`,
          [clinicId, lowered]
        );
        if (rows.length > 0) return rows;
      }
    }
  }

  if (symptomSpecialties && symptomSpecialties.length > 0) {
    // Use ANY() with case-insensitive comparison.
    const lowered = symptomSpecialties.map(s => s.toLowerCase());
    const { rows } = await pool.query(
      `SELECT id, name, specialty, fee_inr, is_on_call, notes
       FROM doctors
       WHERE clinic_id = $1 AND active = TRUE AND LOWER(specialty) = ANY($2::text[])
       ORDER BY is_on_call ASC, name`,
      [clinicId, lowered]
    );
    if (rows.length > 0) return rows;
  }

  return [];
}

// Compute today_available, today_hours, next_available_day for a single
// doctor. Skips if doctor is on-call (they have no schedule rows by design).
async function computeAvailability({ pool, doctor, now, timezone }) {
  if (doctor.is_on_call) {
    return {
      today_available: false,
      today_hours: null,
      next_available_day: null,
      walk_in: false
    };
  }

  const todayDow  = dayOfWeekInTz(now, timezone);
  const todayDate = isoDateInTz(now, timezone);

  // Today's schedules.
  const { rows: todaySchedules } = await pool.query(
    `SELECT day_of_week, start_time, end_time, is_walk_in, notes
     FROM doctor_schedules
     WHERE doctor_id = $1 AND day_of_week = $2
     ORDER BY start_time`,
    [doctor.id, todayDow]
  );

  // Today's exceptions.
  const { rows: todayExceptions } = await pool.query(
    `SELECT exception_type, start_time, end_time
     FROM doctor_exceptions
     WHERE doctor_id = $1 AND exception_date = $2`,
    [doctor.id, todayDate]
  );
  const onLeaveToday = todayExceptions.some(
    e => e.exception_type === 'leave' || e.exception_type === 'closed'
  );

  let todayAvailable = false;
  let todayHours = null;
  let walkIn = false;
  if (!onLeaveToday && todaySchedules.length > 0) {
    // Only "available today" if the current time is still BEFORE the last slot
    // ends — otherwise the slot has passed and offering/booking it is wrong
    // (e.g. a 15:00-16:30 slot at 22:00). When it's over, fall through to
    // next_available_day below so the model proposes the next real day.
    const nowMin = timeOfDayMinutesInTz(now, timezone);
    // The last time still worth offering, not the last minute of the shift. At
    // 19:45 on a 17:00-20:00 day this used to report the doctor available today
    // and then refuse every time the caller named.
    const lastEnd = Math.max(...todaySchedules.map(s => hhmmToMinutes(offerableEnd(s.end_time))));
    if (nowMin < lastEnd) {
      todayAvailable = true;
      todayHours = todaySchedules
        .map(s => offerableRange(s.start_time, s.end_time))
        .join(', ');
      walkIn = todaySchedules.some(s => s.is_walk_in);
    }
  }

  // Find next available day if not today (or even if today — for the LLM
  // to mention as a fallback).
  let nextAvailableDay = null;
  for (let offset = todayAvailable ? 1 : 1; offset <= NEXT_AVAILABLE_HORIZON_DAYS; offset++) {
    const future = addDays(now, offset);
    const futureDow  = dayOfWeekInTz(future, timezone);
    const futureDate = isoDateInTz(future, timezone);

    const { rows: futureSched } = await pool.query(
      `SELECT start_time, end_time, is_walk_in
       FROM doctor_schedules WHERE doctor_id = $1 AND day_of_week = $2
       ORDER BY start_time`,
      [doctor.id, futureDow]
    );
    if (futureSched.length === 0) continue;

    const { rows: futureExc } = await pool.query(
      `SELECT exception_type FROM doctor_exceptions
       WHERE doctor_id = $1 AND exception_date = $2`,
      [doctor.id, futureDate]
    );
    const blocked = futureExc.some(e => e.exception_type === 'leave' || e.exception_type === 'closed');
    if (blocked) continue;

    // Carry the day's ACTUAL hours + a concrete start time so the LLM proposes a
    // real slot instead of guessing (it offered "10:00" when the doctor only sits
    // 15:00-16:30, which book_appointment then had to reject and correct).
    nextAvailableDay = {
      date: futureDate,
      day_name: DAY_NAMES[futureDow],
      hours: futureSched.map(s => offerableRange(s.start_time, s.end_time)).join(', '),
      suggested_time: formatTime(futureSched[0].start_time)
    };
    break;
  }

  return {
    today_available: todayAvailable,
    today_hours: todayHours,
    next_available_day: nextAvailableDay,
    walk_in: walkIn
  };
}

// The doctor's recurring weekly schedule as "Tuesday 10:00-13:00; Thursday …".
// computeAvailability only returns TODAY + the single next day, so when a patient
// asks about a specific future date the model had no data and GUESSED — the
// availability self-contradiction in the logs ("13th available" → "not available").
// Returning the full weekly pattern lets it answer any date deterministically.
// On-call doctors have no fixed schedule → null.
async function weeklySchedule(pool, doctorId) {
  const { rows } = await pool.query(
    `SELECT day_of_week, start_time, end_time FROM doctor_schedules
     WHERE doctor_id = $1 ORDER BY day_of_week, start_time`,
    [doctorId]
  );
  if (!rows.length) return null;
  const byDay = {};
  for (const r of rows) {
    (byDay[r.day_of_week] = byDay[r.day_of_week] || []).push(offerableRange(r.start_time, r.end_time));
  }
  return Object.keys(byDay)
    .sort((a, b) => a - b)
    .map(d => `${DAY_NAMES[d]} ${byDay[d].join(',')}`)
    .join('; ');
}

async function execute({ symptom, specialty, doctor_name }, context) {
  if (!context || !context.pool) throw new Error('find_doctor: context.pool required');
  if (!context.clinicId) throw new Error('find_doctor: context.clinicId required');

  const now = context.currentDatetime ? new Date(context.currentDatetime) : new Date();

  // Pull clinic timezone (default Asia/Kolkata).
  const { rows: [clinic] } = await context.pool.query(
    `SELECT timezone FROM clinics WHERE id = $1`,
    [context.clinicId]
  );
  const timezone = (clinic && clinic.timezone) || 'Asia/Kolkata';

  const symptomSpecialties = symptom ? specialtiesForSymptom(symptom) : [];

  const candidates = await selectCandidates({
    pool: context.pool,
    clinicId: context.clinicId,
    doctorName: doctor_name,
    specialty,
    symptomSpecialties
  });

  if (candidates.length === 0) {
    // If a NAME was supplied but matched nothing, it was almost certainly misheard
    // (quiet / code-mixed caller — Sarvam mangled it). Signal the model to ASK THE
    // CALLER TO REPEAT rather than offer a generic callback — and never let it invent
    // a doctor name or claim (un)availability for a name we could not resolve.
    if (doctor_name && String(doctor_name).trim()) {
      return {
        doctors: [], matched_via: null, name_unmatched: true, requested_name: doctor_name,
        hint: 'No doctor matched that NAME — it was likely misheard. ASK THE CALLER TO REPEAT THE DOCTOR NAME. Do NOT state or invent any doctor name, and do NOT say any doctor is available or unavailable.'
      };
    }
    return { doctors: [], matched_via: null, hint: 'No doctor matched. Offer callback to clinic.' };
  }

  const doctors = [];
  for (const doc of candidates) {
    const avail = await computeAvailability({ pool: context.pool, doctor: doc, now, timezone });
    const available_days = doc.is_on_call ? null : await weeklySchedule(context.pool, doc.id);
    doctors.push({
      id: doc.id,
      name: doc.name,
      specialty: doc.specialty,
      fee_inr: doc.fee_inr,
      is_on_call: doc.is_on_call,
      notes: doc.notes,
      available_days,
      ...avail
    });
  }

  // Sort: in-house with today_available first, then in-house, then on-call.
  doctors.sort((a, b) => {
    if (a.is_on_call !== b.is_on_call) return a.is_on_call ? 1 : -1;
    if (a.today_available !== b.today_available) return a.today_available ? -1 : 1;
    return 0;
  });

  const matched_via = doctor_name ? 'doctor_name'
                    : specialty   ? 'specialty'
                    : symptomSpecialties.length ? 'symptom'
                    : null;

  return { doctors, matched_via, symptom_specialties: symptomSpecialties };
}

module.exports = { schema, execute };
