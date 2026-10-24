const { google } = require('googleapis');
const config = require('./config');

// ─── CACHED CALENDAR CLIENT ──────────────────────────────────────────────────
// Create auth client once at module load, not per function call
let _calendarClient = null;

function getCalendarClient() {
  if (_calendarClient) return _calendarClient;

  const credentials = JSON.parse(config.google.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  _calendarClient = google.calendar({ version: 'v3', auth });
  return _calendarClient;
}

// ─── CHECK AVAILABILITY ──────────────────────────────────────────────────────
async function checkAvailability(dateTime) {
  try {
    const calendar = getCalendarClient();
    const date = new Date(dateTime);
    const endTime = new Date(date.getTime() + 30 * 60000); // 30 min slot

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: date.toISOString(),
        timeMax: endTime.toISOString(),
        timeZone: 'Asia/Kolkata',
        items: [{ id: config.google.calendarId }],
      },
    });

    const busy = response.data.calendars[config.google.calendarId].busy;
    return busy.length === 0; // true = available
  } catch (error) {
    console.error('Calendar check error:', error.message);
    return null; // unknown — couldn't read freebusy; do NOT treat as "busy"
  }
}

// ─── BOOK APPOINTMENT (with re-check to prevent race conditions) ─────────────
async function bookAppointment({ patientName, phone, reason, dateTime }) {
  try {
    const calendar = getCalendarClient();
    const date = new Date(dateTime);
    const endTime = new Date(date.getTime() + 30 * 60000);

    // ── Re-check availability right before insert ─────────────────────────────
    // Only a DEFINITIVE busy result blocks the booking. `null` means the
    // freebusy read failed (outage) — Postgres is the source of truth, so we
    // fall through and attempt the insert rather than reporting a false conflict.
    const stillAvailable = await checkAvailability(dateTime);
    if (stillAvailable === false) {
      console.warn(`Slot no longer available at ${dateTime} — calendar shows a real conflict.`);
      return { success: false, code: 'slot_conflict', error: 'Slot no longer available' };
    }

    const event = await calendar.events.insert({
      calendarId: config.google.calendarId,
      requestBody: {
        summary: `Appointment: ${patientName}`,
        description: `Patient: ${patientName}\nPhone: ${phone}\nReason: ${reason}\nBooked by: Engageo AI Receptionist`,
        start: {
          dateTime: date.toISOString(),
          timeZone: 'Asia/Kolkata',
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'Asia/Kolkata',
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },   // 1 hour before
            { method: 'popup', minutes: 1440 },  // 24 hours before
          ],
        },
      },
    });

    console.log(`Calendar event created: ${event.data.id}`);

    return {
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
    };
  } catch (error) {
    console.error('Calendar booking error:', error.message);
    // Transient / config failure — NOT a slot conflict. Caller keeps the DB row.
    return { success: false, code: 'calendar_error', transient: true, error: error.message };
  }
}

// ─── GET NEXT AVAILABLE SLOTS ────────────────────────────────────────────────
async function getNextAvailableSlots(preferredDate) {
  try {
    const calendar = getCalendarClient();
    const date = new Date(preferredDate);
    date.setHours(10, 0, 0, 0); // Start at 10 AM

    const endOfDay = new Date(date);
    endOfDay.setHours(18, 0, 0, 0); // End at 6 PM

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: date.toISOString(),
        timeMax: endOfDay.toISOString(),
        timeZone: 'Asia/Kolkata',
        items: [{ id: config.google.calendarId }],
      },
    });

    const busy = response.data.calendars[config.google.calendarId].busy;
    const slots = [];
    let current = new Date(date);

    while (current < endOfDay) {
      const slotEnd = new Date(current.getTime() + 30 * 60000);
      const isBusy = busy.some(b => {
        const busyStart = new Date(b.start);
        const busyEnd = new Date(b.end);
        return current < busyEnd && slotEnd > busyStart;
      });

      if (!isBusy) {
        slots.push(new Date(current));
      }

      current = slotEnd;
    }

    return slots.slice(0, 3); // Return first 3 available slots
  } catch (error) {
    console.error('Get slots error:', error.message);
    return [];
  }
}

// ─── UPDATE APPOINTMENT (if user reschedules) ─────────────
async function updateAppointment({ eventId, dateTime }) {
  try {
    const calendar = getCalendarClient();
    const date = new Date(dateTime);
    const endTime = new Date(date.getTime() + 30 * 60000);

    const stillAvailable = await checkAvailability(dateTime);
    if (!stillAvailable) {
      console.warn(`Slot not available at ${dateTime} for update.`);
      return { success: false, error: 'Slot not available' };
    }

    const event = await calendar.events.patch({
      calendarId: config.google.calendarId,
      eventId: eventId,
      requestBody: {
        start: { dateTime: date.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Kolkata' }
      }
    });

    console.log(`Calendar event updated: ${event.data.id}`);
    return { success: true, eventId: event.data.id, eventLink: event.data.htmlLink };
  } catch (error) {
    console.error('Calendar update error:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { checkAvailability, bookAppointment, getNextAvailableSlots, updateAppointment };
