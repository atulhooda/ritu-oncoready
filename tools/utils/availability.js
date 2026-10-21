// ═══════════════════════════════════════════════════════════════════════════
// Doctor availability helpers — shared between bookAppointment and
// updateAppointment so the validation logic is identical for "is this
// slot bookable?" regardless of which path triggered the question.
//
// Public functions:
//   checkDoctorAvailability({ pool, doctorId, requestedDateTime, timezone })
//     → { ok: true, is_walk_in: bool }
//     → { ok: false, reason, alternatives: [{ date, day_name,
//                                              suggested_time, is_walk_in }] }
//   clinicTimezone({ pool, clinicId }) → string
// ═══════════════════════════════════════════════════════════════════════════

// The OFFER side (brain-lean's firstFreeSlot) asks the same closure question
// through this module. It used to be a pair of literals in this file alone,
// which is precisely why a clinic holiday was refused at the commit and
// cheerfully offered on the call.
const { closesDay, CLOSURE_TYPES } = require('./dayClosure');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayOfWeekInTz(date, timezone) {
  const weekday = date.toLocaleString('en-US', { timeZone: timezone, weekday: 'long' });
  return { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }[weekday];
}

function isoDateInTz(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  return [
    parts.find(p => p.type === 'year').value,
    parts.find(p => p.type === 'month').value,
    parts.find(p => p.type === 'day').value
  ].join('-');
}

function timeInTz(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function timeToMinutes(t) {
  if (!t) return null;
  const s = (t instanceof Date) ? t.toISOString().substring(11, 16) : String(t).substring(0, 5);
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function formatHHMM(t) {
  if (!t) return null;
  return (t instanceof Date) ? t.toISOString().substring(11, 16) : String(t).substring(0, 5);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function clinicTimezone({ pool, clinicId }) {
  const { rows: [clinic] } = await pool.query(
    `SELECT timezone FROM clinics WHERE id = $1`,
    [clinicId]
  );
  return (clinic && clinic.timezone) || 'Asia/Kolkata';
}

/**
 * Validate whether `doctorId` can take an appointment at `requestedDateTime`
 * in the clinic's timezone. Inspects doctor_schedules and doctor_exceptions.
 *
 * On failure returns alternatives — up to two suggested working slots
 * (same-day valid time + next available day) so the caller can offer them
 * back to the patient.
 */
async function checkDoctorAvailability({ pool, doctorId, requestedDateTime, timezone, now = new Date() }) {
  const dow     = dayOfWeekInTz(requestedDateTime, timezone);
  const dateStr = isoDateInTz(requestedDateTime, timezone);
  const timeStr = timeInTz(requestedDateTime, timezone);
  const minutes = timeToMinutes(timeStr);

  // Never book (or reschedule to) a time in the PAST. ~5-min grace absorbs clock
  // skew and a slot that just ticked past mid-call. Alternatives are anchored at
  // NOW (not the stale request) so we never offer a day that already went by.
  const GRACE_MS = 5 * 60 * 1000;
  const isPast   = requestedDateTime.getTime() <= now.getTime() - GRACE_MS;
  const altAnchor = requestedDateTime.getTime() < now.getTime() ? now : requestedDateTime;

  // schedules + exceptions are independent → one round-trip, not two (parallel).
  const [{ rows: schedules }, { rows: exceptions }] = await Promise.all([
    pool.query(
      `SELECT day_of_week, start_time, end_time, is_walk_in
       FROM doctor_schedules
       WHERE doctor_id = $1 AND day_of_week = $2
       ORDER BY start_time`,
      [doctorId, dow]
    ),
    pool.query(
      `SELECT exception_type, start_time, end_time
       FROM doctor_exceptions
       WHERE doctor_id = $1 AND exception_date = $2`,
      [doctorId, dateStr]
    )
  ]);
  const leaveOrClosed = exceptions.find(e => CLOSURE_TYPES.includes(e.exception_type));

  const findAlternatives = async () => {
    const alts = [];
    for (let offset = 1; offset <= 14 && alts.length < 2; offset++) {
      const future = addDays(altAnchor, offset);
      const futureDow  = dayOfWeekInTz(future, timezone);
      const futureDate = isoDateInTz(future, timezone);

      const { rows: futureSched } = await pool.query(
        `SELECT start_time, end_time, is_walk_in
         FROM doctor_schedules WHERE doctor_id = $1 AND day_of_week = $2
         ORDER BY start_time LIMIT 1`,
        [doctorId, futureDow]
      );
      if (futureSched.length === 0) continue;

      const { rows: futureExc } = await pool.query(
        `SELECT exception_type FROM doctor_exceptions
         WHERE doctor_id = $1 AND exception_date = $2`,
        [doctorId, futureDate]
      );
      if (closesDay(futureExc)) continue;

      alts.push({
        date: futureDate,
        day_name: DAY_NAMES[futureDow],
        suggested_time: formatHHMM(futureSched[0].start_time),
        is_walk_in: futureSched[0].is_walk_in
      });
    }
    return alts;
  };

  if (isPast) {
    return {
      ok: false,
      reason: `Requested time (${dateStr} ${timeStr}) is in the past.`,
      alternatives: await findAlternatives()
    };
  }

  if (leaveOrClosed) {
    return {
      ok: false,
      reason: `Doctor is on ${leaveOrClosed.exception_type} on ${dateStr}.`,
      alternatives: await findAlternatives()
    };
  }

  if (schedules.length === 0) {
    return {
      ok: false,
      reason: `Doctor does not work on ${DAY_NAMES[dow]}.`,
      alternatives: await findAlternatives()
    };
  }

  const withinAnySchedule = schedules.some(s => {
    const start = timeToMinutes(s.start_time);
    const end   = timeToMinutes(s.end_time);
    return minutes >= start && minutes < end;
  });
  const withinExtraHours = exceptions.some(e => {
    if (e.exception_type !== 'extra_hours') return false;
    const start = timeToMinutes(e.start_time);
    const end   = timeToMinutes(e.end_time);
    return minutes >= start && minutes < end;
  });

  if (!withinAnySchedule && !withinExtraHours) {
    const hours = schedules
      .map(s => `${formatHHMM(s.start_time)}-${formatHHMM(s.end_time)}`)
      .join(', ');
    return {
      ok: false,
      reason: `Requested time ${timeStr} is outside doctor's hours on ${DAY_NAMES[dow]} (${hours}).`,
      alternatives: [
        {
          date: dateStr,
          day_name: DAY_NAMES[dow],
          suggested_time: formatHHMM(schedules[0].start_time),
          is_walk_in: schedules[0].is_walk_in
        },
        ...(await findAlternatives()).slice(0, 1)
      ]
    };
  }

  return {
    ok: true,
    is_walk_in: schedules.some(s => s.is_walk_in)
  };
}

module.exports = {
  checkDoctorAvailability,
  clinicTimezone,
  // Re-exported helpers used by other tools
  dayOfWeekInTz,
  isoDateInTz,
  timeInTz,
  formatHHMM,
  DAY_NAMES
};
