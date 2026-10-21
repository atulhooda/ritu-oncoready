// ═══════════════════════════════════════════════════════════════════════════
// tools/bookAppointment.js
//
// Creates an appointment after verifying the doctor's availability at the
// requested datetime via tools/utils/availability.js. On any validation
// failure returns { success:false, error_message, alternatives } so the LLM
// can suggest a different time.
//
// Calendar API is fail-soft — if Google Calendar errors out we still create
// the DB row and return success (with a warning logged). The clinic's
// source of truth is Postgres, not Calendar.
//
// Idempotency + integrity: the write path is ONE atomic INSERT ... ON
// CONFLICT arbitrated by the partial unique indexes from migration 005
// (uniq_active_patient_doctor / uniq_doctor_slot) — same patient+doctor
// re-book is an idempotent no-op (same time) or a MOVE (new time); a slot
// held by ANOTHER patient raises 23505 and becomes a deterministic re-offer.
//
// Context required by execute():
//   { pool, clinicId, patientPhone, currentDatetime (optional),
//     calendar (optional, defaults to require('../calendar')) }
// ═══════════════════════════════════════════════════════════════════════════

const { normalizePhone } = require('./utils/phoneNormalizer');
const appointmentEvents = require('../appointmentEvents');
const { resolvePatient } = require('../patientIdentity');
const {
  checkDoctorAvailability, clinicTimezone, isoDateInTz, timeInTz
} = require('./utils/availability');

const schema = {
  type: 'function',
  function: {
    name: 'book_appointment',
    description: 'Book an appointment after confirming patient name, doctor, date, and time. The patient MUST have confirmed all details before calling this. Returns confirmation details on success, or alternatives if the requested slot is invalid.',
    parameters: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: "Patient's full name as confirmed by the patient" },
        doctor_id:    { type: 'string', description: "Doctor from find_doctor — pass the UUID if you have it, otherwise the doctor's name (e.g. 'Dr. Priyanka Bhosale')" },
        appointment_datetime: {
          type: 'string',
          description: "ISO 8601 datetime in IST (e.g. '2026-05-29T15:30:00+05:30')"
        },
        reason: { type: 'string', description: 'Brief reason for visit' }
      },
      required: ['patient_name', 'doctor_id', 'appointment_datetime', 'reason']
    }
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Normalize a doctor name for fuzzy comparison: drop honorifics/punctuation,
// lowercase, collapse whitespace. "Dr. Priyanka Bhosale" → "priyanka bhosale".
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(dr|doctor|on-call|oncall)\b\.?/g, '')
    .replace(/[^a-zऀ-ॿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// Resolve a doctor by UUID or (fuzzy) name within the clinic. Weak LLMs often
// pass the doctor's NAME into doctor_id instead of the opaque UUID, sometimes
// misspelled ("Bhosle" for "Bhosale") — so a name path with edit-distance
// tolerance is what actually makes booking reliable.
async function resolveDoctor({ pool, clinicId, doctorRef }) {
  if (doctorRef && UUID_RE.test(doctorRef.trim())) {
    const { rows } = await pool.query(
      `SELECT id, name, specialty, is_on_call, active
       FROM doctors WHERE id = $1 AND clinic_id = $2`,
      [doctorRef.trim(), clinicId]
    );
    return rows[0] || null;
  }

  const query = normName(doctorRef);
  if (!query) return null;

  const { rows } = await pool.query(
    `SELECT id, name, specialty, is_on_call, active
     FROM doctors WHERE clinic_id = $1 AND active = TRUE`,
    [clinicId]
  );

  let best = null, bestScore = 0;
  for (const d of rows) {
    const cand = normName(d.name);
    let score;
    if (cand === query) score = 100;
    else if (cand.includes(query) || query.includes(cand)) score = 90;
    else {
      // Best token-pair similarity (handles misspelled surname / partial name).
      const qToks = query.split(' ').filter(t => t.length >= 3);
      const cToks = cand.split(' ').filter(t => t.length >= 3);
      let tokBest = 0;
      for (const qt of qToks) for (const ct of cToks) {
        const dist = levenshtein(qt, ct);
        const sim = 1 - dist / Math.max(qt.length, ct.length);
        if (sim > tokBest) tokBest = sim;
      }
      score = Math.round(tokBest * 85); // cap below substring matches
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  // 70 ≈ one token matching with a small typo; below that, refuse to guess.
  return bestScore >= 70 ? best : null;
}

async function findOrCreatePatient({ pool, clinicId, phone, name }) {
  // ONE IMPLEMENTATION, in patientIdentity.js. This function used to be the
  // SECOND of three "who is this caller" resolvers, and the one a booking
  // actually runs — it matched on the EXACT phone string and the EXACT name and
  // inserted otherwise, so none of the identity work in db.js applied here.
  //
  // Live call 5b261b844e, 2026-08-14: one caller, one handset, three rows in
  // 2m19s ("Aman Nambaria" / "আমন নাম্বারিয়া" / "[Patient Name]"). The
  // appointment committed against the first; when he asked to confirm it the
  // lookup below ran against a drifted name, missed, and the insert collided
  // with uniq_doctor_slot on a slot he already held. The caller was told
  // "that time is not available".
  const p = await resolvePatient(pool, clinicId, phone, name);
  if (p) return p;
  // resolvePatient returns null only when the handset carries several patients
  // and nothing said which — booking cannot proceed on a guess there.
  throw new Error('patient_ambiguous_on_shared_handset');
}

async function execute(
  { patient_name, doctor_id, appointment_datetime, reason },
  context
) {
  if (!context || !context.pool)  throw new Error('book_appointment: context.pool required');
  if (!context.clinicId)          throw new Error('book_appointment: context.clinicId required');
  if (!context.patientPhone)      throw new Error('book_appointment: context.patientPhone required');

  const { pool, clinicId } = context;
  const phone = normalizePhone(context.patientPhone);
  if (!phone) {
    return {
      success: false,
      fail_kind: 'bad_input',
      error_message: `Invalid patient phone: "${context.patientPhone}"`,
      alternatives: []
    };
  }

  // timezone + doctor lookup are independent → run together (one round-trip, not two).
  const [timezone, doctor] = await Promise.all([
    clinicTimezone({ pool, clinicId }),
    resolveDoctor({ pool, clinicId, doctorRef: doctor_id })
  ]);
  if (!doctor || !doctor.active) {
    return {
      success: false,
      fail_kind: 'no_such_doctor',
      error_message: 'Doctor not found or not active at this clinic. Call find_doctor first to get the exact doctor.',
      alternatives: []
    };
  }
  if (doctor.is_on_call) {
    return {
      success: false,
      fail_kind: 'on_call',
      error_message: `${doctor.name} is an on-call specialist (${doctor.specialty}). Use request_callback instead of book_appointment.`,
      alternatives: [],
      hint: 'route_to_callback'
    };
  }

  const requestedDate = new Date(appointment_datetime);
  if (isNaN(requestedDate.getTime())) {
    return { success: false, fail_kind: 'bad_input', error_message: 'Invalid appointment_datetime — expected ISO 8601.', alternatives: [] };
  }

  // availability check + patient upsert are independent → run together. Both run
  // only AFTER the doctor is validated above, so a bad-doctor booking still creates
  // no patient row; only a valid-doctor-but-unavailable-slot does, which is harmless
  // (the caller is a real patient).
  const now = context.currentDatetime ? new Date(context.currentDatetime) : new Date();
  const [avail, patient] = await Promise.all([
    checkDoctorAvailability({ pool, doctorId: doctor.id, requestedDateTime: requestedDate, timezone, now }),
    findOrCreatePatient({ pool, clinicId, phone, name: patient_name })
  ]);
  if (!avail.ok) {
    return {
      success: false,
      // The doctor does not work then — a different fact from "somebody else
      // has that slot", and it needs a different sentence. checkDoctorAvailability
      // already distinguishes them in avail.reason; this carries the distinction
      // in a form nothing has to parse English to read.
      fail_kind: avail.kind || 'not_working',
      error_message: avail.reason,
      alternatives: avail.alternatives
    };
  }

  // ONE active appointment per (patient + doctor), enforced by the partial unique
  // index uniq_active_patient_doctor (005_booking_integrity.sql) and arbitrated in
  // a SINGLE atomic statement — no SELECT-then-INSERT race window:
  //   • no active row                → fresh INSERT                (inserted = true)
  //   • active row, DIFFERENT time   → MOVE that row (reschedule; inserted = false)
  //                                    — resets reminder_sent/confirmed in the same
  //                                    statement so the NEW time gets its 24h
  //                                    reminder and the no-show job doesn't skip it
  //   • active row, SAME time        → DO UPDATE's WHERE filters it out → 0 rows
  //                                    returned → idempotent no-op (flags untouched)
  // (Different DOCTOR is a separate row — the conflict target is doctor-scoped, so a
  // genuine second appointment with another doctor still works.)
  // uniq_doctor_slot guards the slot itself: if the INSERT — or the MOVE — lands on
  // a scheduled slot held by ANOTHER patient, Postgres raises 23505; caught below
  // and returned as the standard deterministic re-offer. Walk-in slots are exempt
  // by the index predicate, which is why is_walk_in is stamped on the row here.
  // The `prev` CTE captures the pre-statement time so a MOVE can report moved_from
  // (best-effort: empty under a concurrent-commit race, then moved_from is null).
  // NOTE: MOVE doesn't touch Google Calendar — GCal is OFF by default (DB is source
  // of truth); acceptable gap under the default config.
  let rows;
  try {
    ({ rows } = await pool.query(
      `WITH prev AS (
         SELECT appointment_time FROM appointments
          WHERE clinic_id = $1 AND patient_id = $2 AND doctor_id = $3
            AND status = 'booked'
            AND (appointment_time AT TIME ZONE 'Asia/Kolkata')::date
              = (($4::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date
          LIMIT 1
       )
       INSERT INTO appointments
         (clinic_id, patient_id, doctor_id, appointment_time, reason, status, source, is_walk_in)
       VALUES ($1, $2, $3, $4, $5, 'booked', 'ritu', $6)
       -- Must match db/migrations/013's uniq_active_patient_doctor_day expression
       -- CHARACTER FOR CHARACTER: Postgres infers the index from this shape, and a
       -- mismatch is a loud 42P10 on every booking rather than a quiet wrong write.
       ON CONFLICT (clinic_id, patient_id, doctor_id,
                    ((appointment_time AT TIME ZONE 'Asia/Kolkata')::date))
         WHERE status = 'booked'
       DO UPDATE SET appointment_time = EXCLUDED.appointment_time,
                     reason           = EXCLUDED.reason,
                     is_walk_in       = EXCLUDED.is_walk_in,
                     reminder_sent    = FALSE,
                     confirmed        = FALSE,
                     updated_at       = NOW()
         WHERE appointments.appointment_time IS DISTINCT FROM EXCLUDED.appointment_time
       RETURNING id, appointment_time, (xmax = 0) AS inserted,
                 (SELECT appointment_time FROM prev) AS moved_from`,
      [clinicId, patient.id, doctor.id, requestedDate.toISOString(), reason || null,
       avail.is_walk_in === true]
    ));
  } catch (err) {
    if (err.code === '23505' || err.code === '23P01') {
      // Slot just taken by another patient (uniq_doctor_slot) — same deterministic
      // re-offer shape as the calendar-conflict path below; never leak a SQLSTATE.
      return {
        success: false,
        fail_kind: 'slot_taken',
        error_message: `That ${timeInTz(requestedDate, timezone)} slot with ${doctor.name} was just taken. Briefly apologize and offer the patient another time or day.`,
        alternatives: []
      };
    }
    throw err;
  }

  if (rows.length === 0) {
    // Conflict row exists at the SAME time → idempotent: return the existing booking.
    const { rows: [cur] } = await pool.query(
      // DAY-SCOPED, and it has to be. This re-read used to rely on
      // uniq_active_patient_doctor guaranteeing exactly ONE booked row per
      // patient+doctor, so `LIMIT 1` with no ORDER BY was unambiguous. Migration
      // 013 relaxes that to one per DAY: a patient mid-course legitimately holds
      // several. Without this filter the query returns an ARBITRARY sitting, and
      // the caller confirms that date aloud — a booking claim about the wrong day,
      // from the one path built to be safely idempotent.
      `SELECT id, appointment_time FROM appointments
        WHERE clinic_id = $1 AND patient_id = $2 AND doctor_id = $3
          AND status = 'booked'
          AND (appointment_time AT TIME ZONE 'Asia/Kolkata')::date
            = (($4::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date
        LIMIT 1`,
      [clinicId, patient.id, doctor.id, requestedDate.toISOString()]
    );
    if (!cur) {
      // Row vanished between the upsert and this read (cancelled mid-call) — rare;
      // ask for a clean retry rather than guessing.
      return {
        success: false,
        fail_kind: 'state_changed',
        error_message: 'Booking state just changed — please confirm the time with the patient and book again.',
        alternatives: []
      };
    }
    // LOG EVERY OUTCOME. Until 2026-07-27 all three success paths returned in
    // silence — the tool's only console lines were Google-Calendar, which is off
    // by default. So a booking could happen, or be found already present, and
    // leave no trace anywhere. That silence is what made the d487e311
    // investigation take four passes: "no booking log" was read as "no booking",
    // and it meant nothing at all. An outcome that is not logged is an outcome
    // nobody can debug.
    console.log(`[BOOKING] idempotent — ${doctor.name} already booked for this patient at ${new Date(cur.appointment_time).toISOString()} (appt ${cur.id})`);
    return {
      success: true,
      appointment_id: cur.id,
      idempotent: true,
      confirmation_text: `Yeh appointment pehle se book hai ${doctor.name} ke saath.`,
      doctor_name: doctor.name,
      doctor_specialty: doctor.specialty,
      appointment_time: cur.appointment_time,
      walk_in: avail.is_walk_in
    };
  }

  const appt = rows[0];
  if (!appt.inserted) {
    // The desk's action log (module 6): a same-day move by Ritu. Best-effort.
    await appointmentEvents.recordAppointmentEvent(pool, { clinicId, appointmentId: appt.id, action: 'moved', actor: 'ritu', channel: appointmentEvents.channelOf(context), note: appointmentEvents.noteOf(context),
      before: { appointment_time: appt.moved_from, doctor: doctor.name }, after: { appointment_time: appt.appointment_time, doctor: doctor.name } });
    // Existing row MOVEd to the new time (reminder/confirm flags reset in-statement).
    console.log(`[BOOKING] rescheduled — ${doctor.name}, ${appt.moved_from ? new Date(appt.moved_from).toISOString() : '(unknown)'} -> ${new Date(appt.appointment_time).toISOString()} (appt ${appt.id})`);
    return {
      success: true,
      appointment_id: appt.id,
      action: 'rescheduled',
      moved_from: appt.moved_from,
      appointment_time: appt.appointment_time,
      confirmation_text: `Appointment ${doctor.name} ke saath naye time par set kar di.`,
      doctor_name: doctor.name,
      doctor_specialty: doctor.specialty,
      walk_in: avail.is_walk_in
    };
  }

  // Google Calendar create. Fail-soft on an OUTAGE (Postgres is the source of
  // truth), but authoritative on a real CONFLICT: the calendar can hold slots
  // the DB never saw (e.g. booked by staff through another channel), so a
  // genuine conflict means we'd be double-booking. In that case roll back the
  // row we just inserted and ask the LLM to offer a different time — never
  // confirm a slot that's actually taken.
  let calendarEventId = null;
  try {
    // Calendar is OFF by default (clinic uses the DB, not Google Calendar) —
    // skips the ~2.3s freebusy+insert. An injected calendar (tests) always wins.
    const cal = context.calendar || (process.env.ENABLE_GOOGLE_CALENDAR === 'true' ? require('../calendar') : null);
    if (cal && typeof cal.bookAppointment === 'function') {
      const result = await cal.bookAppointment({
        patientName: patient.name,
        phone: context.patientPhone,
        reason: reason || '',
        dateTime: requestedDate
      });
      if (result && result.success && result.eventId) {
        calendarEventId = result.eventId;
        await pool.query(
          `UPDATE appointments SET google_calendar_event_id = $1, updated_at = NOW() WHERE id = $2`,
          [calendarEventId, appt.id]
        );
      } else if (result && result.code === 'slot_conflict') {
        // Real conflict the DB availability check missed → undo the insert.
        await pool.query(`DELETE FROM appointments WHERE id = $1`, [appt.id]);
        console.warn(`[TOOL book_appointment] Calendar conflict at ${requestedDate.toISOString()} — rolled back DB row ${appt.id}; offering an alternative.`);
        return {
          success: false,
          error_message: `That ${timeInTz(requestedDate, timezone)} slot with ${doctor.name} was just taken. Briefly apologize and offer the patient another time or day.`,
          alternatives: []
        };
      } else {
        // Outage / calendar not configured — keep the booking, mirror later.
        console.warn(`[TOOL book_appointment] Calendar mirror pending for DB row ${appt.id} (calendar unavailable): ${result && result.error}`);
      }
    }
  } catch (err) {
    // A throw here is treated as an outage, not a conflict — keep the booking.
    console.warn(`[TOOL book_appointment] Calendar create threw; DB row ${appt.id} kept, mirror pending: ${err.message}`);
  }

  // The desk's action log: written only once the booking is final — a
  // calendar conflict above DELETEs the row, and an events row referencing it
  // made that DELETE fail (FK) and the tool report success for a taken slot
  // (audit 2026-09-18; GitHub gate case [8] since 46d8231).
  await appointmentEvents.recordAppointmentEvent(pool, { clinicId, appointmentId: appt.id, action: 'booked', actor: 'ritu', channel: appointmentEvents.channelOf(context), note: appointmentEvents.noteOf(context),
    after: { appointment_time: appt.appointment_time, doctor: doctor.name, reason: reason || null } });
  console.log(`[BOOKING] created — ${doctor.name} at ${new Date(appt.appointment_time).toISOString()} (appt ${appt.id}${calendarEventId ? ', gcal ' + calendarEventId : ''})`);
  return {
    success: true,
    appointment_id: appt.id,
    patient_id: patient.id,
    doctor_name: doctor.name,
    doctor_specialty: doctor.specialty,
    appointment_time: appt.appointment_time,
    google_calendar_event_id: calendarEventId,
    walk_in: avail.is_walk_in,
    confirmation_text: `Appointment confirmed: ${doctor.name} (${doctor.specialty}) on ${isoDateInTz(requestedDate, timezone)} at ${timeInTz(requestedDate, timezone)}.`
  };
}

module.exports = { schema, execute };
