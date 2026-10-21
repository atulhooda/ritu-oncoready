// ═══════════════════════════════════════════════════════════════════════════
// WHICH SCHEDULED JOBS ARE ARMED — one definition, two consumers.
//
// scheduler.js gates each job on these; runtimeConfig.js records the resolved
// values on every call. They must not drift, so neither one owns the rule:
// this module does. The same reason tools/utils/offerWindow.js exists.
//
// THE DEFAULTS ARE NOT UNIFORM. A job that does damage fails closed; a job
// that works fails open, because a reminder that silently stops is discovered
// by the clinic's patients rather than by us. See scheduler.js's header for
// the no-show story that produced this split.
//
// No imports. This is read at boot, per call, and inside tests.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const JOB_FLAGS = Object.freeze({
  reminder:   { env: 'REMINDER_JOB',    defaultOn: true },
  followup:   { env: 'FOLLOWUP_JOB',    defaultOn: true },
  missedCall: { env: 'MISSED_CALL_JOB', defaultOn: true },
  // The only default-OFF job: appointments.confirmed has no production writer,
  // so it marks attending patients as no-shows. Armed only after the desk
  // attendance writer ships.
  noShow:     { env: 'NOSHOW_JOB',      defaultOn: false },
  // The outbox (migration 020): rows the desk queued (a doctor's day off,
  // staff callback alerts). Fails open like the reminder — a queue that
  // silently stops draining is found by patients.
  outbox:     { env: 'OUTBOX_JOB',      defaultOn: true },
});

/**
 * Resolve one job flag. Accepts on/true and off/false in any case; anything
 * else — including unset — takes that job's own default.
 *
 * Reads process.env at CALL time, never at module load, so a test can flip a
 * flag and drive the job in the same process. A gate nothing can drive is the
 * same class of thing as the bug it guards.
 */
function jobEnabled(name, defaultOn) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return defaultOn;
}

/** All five, resolved. What the boot log prints and what the call records. */
function jobStates() {
  const out = {};
  for (const [key, f] of Object.entries(JOB_FLAGS)) out[key] = jobEnabled(f.env, f.defaultOn);
  return out;
}

/**
 * How many minutes before an appointment its reminder goes out.
 *
 * Lives here, not in db.js, for the same reason the job flags do: db.js runs
 * the query and runtimeConfig.js records what the query used, and a second
 * parse of the same variable — with its own copy of the 1440 default — is
 * precisely how those two drift apart.
 *
 * Default 1440 reproduces the hardcoded 23–25 hour window this replaced.
 */
function reminderLeadMinutes() {
  const n = parseInt(process.env.REMINDER_LEAD_MINUTES || '1440', 10);
  return Number.isFinite(n) && n > 0 ? n : 1440;
}

module.exports = { JOB_FLAGS, jobEnabled, jobStates, reminderLeadMinutes };
