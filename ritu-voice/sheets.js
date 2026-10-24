const { google } = require('googleapis');
const config = require('./config');

let sheetsClient = null;

// ─── ONE SHEET PER CLINIC, NOT ONE SHEET FOR THE FLEET ──────────────────────
// This was a bare string literal — the demo clinic's spreadsheet id, compiled
// into the product. crm.logCall runs at the end of EVERY call
// (callHandler.js), so with a second clinic deployed, both clinics' patient
// names, phone numbers and call reasons land in the same Google Sheet.
//
// Separate Railway projects do not help. Silo isolates the database and the
// process; it cannot isolate a constant. This is the one place in the system
// where running two clinics produces genuine cross-clinic data commingling in
// an external service — and they would also contend on one document's write
// quota.
//
// UNSET IS OFF, DELIBERATELY. A clinic that has not been given a sheet should
// log nothing rather than fall back to somebody else's spreadsheet. The old
// literal is not kept as a default for exactly that reason: a default here is
// the bug.
const SPREADSHEET_ID = (process.env.GOOGLE_SHEET_ID || '').trim();
const SHEET_NAME = process.env.GOOGLE_SHEET_TAB || 'Calls';

// True when this deployment has no sheet of its own. Every exported entry point
// checks it FIRST, so an unconfigured clinic writes nowhere instead of writing
// somewhere wrong. Warned once, not per call — a clinic that never wanted Sheets
// should not have its logs filled with the fact.
let _warnedNoSheet = false;
function sheetsDisabled() {
  if (SPREADSHEET_ID) return false;
  if (!_warnedNoSheet) {
    _warnedNoSheet = true;
    console.warn('[SHEETS] GOOGLE_SHEET_ID is not set — call logging to Google Sheets is OFF for this clinic. The database record is unaffected.');
  }
  return true;
}

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const credentials = JSON.parse(config.google.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
// Column order matters — COL_MAP below must stay in sync with this list.
const HEADERS = [
  'Call SID',             // A
  'Date & Time (IST)',    // B
  'Patient Name',         // C
  'Phone Number',         // D
  'Returning Patient',    // E
  'Language',             // F
  'Visit Reason',         // G
  'Appointment Time',     // H
  'Booked',               // I
  'Failure Reason',       // J
  'Duration (sec)',       // K
  'Emergency',            // L
  'Call Status',          // M
  'WhatsApp Sent',        // N
  'Appt Confirmed',       // O
  'No Show',              // P
  'Followup Sent',        // Q
  'Slot Attempts',        // R
  'Conversion Time (sec)' // S
];

const COL_MAP = {
  'WhatsApp_Sent':         'N',
  'Appointment_Confirmed': 'O',
  'No_Show':               'P',
  'Follow_Up_Sent':        'Q'
};

// ─── IST DATE FORMATTER ───────────────────────────────────────────────────────
function toIST(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

// ─── HEADERS INIT ─────────────────────────────────────────────────────────────
async function initializeHeaders() {
  if (sheetsDisabled()) return;
  try {
    const sheets = getSheetsClient();

    // Check if the 'Calls' sheet tab exists — create it if not
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existing = meta.data.sheets.map(s => s.properties.title);
    if (!existing.includes(SHEET_NAME)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
        }
      });
      console.log(`✓ Created sheet tab: ${SHEET_NAME}`);
    }

    // Write headers only if row 1 is empty
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:S1`,
    });

    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:S1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADERS] }
      });
      console.log('✓ Google Sheets headers initialized');
    } else {
      console.log('✓ Google Sheets ready');
    }
  } catch (err) {
    console.error('Failed to initialize sheets headers:', err.message);
  }
}

// ─── BATCH WRITE ──────────────────────────────────────────────────────────────
let writeQueue = [];
let batchTimeout = null;

async function processBatch() {
  if (writeQueue.length === 0) return;
  const currentBatch = [...writeQueue];
  writeQueue = [];

  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:S`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: currentBatch }
    });
  } catch (err) {
    console.error('Batch append error:', err.message);
    if (err.code === 429) {
      setTimeout(() => {
        writeQueue = [...currentBatch, ...writeQueue];
        processBatch();
      }, 5000);
    }
  }
}

function formatRow(callData) {
  return [
    callData.callSid || '',                                              // A
    toIST(new Date()),                                                   // B
    callData.patientName || 'Unknown',                                   // C
    callData.callerPhone || '',                                          // D
    callData.isReturning ? 'Yes' : 'No',                                 // E
    callData.languageDetected || 'Hindi',                                // F
    callData.reason || '',                                               // G
    callData.appointmentTime ? toIST(callData.appointmentTime) : '',     // H
    callData.appointmentBooked ? 'Yes' : 'No',                           // I
    callData.bookingFailureReason || '',                                  // J
    callData.durationSeconds || 0,                                       // K
    callData.emergencyDetected ? 'Yes' : 'No',                           // L
    callData.status || 'completed',                                      // M
    'No',                                                                // N - WhatsApp Sent
    'No',                                                                // O - Appt Confirmed
    'No',                                                                // P - No Show
    'No',                                                                // Q - Followup Sent
    callData.slotAttempts || 0,                                          // R
    callData.conversionTimeSec || ''                                     // S
  ];
}

async function appendCallRecord(callData) {
  if (sheetsDisabled()) return;
  writeQueue.push(formatRow(callData));
  if (writeQueue.length >= 10) {
    if (batchTimeout) clearTimeout(batchTimeout);
    processBatch();
  } else {
    if (batchTimeout) clearTimeout(batchTimeout);
    batchTimeout = setTimeout(processBatch, 500);
  }
}

// ─── ROW UPDATER ──────────────────────────────────────────────────────────────
let rowCache = null;
let lastCacheTime = 0;

async function getRowMap() {
  if (rowCache && (Date.now() - lastCacheTime < 5 * 60000)) return rowCache;
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:A`
    });
    const rows = res.data.values || [];
    rowCache = new Map();
    rows.forEach((row, index) => {
      if (row[0]) rowCache.set(row[0], index + 1);
    });
    lastCacheTime = Date.now();
    return rowCache;
  } catch (err) {
    console.error('getRowMap error:', err.message);
    return new Map();
  }
}

async function updateRow(callSid, updates) {
  if (sheetsDisabled()) return;
  try {
    const map = await getRowMap();
    const rowIndex = map.get(callSid);
    if (!rowIndex) return;

    const sheets = getSheetsClient();
    const data = [];

    for (const [key, val] of Object.entries(updates)) {
      if (COL_MAP[key]) {
        data.push({
          range: `${SHEET_NAME}!${COL_MAP[key]}${rowIndex}`,
          values: [[val ? 'Yes' : 'No']]
        });
      }
    }

    if (data.length === 0) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data }
    });
  } catch (err) {
    console.error('Sheet updateRow error:', err.message);
  }
}

module.exports = { appendCallRecord, updateRow, initializeHeaders };
