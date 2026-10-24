'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// appointmentEvents.js — Ritu's changes land in the desk's action log.
//
// The desk records every booked / moved / cancelled with before + after and
// an undo chain (migration 019/007; ritu-desk-demo lib/events.ts recordEvent).
// Until 2026-09-15 nothing Ritu did left a row there: a patient who moved
// their appointment on a call, or on WhatsApp, changed the row and the desk's
// Recent panel and Ledger never heard of it. Module 6 of the clinic-basics
// program closes that: every write the voice service makes to an appointment
// goes through here, actor 'ritu', channel 'call' or 'whatsapp'.
//
// The INSERT is the desk's statement verbatim — the desk's check:sync pairs
// the two, so they cannot drift. Best-effort by design: a database without
// migration 019 (or pg-mem in tests) has no table, and a log that cannot be
// written must never fail a change that has already been committed.
// ═══════════════════════════════════════════════════════════════════════════

async function recordAppointmentEvent(q, e) {
  try {
    const { rows } = await q.query(
      `INSERT INTO appointment_events
         (clinic_id, appointment_id, action, actor, actor_label, channel, call_id, before, after, undo_of, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        e.clinicId, e.appointmentId, e.action, e.actor || 'ritu', e.actorLabel || null, e.channel || 'call', e.callId || null,
        e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null,
        e.undoOf || null, e.note || null,
      ]
    );
    return rows && rows[0] ? String(rows[0].id) : null;
  } catch (err) {
    console.warn(`[EVENTS] ${e.action} by ${e.actor || 'ritu'} not logged (${err.code || err.message}) — the change itself stands`);
    return null;
  }
}

/** 'whatsapp' when the turn came from the WhatsApp channel, else 'call'. */
function channelOf(context) {
  return context && context.channel === 'whatsapp' ? 'whatsapp' : 'call';
}

/** A note that names the conversation without a calls-row FK (the row is written at call end). */
function noteOf(context) {
  return context && context.callSid ? `via ${String(context.callSid).slice(0, 48)}` : null;
}

module.exports = { recordAppointmentEvent, channelOf, noteOf };
