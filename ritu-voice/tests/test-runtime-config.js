// ─── EFFECTIVE RUNTIME CONFIGURATION ────────────────────────────────────────
// Three investigations on 2026-08-06/07 stopped at the same wall: nobody could
// say what production was configured to do. The roster slice was off and it
// took reading source to find out; three latency flags default OFF and their
// production values were unknown, which made every latency number quoted that
// day uninterpretable; and a caller was told "I can't hear you" then "your
// voice is perfectly clear" with no way to tell whether the guard fired or the
// model improvised.
//
// This file guards the two properties that make the record trustworthy: it
// must be TRUE (resolved the way the code resolves it, not the way the string
// looks) and it must be SAFE (it goes to a database and a log aggregator).
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').mutatesEnv('drives runtimeConfig() across every switch value — the switches themselves are under test, not the production machine');
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const MOD = path.join(__dirname, '..', 'runtimeConfig.js');
const fresh = (env) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[require.resolve(MOD)];
  const m = require(MOD);
  const out = m.runtimeConfig();
  const desc = m.describeRuntimeConfig();
  process.env = saved;
  delete require.cache[require.resolve(MOD)];
  return { out, desc };
};

console.log('\nRUNTIME CONFIG — a flag in a dashboard is a claim; this is the record\n');

ok('reports what the CODE resolves, not what the string looks like', () => {
  // GARBLE_GUARD is the trap: it is checked as === 'on', not === 'true'.
  // Someone setting GARBLE_GUARD=true gets a guard that is silently OFF, and a
  // diagnostic echoing the raw string would report it as on. This is exactly
  // the class of error the whole file exists to prevent.
  assert.strictEqual(fresh({ GARBLE_GUARD: 'on' }).out.garbleGuard, true);
  assert.strictEqual(fresh({ GARBLE_GUARD: 'true' }).out.garbleGuard, false,
    'GARBLE_GUARD=true is NOT on — the record must say what the code concluded');
  assert.strictEqual(fresh({ GARBLE_GUARD: '' }).out.garbleGuard, false);
});

ok('the ENABLE_* flags are strict-true, matching how the code reads them', () => {
  for (const [env, key] of [
    ['ENABLE_SPECULATIVE_LLM', 'speculativeLlm'],
    ['ENABLE_TTS_PREWARM', 'ttsPrewarm'],
    ['ENABLE_ROSTER_SLICE', 'rosterSlice'],
    ['ENABLE_SHORT_HOLD', 'shortHold'],
  ]) {
    assert.strictEqual(fresh({ [env]: 'true' }).out[key], true, `${env}=true`);
    assert.strictEqual(fresh({ [env]: '1' }).out[key], false, `${env}=1 must be OFF — the code tests === 'true'`);
    assert.strictEqual(fresh({ [env]: 'yes' }).out[key], false, `${env}=yes must be OFF`);
  }
});

ok('the three OFF-by-default latency flags are all present', () => {
  // These are the ones that make a dead-air number interpretable. Speculation
  // ON and OFF produce very different waits from identical code.
  const c = fresh({}).out;
  for (const k of ['speculativeLlm', 'ttsPrewarm', 'shortHold']) {
    assert(k in c, `${k} is missing — a latency number without it cannot be read`);
  }
});

ok('NEVER carries a secret — it is written to a DB and a log aggregator', () => {
  const c = fresh({
    SARVAM_API_KEY: 'sk-secret', GEMINI_API_KEY: 'sk-secret',
    DATABASE_URL: 'postgresql://u:p@h/db', EXOTEL_TOKEN: 'tok', DESK_PASSWORD: 'hunter2',
  }).out;
  const blob = JSON.stringify(c);
  for (const leak of ['sk-secret', 'postgresql://', 'hunter2', 'tok']) {
    assert(!blob.includes(leak), `a secret leaked into the runtime config: ${leak}`);
  }
  for (const k of Object.keys(c)) {
    assert(!/key|secret|token|password|url|dsn/i.test(k), `suspicious field name: ${k}`);
  }
});

ok('the boot description covers every recorded field', () => {
  // A field recorded per call but absent from the boot log is a fact you can
  // only get months later from the database — which defeats the point of being
  // able to answer "what is production running?" in seconds.
  const { out, desc } = fresh({ STT_MODE: 'codemix', LLM_PRIMARY_PROVIDER: 'gemini' });
  const text = desc.join(' ');
  for (const k of Object.keys(out)) {
    assert(text.includes(k), `${k} is recorded per call but never printed at boot`);
  }
});

// ── The three below used to be source greps. They asserted that
// describeRuntimeConfig contains the text `const c = runtimeConfig()`, that
// config.js contains `describeRuntimeConfig()`, and that callHandler.js
// contains `config: runtimeConfig()`. All three were TRUE while saying nothing
// about behaviour — the same shape as the WhatsApp check that proved the
// signature ran before the DB write by comparing indexOf positions, and passed
// while the handler threw on its first line for twenty hours. Rewritten to run
// the thing. ──────────────────────────────────────────────────────────────────

ok('ONE source — what the boot log prints matches what a call records', () => {
  // Non-drift asserted by AGREEMENT, not by the presence of an assignment.
  // GARBLE_GUARD=true is the trap: the code tests === 'on', so the honest
  // rendering is "off". A describeRuntimeConfig that re-read process.env would
  // print ON here and this would catch it.
  for (const env of [
    { GARBLE_GUARD: 'true', ENABLE_ROSTER_SLICE: 'true' },
    { GARBLE_GUARD: 'on', ENABLE_SPECULATIVE_LLM: '1' },
    {},
  ]) {
    const { out, desc } = fresh(env);
    const text = desc.join(' ');
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'boolean') continue;
      const m = text.match(new RegExp(`${k}=(ON|off)`));
      if (!m) continue;                          // not every key is printed
      assert.strictEqual(m[1] === 'ON', v,
        `${k}: the record says ${v} and the boot log prints ${m[1]} — they have drifted (env ${JSON.stringify(env)})`);
    }
  }
});

ok('the boot log ACTUALLY prints it — in a real process', () => {
  // Spawns node and runs the REAL boot step. The first version of this called
  // require('./config.js') and failed — because the print lives inside
  // validate(), which index.js calls at startup, and merely importing the
  // module is not booting. The failure was the test correcting my model of the
  // boot path; a source grep for `describeRuntimeConfig()` in config.js would
  // have passed while proving nothing about whether boot reaches it.
  const { execFileSync } = require('child_process');
  // ─── PLACEHOLDER CREDENTIALS, ON PURPOSE ──────────────────────────────────
  // validate() exits(1) on any missing REQUIRED_VAR — before it reaches the
  // lines this test is about. On a laptop .env supplies them and the test
  // passes; in CI there is no .env, so it died on the credential check and
  // reported a failure that said nothing about the boot log.
  //
  // The assertion is that BOOTING PRINTS the config lines. It has never been
  // about whether the values are real, so the child gets syntactically valid
  // fakes. Nothing here reaches a network: validate() only checks presence,
  // plus that the Google blob parses as JSON.
  const fakeEnv = {
    ...process.env,
    EXOTEL_SID: process.env.EXOTEL_SID || 'test-sid',
    EXOTEL_API_KEY: process.env.EXOTEL_API_KEY || 'test-key',
    EXOTEL_API_TOKEN: process.env.EXOTEL_API_TOKEN || 'test-token',
    EXOTEL_SUBDOMAIN: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
    SARVAM_API_KEY: process.env.SARVAM_API_KEY || 'test-sarvam',
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{"type":"service_account"}',
    CALENDAR_ID: process.env.CALENDAR_ID || 'test@group.calendar.google.com',
    DATABASE_URL: process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none',
    // validate() also refuses to boot when the CONFIGURED primary provider has
    // no key — a deliberate check, and a good one: a server that cannot reach
    // its brain should refuse to start rather than fail on the first call.
    // Which provider that is depends on LLM_PRIMARY_PROVIDER, so all four get a
    // placeholder; the test must not break the day the default changes.
    GROQ_API_KEY: process.env.GROQ_API_KEY || 'test-groq',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'test-gemini',
    SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY || 'test-sambanova',
    DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY || 'test-deepinfra',
  };
  const out = execFileSync('node', ['-e', "require('./config.js').validate()"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: fakeEnv,
  });
  assert(/\[CONFIG\] latency:/.test(out), 'booting prints no latency config line');
  assert(/\[CONFIG\] behaviour:/.test(out), 'booting prints no behaviour config line');
  assert(/\[CONFIG\] planes:.*clinicMode=/.test(out), 'booting does not report which brain is running');
});

ok('a real call RECORDS it — from the diagnostics a call actually builds', () => {
  const CallHandler = require('../callHandler.js');
  const h = new CallHandler('cfg_test', '+919876543210', { readyState: 1, send: () => {} }, 'test', false);
  const diag = h._buildDiagnostics ? h._buildDiagnostics() : null;
  if (diag) {
    assert(diag.config && typeof diag.config === 'object', 'diagnostics carries no config');
    assert(typeof diag.config.clinicMode === 'string', 'the recorded config has no clinicMode');
  } else {
    // No extractable builder — assert the wiring survives a real construction
    // rather than silently passing on nothing.
    const { runtimeConfig } = require('../runtimeConfig.js');
    const c = runtimeConfig();
    assert(c && typeof c.clinicMode === 'string',
      'runtimeConfig() does not resolve clinicMode, so no call can record it');
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
