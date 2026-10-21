// ═══════════════════════════════════════════════════════════════════════════
// tools/updateAppointment.js
//
// Reschedule or cancel an existing appointment. The LLM is expected to call
// find_patient_appointment first to get the appointment_id.
//
// Modes:
//   { appointment_id, cancel: true }        → set status='cancelled',
//                                              fail-soft delete GCal event
//   { appointment_id, new_datetime }        → re-check availability at the
//                                              new time, update DB, fail-soft
//                                              update GCal event
//
// Validation:
//   - Cannot update an already-cancelled appointment
//   - Cannot update a past appointment (appointment_time <= now)
//   - Reschedule re-runs the same availability checks as bookAppointment
//
// Context: { pool, clinicId, currentDatetime (optional),
//            calendar (optional, defaults to require('../calendar')) }
// ═══════════════════════════════════════════════════════════════════════════

const {
  checkDoctorAvailability, clinicTimezone, isoDateInTz, timeInTz
} = require('./utils/availability');
const { normalizePhone } = require('./utils/phoneNormalizer');
const appointmentEvents = require('../appointmentEvents'); // module object: tests mutate it
const config = require('../config');

const schema = {
  type: 'function',
  function: {
    name: 'update_appointment',
    description: 'Update an existing appointment\'s time or cancel it. Call find_patient_appointment first to get the appointment_id. Use cancel=true to cancel; provide new_datetime to reschedule.',
    parameters: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'Appointment UUID from find_patient_appointment.' },
        new_datetime:   { type: 'string', description: "New ISO 8601 datetime in IST (e.g. '2026-05-29T15:30:00+05:30') if rescheduling." },
        cancel:         { type: 'boolean', description: 'Set to true to cancel the appointment.' }
      },
      required: ['appointment_id']
    }
  }
};

async function execute({ appointment_id, new_datetime, cancel }, context) {
  // LAYER 3 of 3. The prompt omits the sentinel and the handler refuses it, but
  // this tool is reachable from the legacy brain and from any future caller, and
  // it is the last point before a write. A clinic that reserved cancellation for
  // its staff must not have an appointment moved by any path at all.
  // Two switches since 2026-09-15: a clinic may let patients MOVE their own
  // appointment while keeping CANCEL for staff (config.agentMayReschedule /
  // config.agentMayCancel; unset reschedule follows cancel).
  if (config && cancel === true && config.agentMayCancel === false) {
    console.warn('[POLICY] updateAppointment cancel refused — agentMayCancel=false');
    return { success: false, fail_kind: 'staff_only',
             error_message: 'Cancellation is handled by clinic staff at this clinic.' };
  }
  if (config && cancel !== true && config.agentMayReschedule === false) {
    console.warn('[POLICY] updateAppointment move refused — agentMayReschedule=false');
    return { success: false, fail_kind: 'staff_only',
             error_message: 'Rescheduling is handled by clinic staff at this clinic.' };
  }

  if (!context || !context.pool) throw new Error('update_appointment: context.pool required');
  if (!context.clinicId)         throw new Error('update_appointment: context.clinicId required');
  if (!context.patientPhone)     throw new Error('update_appointment: context.patientPhone required');

  const { pool, clinicId } = context;
  // Caller ID — the appointment MUST belong to this number, so a spoofed/confused
  // caller can't cancel or reschedule someone else's appointment.
  const phone = normalizePhone(context.patientPhone);
  const now = context.currentDatetime ? new Date(context.currentDatetime) : new Date();

  // Fetch the appointment + its doctor.
  const { rows: [appt] } = await pool.query(
    `SELECT a.id, a.clinic_id, a.patient_id, a.doctor_id, a.appointment_time,
            a.status, a.google_calendar_event_id,
            d.name AS doctor_name, d.specialty AS doctor_specialty,
            d.is_on_call
       FROM appointments a
       JOIN doctors d ON a.doctor_id = d.id
       JOIN patients p ON a.patient_id = p.id
      WHERE a.id = $1 AND a.clinic_id = $2 AND p.phone = $3
      LIMIT 1`,
    [appointment_id, clinicId, phone]
  );
  if (!appt) {
    // Either no such appointment, or it doesn't belong to this caller's number.
    // Same message either way — never reveal another patient's appointment exists.
    return { success: false, error_message: 'Appointment not found.' };
  }
  if (appt.status === 'cancelled') {
    return { success: false, error_message: 'Appointment is already cancelled.' };
  }
  if (appt.status === 'completed') {
    return { success: false, error_message: 'Appointment is already completed and cannot be modified.' };
  }

  // Time check — never update a past appointment.
  const currentTime = new Date(appt.appointment_time).getTime();
  if (currentTime <= now.getTime()) {
    return {
      success: false,
      error_message: 'Appointment is in the past — cannot reschedule or cancel.'
    };
  }

  const timezone = await clinicTimezone({ pool, clinicId });

  // ─── CANCEL ───────────────────────────────────────────────────────────
  if (cancel === true) {
    await pool.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [appointment_id]
    );
    // The desk's action log: who cancelled, from where, what it was.
    await appointmentEvents.recordAppointmentEvent(pool, {
      clinicId, appointmentId: appointment_id, action: 'cancelled', actor: 'ritu',
      channel: appointmentEvents.channelOf(context), note: appointmentEvents.noteOf(context),
      before: { appointment_time: appt.appointment_time, status: appt.status, doctor: appt.doctor_name },
      after: { status: 'cancelled' },
    });

    // Fail-soft GCal delete. If calendar.js doesn't expose a delete method
    // we leave the event alone; the receptionist can clean up manually.
    let calendarCleared = false;
    if (appt.google_calendar_event_id) {
      try {
        const cal = context.calendar || (process.env.ENABLE_GOOGLE_CALENDAR === 'true' ? require('../calendar') : null);
        if (cal && typeof cal.deleteEvent === 'function') {
          await cal.deleteEvent(appt.google_calendar_event_id);
          calendarCleared = true;
        } else {
          console.warn(`[TOOL update_appointment] calendar.deleteEvent not implemented; GCal event ${appt.google_calendar_event_id} left in place.`);
        }
      } catch (err) {
        console.warn(`[TOOL update_appointment] Calendar delete failed (DB cancelled anyway): ${err.message}`);
      }
    }

    return {
      success: true,
      action: 'cancelled',
      appointment_id,
      doctor_name: appt.doctor_name,
      calendar_cleared: calendarCleared,
      confirmation_text: `Appointment ${appt.doctor_name} ke saath cancel kar di hai.`
    };
  }

  // ─── RESCHEDULE ───────────────────────────────────────────────────────
  if (!new_datetime) {
    return { success: false, error_message: 'No new_datetime provided and cancel is not true.' };
  }
  const requestedDate = new Date(new_datetime);
  if (isNaN(requestedDate.getTime())) {
    return { success: false, error_message: 'Invalid new_datetime — expected ISO 8601.' };
  }
  // Cannot reschedule to the past.
  if (requestedDate.getTime() <= now.getTime()) {
    return { success: false, error_message: 'New datetime is in the past.' };
  }

  // On-call specialists can't be rescheduled — they don't take fixed bookings.
  if (appt.is_on_call) {
    return {
      success: false,
      error_message: `${appt.doctor_name} is on-call (${appt.doctor_specialty}). Cannot reschedule; use request_callback for on-call doctors.`
    };
  }

  const avail = await checkDoctorAvailability({
    pool, doctorId: appt.doctor_id, requestedDateTime: requestedDate, timezone, now
  });
  if (!avail.ok) {
    return {
      success: false,
      error_message: avail.reason,
      alternatives: avail.alternatives
    };
  }

  // MOVE resets reminder_sent/confirmed in the same statement so the NEW time
  // gets its 24h reminder and the no-show job doesn't skip the moved row.
  try {
    await pool.query(
      `UPDATE appointments
          SET appointment_time = $1, reminder_sent = FALSE, confirmed = FALSE,
              updated_at = NOW()
        WHERE id = $2`,
      [requestedDate.toISOString(), appointment_id]
    );
    // The desk's action log: moved, by Ritu, from where, from when to when.
    await appointmentEvents.recordAppointmentEvent(pool, {
      clinicId, appointmentId: appointment_id, action: 'moved', actor: 'ritu',
      channel: appointmentEvents.channelOf(context), note: appointmentEvents.noteOf(context),
      before: { appointment_time: appt.appointment_time, doctor: appt.doctor_name },
      after: { appointment_time: requestedDate.toISOString(), doctor: appt.doctor_name },
    });
  } catch (err) {
    if (err.code === '23505' || err.code === '23P01') {
      // uniq_doctor_slot (005_booking_integrity.sql): the new time is a scheduled
      // slot held by ANOTHER patient — same deterministic re-offer shape as
      // bookAppointment; never leak a SQLSTATE.
      return {
        success: false,
        error_message: `That ${timeInTz(requestedDate, timezone)} slot with ${appt.doctor_name} was just taken. Briefly apologize and offer the patient another time or day.`,
        alternatives: []
      };
    }
    throw err;
  }

  // Fail-soft GCal update.
  let calendarUpdated = false;
  if (appt.google_calendar_event_id) {
    try {
      const cal = context.calendar || (process.env.ENABLE_GOOGLE_CALENDAR === 'true' ? require('../calendar') : null);
      if (cal && typeof cal.updateAppointment === 'function') {
        const r = await cal.updateAppointment({
          eventId: appt.google_calendar_event_id,
          dateTime: requestedDate
        });
        calendarUpdated = !!(r && r.success);
      }
    } catch (err) {
      console.warn(`[TOOL update_appointment] Calendar update failed (DB updated anyway): ${err.message}`);
    }
  }

  return {
    success: true,
    action: 'rescheduled',
    appointment_id,
    doctor_name: appt.doctor_name,
    doctor_specialty: appt.doctor_specialty,
    new_appointment_time: requestedDate.toISOString(),
    calendar_updated: calendarUpdated,
    walk_in: avail.is_walk_in,
    confirmation_text: `Naya time confirmed: ${appt.doctor_name} (${appt.doctor_specialty}) on ${isoDateInTz(requestedDate, timezone)} at ${timeInTz(requestedDate, timezone)}.`
  };
}

module.exports = { schema, execute };
