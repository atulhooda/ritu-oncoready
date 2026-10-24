const db = require('./db');
const { captureRecordingUrl } = require('./exotelRecording');
const { appendCallRecord, updateRow } = require('./sheets');
const { sendConfirmation } = require('./whatsapp');

async function logCall(callData) {
  try {
    console.log('Call summary:', JSON.stringify({
      sid: callData.callSid,
      hasName: !!callData.patientName,   // name itself is PII — kept out of logs
      booked: callData.appointmentBooked,
      duration: callData.durationSeconds
    }, null, 2));

    await db.logCallToDb(callData);

    // ─── KEEP THE AUDIO ─────────────────────────────────────────────────────
    // Fired here because the row now exists to update. Background + retried:
    // Exotel finishes writing the recording after the call ends, so a single
    // fetch at hangup reports "no recording" when it means "not yet".
    //
    // Until now recording_url was written by NOTHING in the server — 28 of 155
    // calls had one, every one fetched by hand after something looked wrong.
    // That is backwards: the calls worth listening to are not knowable in
    // advance, and Exotel's retention clock does not wait for us to notice.
    captureRecordingUrl(db.pool, callData.callSid);

    await appendCallRecord(callData);

    // ── Auto-trigger WhatsApp confirmation after a successful booking ──
    // Uses atomic DB update as a guard to prevent double-sending
    if (callData.appointmentBooked && callData.callerPhone && callData.patientName) {
      const guard = await db.pool.query(
        `UPDATE calls SET whatsapp_sent = true
         WHERE exotel_call_sid = $1 AND whatsapp_sent = false
         RETURNING exotel_call_sid`,
        [callData.callSid]
      );

      if (guard.rowCount > 0) {
        console.log(`[${callData.callSid}] Triggering WhatsApp confirmation...`);
        try {
          await sendConfirmation({
            phone: callData.callerPhone,
            name: callData.patientName,
            appointmentTime: callData.appointmentTime,
            language: callData.languageDetected || 'Hindi'
          });
          // ✅ Update the Google Sheet to reflect WhatsApp was sent
          await updateRow(callData.callSid, { 'WhatsApp_Sent': true });
          console.log(`[${callData.callSid}] WhatsApp confirmation handed to Meta (the [META-WA] line above says template or plain text; the delivery verdict lands on the row) & Sheet updated`);
        } catch (err) {
          console.error('WhatsApp confirmation error (non-fatal):', err.message);
        }
      } else {
        console.log(`[${callData.callSid}] WhatsApp already sent — skipping duplicate.`);
      }
    }

    return callData;
  } catch (error) {
    console.error('CRM log error (non-fatal):', error.message);
    return null;
  }
}

module.exports = { logCall };
