// ═══════════════════════════════════════════════════════════════════════════
// WHERE A BOOKABLE WINDOW ENDS — defined once, for every component that either
// OFFERS a time or ACCEPTS one.
//
// doctor_schedules stores a window (17:00–20:00). tools/utils/availability.js
// accepts a requested time only when `minutes >= start && minutes < end`, so
// the end of the window is NOT a bookable time. Every place that built an
// hours string for the model handed it the raw `start-end` anyway, and the
// model offered the end.
//
// Live 2026-08-13 (call c394b280), Dr. Alka Ranade 17:00–20:00:
//   RITU     "...वो आज रात 8:00 बजे तक उपलब्ध हैं। बुक करूँ?"
//   PATIENT  "हम्म।"
//   RITU     "उस समय उपलब्ध नहीं। Thursday 17:00 ठीक रहेगा?"
//
// Ritu offered 20:00, the caller accepted, and the accept side refused the very
// time the offer side had just promised. Neither component was wrong on its own
// terms — they disagreed about where the window ends, and only one of them was
// ever consulted at booking time. The caller heard the clinic change its mind.
//
// THIS FILE EXISTS SO THAT DISAGREEMENT CANNOT BE REINTRODUCED. The rule lives
// here; db.js (lean roster) and tools/findDoctor.js (full mode) both import it.
// Writing `${start}-${end}` by hand in either of them is the bug returning —
// tests/test-offer-window.js fails the build if a raw end reaches the model.
//
// SCOPE: the OFFER side only. availability.js keeps `< end`, so a caller who
// asks for 19:45 still gets 19:45. We only stop VOLUNTEERING times we would
// then refuse.
// ═══════════════════════════════════════════════════════════════════════════

const config = require('../../config');

// 'HH:MM:SS' | 'HH:MM' → minutes since midnight.
function toMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// minutes since midnight → 'HH:MM'.
function toHhmm(min) {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// The last start time worth OFFERING inside a window ending at `endTime`.
//
// `startTime` is optional but SHOULD be passed: without it a window shorter
// than one slot walks backwards past its own opening. A 10:00–10:20 clinic
// returned 09:50 — a time before the doctor arrives — because the only guard
// was `last > 0`, which is true for every window after 00:30. Caught by an
// edge-case probe, not by a call, but a short window is exactly what a
// lunch-hour or a single-slot exception looks like.
function offerableEnd(endTime, startTime) {
  const end   = toMinutes(endTime);
  const start = startTime == null ? null : toMinutes(startTime);
  const last  = end - config.appointmentSlotMinutes;
  // Never earlier than the window opens, never at or after it closes. For a
  // window shorter than one slot that collapses to the opening minute itself:
  // a short appointment is honest, a time outside the shift is not.
  const floor = start == null ? 0 : start;
  return toHhmm(Math.min(Math.max(last, floor), Math.max(end - 1, floor)));
}

// `start-end` rendered as the range we are willing to be held to.
function offerableRange(startTime, endTime) {
  return `${toHhmm(toMinutes(startTime))}-${offerableEnd(endTime, startTime)}`;
}

// True when `hhmm` is a time we would offer inside this window — i.e. the
// booking would not run past close. Used by tests and by any future caller
// that wants to check an offer before speaking it.
function isOfferable(hhmm, startTime, endTime) {
  const t = toMinutes(hhmm);
  return t >= toMinutes(startTime) && t <= toMinutes(offerableEnd(endTime, startTime));
}

module.exports = { offerableEnd, offerableRange, isOfferable, toMinutes, toHhmm };
