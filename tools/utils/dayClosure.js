// ═══════════════════════════════════════════════════════════════════════════
// IS THIS DOCTOR CLOSED ON THIS DATE — defined once, asked by both sides.
//
// WHY THIS FILE EXISTS. doctor_exceptions was consulted by the ACCEPT side only
// (tools/utils/availability.js, tools/findDoctor.js). brain-lean.js — the OFFER
// side — walked doctor_schedules and had never heard of it. So on a clinic
// holiday Ritu would OFFER 11:00 and the booking commit would REFUSE it: the
// caller is given a time, says yes, and is told no.
//
// That is the same shape as the defect ae16022 fixed (a window's exclusive end
// offered as a bookable time) and the one before it (taken slots the offer side
// could not see). Three instances of one thing: half the system knowing less
// than the other half about the same fact. The fix each time is not to teach
// the offer side a copy of the rule — it is to make one rule and have both
// sides ask it. That is what this module is.
//
// IT IS DELIBERATELY ONLY ABOUT CLOSURE. exception_type 'extra_hours' EXTENDS a
// doctor's availability; the accept side honours it and the offer side still
// does not. That gap is real and is left open on purpose, because it fails in
// the SAFE direction: we under-offer a day we would in fact accept. Offering
// something the commit refuses breaks a promise to a patient; not offering
// something we would have taken costs a booking. Only the first one lies.
//
// Pure. No I/O, no clock, no database — the caller brings the rows.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// The two exception types that make a doctor unavailable for the WHOLE day.
// Mirrors tools/utils/availability.js's own test, which is why that file now
// imports this instead of repeating the literal.
const CLOSURE_TYPES = Object.freeze(['leave', 'closed']);

/**
 * Does any of these exception rows close the day?
 * @param {Array<{exception_type: string}>} exceptions rows for ONE doctor and ONE date
 */
function closesDay(exceptions) {
  if (!Array.isArray(exceptions) || !exceptions.length) return false;
  return exceptions.some((e) => e && CLOSURE_TYPES.includes(e.exception_type));
}

/** The closing row itself, so a caller can name the reason ("on leave"). */
function closureFor(exceptions) {
  if (!Array.isArray(exceptions)) return null;
  return exceptions.find((e) => e && CLOSURE_TYPES.includes(e.exception_type)) || null;
}

/**
 * Build the offer side's lookup: a Set of `${doctorId}|${YYYY-MM-DD}` for every
 * doctor-day that is closed.
 *
 * Keyed by the DATE STRING the roster walk already computes in clinic-local
 * time, for the same reason getTakenSlots is keyed 'YYYY-MM-DD HH:MM': a Date
 * comparison here would reintroduce the timezone drift both of those key
 * formats exist to avoid.
 *
 * @param {Array<{doctor_id: string, exception_date: string|Date, exception_type: string}>} rows
 */
function closedDaySet(rows) {
  const out = new Set();
  for (const r of rows || []) {
    if (!r || !CLOSURE_TYPES.includes(r.exception_type)) continue;
    const d = r.exception_date instanceof Date
      // toISOString would shift a midnight DATE backwards in a +05:30 process.
      // exception_date is a DATE column: take its calendar parts as given.
      ? `${r.exception_date.getFullYear()}-${String(r.exception_date.getMonth() + 1).padStart(2, '0')}-${String(r.exception_date.getDate()).padStart(2, '0')}`
      : String(r.exception_date).slice(0, 10);
    out.add(`${r.doctor_id}|${d}`);
  }
  return out;
}

/** Ask the set built above. */
function isClosed(closedSet, doctorId, ymd) {
  return !!closedSet && closedSet.has(`${doctorId}|${ymd}`);
}

module.exports = { CLOSURE_TYPES, closesDay, closureFor, closedDaySet, isClosed };
