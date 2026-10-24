#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WHEN THE CLINIC KEEPS CANCELLATION FOR ITSELF, THREE THINGS MUST HOLD.
//
// Skin Essence's setup form reserves cancel and reschedule for its staff
// (Q52). Ritu takes the request; she never performs it and never says it is
// done.
//
// A PROMPT LINE IS NOT A MECHANISM, which is the whole reason this has three
// layers. The prompt does not merely gain a prohibition — the rules and the two
// sentinel definitions are NOT EMITTED AT ALL. A prompt carrying both "here is
// how to cancel" and "never cancel" leaves the model correct either way, and
// that exact shape has bitten this file twice already: the empty-roster "offer
// the soonest" against "never offer", and the Hinglish "KABHI nahi" against a
// Hinglish example. A model cannot misuse a token it was never taught.
//
// But it can still invent one, so the sentinel handler refuses; and the handler
// can be bypassed by the legacy brain, so the tool refuses at the last point
// before a write.
//
// It defaults ON. Clinics already running use cancellation and it works;
// switching it off for everyone to serve one clinic's form would break them,
// the same asymmetry the scheduler gates use.
//
// Run:            node tests/test-cancel-staff-only.js
// Prove it fails: MUTANT=MUT-PROMPT-ONLY node tests/test-cancel-staff-only.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('AGENT_MAY_CANCEL', null, 'drives the switch from its code DEFAULT (unset) through off — the switch itself is under test');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('assertion is async — resolve before calling ok()');
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const MUTANT = process.env.MUTANT || null;
if (MUTANT) console.log(`  [MUTANT] ${MUTANT} — only the prompt is gated\n`);

console.log('\nCANCEL / RESCHEDULE — staff only, in three layers\n');

// config.agentMayCancel is read at module load, so each configuration needs its
// own process — the same reason the emergency-v2 test spawns children.
function inChild(env, code) {
  const out = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, SKIP_BOOT_AUDIO: '1', ...env }, encoding: 'utf8', cwd: process.cwd(),
  });
  // Requiring these modules prints dotenv and DB banners, and they do not all
  // arrive before the payload. Take the LAST balanced {...} rather than the last
  // line — the first version split on newlines and parsed a banner.
  const m = out.match(/\{[^{}]*\}(?![\s\S]*\{[^{}]*\})/);
  if (!m) throw new Error(`no JSON in child output: ${out.slice(-200)}`);
  return m[0];
}

// ── [1] LAYER ONE — the model is not taught what it may not do ───────────
const promptOff = inChild({ AGENT_MAY_CANCEL: 'off' }, `
  const p = require('./brain-lean.js').buildSystemPrompt({}, {});
  process.stdout.write(JSON.stringify({
    update: /UPDATE_APPOINTMENT/.test(p),
    cancel: /CANCEL_APPOINTMENT/.test(p),
    staffRule: /clinic staff hi karte hain/.test(p),
    // The PROPERTY: with rescheduling reserved for staff, a caller may still
    // correct the time of a booking made seconds ago — SAME DAY ONLY, via a
    // BOOK re-emit the upsert turns into a move. The first version pinned the
    // old sentence ("PHIR SE emit … MOVE kar dega"), which was rewritten when
    // migration 013 made a cross-day re-emit an INSERT; the wording changed,
    // the guarantee did not.
    // [^] not [\\s\\S]: this code is a TEMPLATE LITERAL handed to node -e, and
    // the literal eats the backslash before the child sees it — the regex
    // arrived as [sS]{0,240} and could never span the Devanagari between.
    sameCall: /SIRF USI DIN ka time[^]{0,240}BOOK_APPOINTMENT phir se emit/i.test(p),
  }));`);
const off = JSON.parse(promptOff);

ok('the prompt never mentions UPDATE_APPOINTMENT', () => {
  assert.strictEqual(off.update, false, 'the reschedule sentinel is still taught, including its worked example');
});
ok('the prompt never mentions CANCEL_APPOINTMENT', () => {
  assert.strictEqual(off.cancel, false, 'the cancel sentinel is still taught');
});
ok('it says who does handle it, instead of just going silent', () => {
  assert.strictEqual(off.staffRule, true, 'no staff-only rule — the model is left to improvise');
});
ok('the SAME-CALL correction survives (a different act entirely)', () => {
  assert.strictEqual(off.sameCall, true,
    'rule 7(a) went too — a caller changing a booking made thirty seconds ago is not reaching into last week\'s appointment');
});

const promptOn = JSON.parse(inChild({}, `
  const p = require('./brain-lean.js').buildSystemPrompt({}, {});
  process.stdout.write(JSON.stringify({
    update: /UPDATE_APPOINTMENT:\\{/.test(p),
    cancel: /CANCEL_APPOINTMENT:\\{/.test(p),
    staffRule: /clinic staff hi karte hain/.test(p),
  }));`));
ok('a clinic that never asked for this is untouched (default ON)', () => {
  assert.strictEqual(promptOn.update, true, 'the reschedule sentinel vanished for everyone');
  assert.strictEqual(promptOn.cancel, true, 'the cancel sentinel vanished for everyone');
  assert.strictEqual(promptOn.staffRule, false, 'a clinic that allows cancellation is being told it does not');
});

// ── [2] LAYER TWO — the handler refuses an invented sentinel ─────────────
// MUT-PROMPT-ONLY strips the handler and tool guards, leaving the prompt gate
// alone — the "we told it not to" design this replaces.
const layer2 = inChild({ AGENT_MAY_CANCEL: 'off', MUT: MUTANT || '' }, `
  const fs = require('fs');
  const src = fs.readFileSync('brain-lean.js', 'utf8');
  const promptOnly = process.env.MUT === 'MUT-PROMPT-ONLY';
  // Since 2026-09-15 the move guard reads the RESCHEDULE switch (unset → follows cancel; module 6).
  const guarded = /if \\(move && !config\\.agentMayReschedule\\)/.test(src)
               && /if \\(cancel && !config\\.agentMayCancel\\)/.test(src);
  process.stdout.write(JSON.stringify({ guarded: promptOnly ? false : guarded }));`);
ok('an invented UPDATE_APPOINTMENT is suppressed at the handler', () => {
  assert.strictEqual(JSON.parse(layer2).guarded, true,
    'the handlers trust the prompt — a model can emit a token it was never taught');
});

// ── [3] LAYER THREE — the tool refuses, whoever calls it ────────────────
const layer3 = inChild({ AGENT_MAY_CANCEL: 'off', MUT: MUTANT || '' }, `
  if (process.env.MUT === 'MUT-PROMPT-ONLY') { process.stdout.write(JSON.stringify({ fail_kind: null })); }
  else {
    const u = require('./tools/updateAppointment.js');
    const fn = u.execute || u.updateAppointmentTool.execute;
    fn({ appointment_id: 'x', new_datetime: '2026-09-01T10:00:00+05:30' }, {})
      .then(r => process.stdout.write(JSON.stringify({ fail_kind: r && r.fail_kind })))
      .catch(e => process.stdout.write(JSON.stringify({ threw: e.message })));
  }`);
ok('the tool itself refuses, so the legacy brain cannot route around it', () => {
  assert.strictEqual(JSON.parse(layer3).fail_kind, 'staff_only',
    'updateAppointment would still move the row if reached by any other caller');
});
const layer3On = inChild({}, `
  const u = require('./tools/updateAppointment.js');
  const fn = u.execute || u.updateAppointmentTool.execute;
  fn({ appointment_id: 'x', new_datetime: '2026-09-01T10:00:00+05:30' }, {})
    .then(r => process.stdout.write(JSON.stringify({ fail_kind: r && r.fail_kind })))
    .catch(e => process.stdout.write(JSON.stringify({ reached: true })));`);
ok('with cancellation allowed the tool runs its real logic', () => {
  const r = JSON.parse(layer3On);
  assert.notStrictEqual(r.fail_kind, 'staff_only', 'the policy refusal fires at a clinic that allows cancellation');
});

// ── [4] What the caller actually hears ──────────────────────────────────
const { cannedLine } = require('../brain-lean.js');
ok('the caller is told who will do it — never that it is done', () => {
  for (const lang of ['gu-IN', 'hi-IN', 'en-IN']) {
    const line = cannedLine('cancelPolicy', { languageCode: lang });
    assert.ok(line, `no cancelPolicy line for ${lang}`);
    assert.doesNotMatch(line, /कर दिया|રદ કરી દીધ|cancelled\b/i,
      `${lang} claims the cancellation happened: ${line}`);
  }
});
ok('the line exists in all 11 languages', () => {
  const { PATTERNS } = require('../medicalAdviceGuard.js'); // any 11-language table for the list
  const langs = ['hi-IN','mr-IN','en-IN','kn-IN','pa-IN','ta-IN','te-IN','bn-IN','gu-IN','ml-IN','od-IN'];
  for (const l of langs) {
    assert.ok(cannedLine('cancelPolicy', { languageCode: l }), `missing ${l}`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED — this test proves nothing.\n`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
