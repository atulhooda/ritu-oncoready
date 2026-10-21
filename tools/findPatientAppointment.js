// ═══════════════════════════════════════════════════════════════════════════
// tools/findPatientAppointment.js
//
// Look up the patient's future booked appointments by phone (the only
// identifier we have at call start). The optional patient_name lets the
// LLM disambiguate when the phone has multiple patient rows (family members
// sharing a number — see schema's UNIQUE (clinic_id, phone, name)).
//
// Returns an array of upcoming booked appointments with doctor name +
// specialty so the LLM can speak them back. Only status='booked' and
// only appointment_time > NOW() are returned.
//
// When name is not provided AND multiple patients exist on the phone, the
// LLM is expected to ask "Aap [name1] hain ya [name2]?" — the tool just
// surfaces both.
//
// Context: { pool, clinicId, patientPhone, currentDatetime (optional) }
// ═══════════════════════════════════════════════════════════════════════════

const { normalizePhone } = require('./utils/phoneNormalizer');

const schema = {
  type: 'function',
  function: {
    name: 'find_patient_appointment',
    description: "Look up existing appointments for the caller's phone number. Use when the patient asks about their appointment ('mera appointment kab tha', 'cancel karna hai', 'time change karna hai'). When multiple patient rows exist on the same phone (family members) the LLM should ask 'Aap [name1] hain ya [name2]?' using the names this tool returns.",
    parameters: {
      type: 'object',
      properties: {
        patient_name: {
          type: 'string',
          description: 'Patient name as stated by caller. Used for disambiguation when multiple patients share the same phone. Omit to return ALL appointments under this phone.'
        }
      }
    }
  }
};

async function execute({ patient_name }, context) {
  if (!context || !context.pool)       throw new Error('find_patient_appointment: context.pool required');
  if (!context.clinicId)               throw new Error('find_patient_appointment: context.clinicId required');
  if (!context.patientPhone)           throw new Error('find_patient_appointment: context.patientPhone required');

  const phone = normalizePhone(context.patientPhone);
  if (!phone) {
    return { appointments: [], distinct_patient_names: [], note: 'Caller phone could not be normalized.' };
  }

  const now = context.currentDatetime ? new Date(context.currentDatetime) : new Date();

  // Pull all FUTURE booked appointments for this phone. Cancelled, completed,
  // no-show, and past appointments are excluded.
  const params = [context.clinicId, phone, now.toISOString()];
  let sql = `
    SELECT a.id           AS appointment_id,
           a.appointment_time,
           a.reason,
           a.status,
           a.google_calendar_event_id,
           p.id           AS patient_id,
           p.name         AS patient_name,
           d.id           AS doctor_id,
           d.name         AS doctor_name,
           d.specialty    AS doctor_specialty
      FROM appointments a
      JOIN patients     p ON a.patient_id = p.id
      JOIN doctors      d ON a.doctor_id  = d.id
     WHERE a.clinic_id        = $1
       AND p.phone            = $2
       AND a.status           = 'booked'
       AND a.appointment_time > $3
  `;
  if (patient_name && patient_name.trim()) {
    params.push(`%${patient_name.trim().toLowerCase()}%`);
    sql += ` AND LOWER(p.name) LIKE $${params.length}`;
  }
  sql += ` ORDER BY a.appointment_time ASC`;

  const { rows: appointments } = await context.pool.query(sql, params);

  // Surface the distinct set of patient names attached to this phone (even
  // those without future appointments) so the LLM can disambiguate when the
  // appointment list is empty or ambiguous.
  const { rows: nameRows } = await context.pool.query(
    `SELECT DISTINCT name FROM patients
      WHERE clinic_id = $1 AND phone = $2 ORDER BY name`,
    [context.clinicId, phone]
  );
  const distinct_patient_names = nameRows.map(r => r.name);

  const ambiguous = !patient_name && distinct_patient_names.length > 1;
  return {
    appointments,
    distinct_patient_names,
    ambiguous,
    note: ambiguous
      ? `Multiple patient names registered on this phone: ${distinct_patient_names.join(', ')}. Ask the patient which one.`
      : null
  };
}

module.exports = { schema, execute };
