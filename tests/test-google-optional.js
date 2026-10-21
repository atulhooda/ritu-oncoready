#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('spawns config.validate() under environments with and without the Google credentials — the requirement itself is under test');
// Google Calendar and the Sheet are optional. Until 2026-09-08 the boot refused
// without CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_JSON even with the mirror off
// (its default) — a clinic that works off the desk had to invent a calendar to
// start. Now the credentials are required only by what uses them.
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };

// config.js loads .env from the working directory at require time, and a
// deleted variable would be refilled from it — so the child runs in a scratch
// directory with no .env (the boot-smoke matrix does the same).
const CONFIG = path.join(__dirname, '..', 'config.js');
const scratch = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'google-optional-'));
const boot = (extra) => {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === null) delete env[k];
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONFIG)}).validate(); console.log('__BOOTED__')`], { cwd: scratch, env, encoding: 'utf8', timeout: 20000 });
  return { booted: /__BOOTED__/.test(r.stdout || ''), out: (r.stdout || '') + (r.stderr || '') };
};
const NO_GOOGLE = { CALENDAR_ID: null, GOOGLE_SERVICE_ACCOUNT_JSON: null, GOOGLE_SHEET_ID: null, ENABLE_GOOGLE_CALENDAR: null };

console.log('\nGOOGLE IS OPTIONAL — required only by what uses it\n');
{ const r = boot(NO_GOOGLE);
  ok('no Google credentials, mirror off, no Sheet → boots', () => assert.ok(r.booted, r.out.slice(-400)));
  ok('...and says so on the boot line', () => assert.match(r.out, /Google: calendar mirror OFF, Sheet OFF/)); }
{ const r = boot({ ...NO_GOOGLE, ENABLE_GOOGLE_CALENDAR: 'true' });
  ok('mirror ON without CALENDAR_ID → refuses, naming the variable and the reason', () => { assert.ok(!r.booted, 'booted'); assert.match(r.out, /CALENDAR_ID — needed because ENABLE_GOOGLE_CALENDAR=true/); }); }
{ const r = boot({ ...NO_GOOGLE, GOOGLE_SHEET_ID: 'sheet-1' });
  ok('Sheet set without the service account → refuses, naming both', () => { assert.ok(!r.booted, 'booted'); assert.match(r.out, /GOOGLE_SERVICE_ACCOUNT_JSON — needed because GOOGLE_SHEET_ID is set/); }); }
{ const r = boot({ ...NO_GOOGLE, ENABLE_GOOGLE_CALENDAR: 'true', CALENDAR_ID: 'cal@group.calendar.google.com', GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account","client_email":"x@y","private_key":""}' });
  ok('mirror ON with both → boots', () => assert.ok(r.booted, r.out.slice(-400))); }
{ const r = boot({ ...NO_GOOGLE, GOOGLE_SHEET_ID: 'sheet-1', GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' });
  ok('a present but malformed service account still refuses', () => { assert.ok(!r.booted, 'booted'); assert.match(r.out, /not valid JSON/); }); }
ok('the booking tool never loads the calendar module with the mirror off', () => {
  const src = require('fs').readFileSync(require.resolve('../tools/bookAppointment.js'), 'utf8');   // SOURCE-TEXT-OK: the lazy require is the guard; behaviour is in test-tool-bookAppointment (real Postgres)
  assert.match(src, /process\.env\.ENABLE_GOOGLE_CALENDAR === 'true' \? require\('\.\.\/calendar'\) : null/);
});
console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
