#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE TEST ENTRYPOINT THAT DID NOT EXIST
//
// Until 2026-08-14, `npm test` was:
//
//     "test": "echo \\"Error: no test specified\\" && exit 1"
//
// and `.git/hooks/pre-push` contained ZERO references to tests/. Sixty-seven
// test files — many of them mutation-proven this week against real production
// defects — ran only when somebody looped the directory by hand. A regression in
// any of them pushed to production green.
//
// The gate DID check four real things (migration safety, the ritu-evals immune
// suite, boot-smoke, vendor claims) and none of them exercises the call path.
// That is the mechanism by which defects kept reaching production: nothing
// stopped them, so every one had to be found by a human placing a call. See
// docs/ROADMAP.md §2.
//
//     node tools/run-tests.js              # everything, parallel
//     node tools/run-tests.js --serial     # one at a time, readable output
//     node tools/run-tests.js phone drug   # only files matching these
//
// SKIP_BOOT_AUDIO=1 is set for every child. Requiring callHandler otherwise
// makes five Sarvam TTS calls, and — more importantly — leaves sockets open so
// node sits ~12s before exiting. A deploy gate must not be able to fail because
// a speech vendor is slow.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TESTS_DIR = path.join(__dirname, '..', 'tests');
const argv = process.argv.slice(2);
const SERIAL = argv.includes('--serial');
const filters = argv.filter((a) => !a.startsWith('--'));

// A test that hangs must not hang the deploy. Generous, because the real ones
// run in seconds and the cap is a backstop, not a schedule.
const TIMEOUT_MS = parseInt(process.env.TEST_TIMEOUT_MS, 10) || 120000;

// ─── BENCHMARKS ARE NOT REGRESSION TESTS ────────────────────────────────────
// These call external LLM providers many times over and take minutes. They
// answer "which model should we use", not "did this change break something",
// and a deploy must not be blockable by a slow vendor. Excluded from the gate
// and NAMED HERE rather than quietly filtered — a silent cap reads as "we
// covered everything" when we did not.
//
// Run them deliberately:  node tests/test-quad-comparison.js
const BENCHMARKS = {
  'test-quad-comparison.js': '4 Groq models × 6 scenarios — a model-selection benchmark',
  'test-scout-vs-70b.js': 'Scout vs 70B parity — a model-selection benchmark',
};

// ── SOURCE-TEXT RATCHET ─────────────────────────────────────────────────────
// A test that readFileSync()s a production .js file is evidence about source
// text, not behaviour (three of four production defects in four days passed
// such tests — see the memory note "tests-must-run-the-code"). The files that
// already do are listed in tests/source-text-allowlist.txt and are being
// converted; a NEW file that does it fails the gate until it is driven or
// deliberately allow-listed with a reason.
{
  const allow = new Set(fs.readFileSync(path.join(TESTS_DIR, 'source-text-allowlist.txt'), 'utf8')
    .split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean));
  const offenders = fs.readdirSync(TESTS_DIR).filter((f) => /^test-.*\.js$/.test(f))
    .filter((f) => /readFileSync\([^)]*\.js/.test(fs.readFileSync(path.join(TESTS_DIR, f), 'utf8')))
    .filter((f) => !allow.has(f));
  if (offenders.length) {
    console.error('\n  ✗ New test(s) read production SOURCE TEXT instead of driving the code:');
    offenders.forEach((f) => console.error(`      ${f}`));
    console.error('    Drive the code (see tests/test-emergency-probe-parity.js), or add the file to');
    console.error('    tests/source-text-allowlist.txt with a reason.\n');
    process.exit(1);
  }
}

const all = fs.readdirSync(TESTS_DIR)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();
const excluded = all.filter((f) => BENCHMARKS[f]);
const files = all
  .filter((f) => !BENCHMARKS[f])
  .filter((f) => !filters.length || filters.some((q) => f.includes(q)));

if (!files.length) {
  console.error(`No tests matched ${JSON.stringify(filters)}`);
  process.exit(1);
}

const CONC = SERIAL ? 1 : Math.max(2, Math.min(8, os.cpus().length - 1));

function runOne(file, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, SKIP_BOOT_AUDIO: '1', ...extraEnv },
      detached: true,   // own process group: a timeout kills the grandchildren too
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
      out += `\n[run-tests] KILLED after ${TIMEOUT_MS}ms — a test that cannot finish cannot gate.\n`;
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      // An explicit, loud skip is a PASS with a message — several files skip
      // when TEST_DATABASE_URL is absent and say exactly what goes untested.
      // exit 75 (EX_TEMPFAIL) is tests/_bootstrap.js's DECLARED GAP: the file
      // skipped with zero assertions and said what goes untested. Skipped, not passed.
      const skipped = (code === 0 && /⏭\s+SKIP/.test(out)) || code === 75;
      resolve({ file, code: skipped ? 0 : code, out, ms: Date.now() - started, skipped, timedOut });
    });
  });
}

(async () => {
  const t0 = Date.now();
  // ── STEP ZERO: every test loads tests/_bootstrap.js FIRST ──────────────────
  // The bootstrap pins the switches production runs (CLINIC_MODE=lean,
  // READBACK=on, STT_MODE=codemix, every latency flag ON) and reads each pin
  // back through config.js/runtimeConfig.js. A test that does not load it runs
  // a machine production does not run; nothing inside such a test can notice,
  // so the check runs here, over the source, before anything else.
  {
    const { spawnSync } = require('child_process');
    const lint = spawnSync(process.execPath, [path.join(TESTS_DIR, '_bootstrap.js')], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    if (lint.status !== 0) { process.stdout.write(lint.stdout || ''); process.stderr.write(lint.stderr || ''); process.exit(1); }
    process.stdout.write(`  ${String(lint.stdout || '').trim().split('\n').pop()}\n`);
  }
  console.log(`\nRunning ${files.length} test file(s), ${SERIAL ? 'serially' : `${CONC} at a time`}\n`);
  if (excluded.length && !filters.length) {
    console.log('  Not run — benchmarks, deliberately outside the gate:');
    excluded.forEach((f) => console.log(`    ${f} — ${BENCHMARKS[f]}`));
    console.log('');
  }

  const results = [];
  const queue = files.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const r = await runOne(f);
      results.push(r);
      const mark = r.code === 0 ? (r.skipped ? '⏭' : '✓') : '✗';
      process.stdout.write(`  ${mark} ${r.file.padEnd(44)} ${String(r.ms).padStart(6)}ms\n`);
      if (r.code !== 0) {
        // Print the failing detail immediately — a gate whose output you have to
        // go looking for is a gate people bypass.
        const lines = (process.env.VERBOSE_FAIL ? r.out.split('\n') : r.out.split('\n').filter((l) => /✗|FAIL|Error|assert|KILLED/.test(l))).slice(0, 20);
        lines.forEach((l) => process.stdout.write(`      ${l.trim()}\n`));
      }
    }
  }));

  const failed = results.filter((r) => r.code !== 0);
  const skipped = results.filter((r) => r.skipped);

  // ── EVERY PRODUCTION, NOT JUST THE DEMO ───────────────────────────────────
  // tests/_bootstrap.js knows more than one production profile. The suite ran
  // under the demo clinic's switches above; it runs again under each other
  // profile (mutants once is enough — they prove the tests, not the config).
  // PROFILES=demo skips this (local iteration).
  const extraProfiles = process.env.PROFILES === 'demo' ? [] : ['skin-essence'];
  const profileFailed = [];
  if (!failed.length) {
    for (const prof of extraProfiles) {
      console.log(`\n  Profile ${prof}: the same ${files.length} files under that clinic's switches\n`);
      const q = files.slice();
      await Promise.all(Array.from({ length: CONC }, async () => {
        while (q.length) {
          const f = q.shift();
          const r = await runOne(f, { BOOTSTRAP_PROFILE: prof });
          const mark = r.code === 0 ? (r.skipped ? '⏭' : '✓') : '✗';
          process.stdout.write(`  ${mark} ${(f + ' [' + prof + ']').padEnd(60)} ${String(r.ms).padStart(6)}ms\n`);
          if (r.code !== 0) {
            profileFailed.push({ file: f, prof });
            const lines = r.out.split('\n').filter((l) => /✗|FAIL|Error|assert|KILLED|FATAL/.test(l)).slice(0, 6);
            lines.forEach((l) => process.stdout.write(`      ${l.trim()}\n`));
          }
        }
      }));
    }
  }

  // ── MUTANTS ARE PART OF THE GATE ─────────────────────────────────────────
  // Every test that declares MUTANT=MUT-* (in its header or its code) is re-run
  // once per declared mutant; the mutant must EXIT NON-ZERO. Until 2026-09-03
  // these proofs ran once, by hand, at commit time — 27 of them — and a test
  // could silently stop killing its mutant the day after. A survivor fails
  // the gate exactly like a failing test. MUTANTS=off skips (local iteration).
  const survivors = [];
  if (process.env.MUTANTS !== 'off' && !failed.length && !profileFailed.length) {
    const jobs = [];
    // A file whose base run was a DECLARED GAP (skipped: exit 75, or a SKIP
    // with zero assertions) did not run, so its mutants cannot be proven or
    // disproven here — they are listed as not run, never as survivors.
    const skippedFiles = new Set(results.filter((r) => r.skipped).map((r) => r.file));
    const notRun = [];
    for (const f of files) {
      if (skippedFiles.has(f)) { notRun.push(f); continue; }
      const src = fs.readFileSync(path.join(TESTS_DIR, f), 'utf8');
      const names = [...new Set([...src.matchAll(/MUTANT(?:=|\s*===\s*')(MUT-[A-Z0-9-]+)/g)].map((m) => m[1]))];
      for (const n of names) jobs.push({ f, n });
    }
    if (notRun.length) console.log(`\n  Mutants not run — the file itself skipped (declared gap): ${notRun.join(', ')}`);
    if (jobs.length) {
      console.log(`\n  Mutants: ${jobs.length} declared across ${new Set(jobs.map((j) => j.f)).size} files — each must go RED\n`);
      const q = jobs.slice();
      const MUT_CONC = Math.min(CONC, 2);   // the heavy mutants spawn child processes; contention turned 70 s runs into 900 s
      await Promise.all(Array.from({ length: MUT_CONC }, async () => {
        while (q.length) {
          const { f, n } = q.shift();
          const r = await runOne(f, { MUTANT: n });
          if (r.skipped) { process.stdout.write(`  ⏭ not run  ${(f + ' :: ' + n).padEnd(70)} (declared gap)\n`); continue; }
          // A mutant is proven only by the test's own assertions going red. A
          // TIMEOUT is not a proof — it is a test that did not run — and it
          // fails the gate like a survivor (2026-09-03: five mutants "killed"
          // at 900 s were kills by the runner, not by the test).
          const killed = r.code !== 0 && !r.timedOut;
          if (!killed) survivors.push({ f, n, timedOut: r.timedOut });
          process.stdout.write(`  ${killed ? '☠' : (r.timedOut ? '⏱ TIMEOUT' : '✗ SURVIVED')} ${(f + ' :: ' + n).padEnd(70)} ${String(r.ms).padStart(6)}ms\n`);
        }
      }));
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  ${results.length - failed.length} passed`
    + (skipped.length ? ` (${skipped.length} skipped)` : '')
    + `, ${failed.length} failed` + (profileFailed.length ? `, ${profileFailed.length} failed under a profile` : '') + (survivors.length ? `, ${survivors.length} mutant(s) SURVIVED` : '') + ` — ${secs}s\n`);

  if (skipped.length) {
    console.log('  Skipped, and what goes untested:');
    for (const s of skipped) {
      const why = (s.out.split('\n').find((l) => /NOT COVERED/.test(l)) || '').trim();
      console.log(`    ${s.file}${why ? ` — ${why}` : ''}`);
    }
    console.log('    (TEST_DATABASE_URL=postgres://… restores these)\n');
  }

  if (failed.length) {
    console.log('  FAILED:');
    failed.forEach((f) => console.log(`    ${f.file}`));
    console.log('');
  }
  if (profileFailed.length) {
    console.log('  FAILED UNDER A PROFILE (that clinic would ship this):');
    profileFailed.forEach((p) => console.log(`    ${p.file}  [${p.prof}]`));
    console.log('');
  }
  if (survivors.length) {
    console.log('  MUTANTS SURVIVED (a proof that no longer proves anything):');
    survivors.forEach((s) => console.log(`    ${s.f} :: MUTANT=${s.n}${s.timedOut ? '   (TIMED OUT — not proven either way)' : ''}`));
    console.log('');
  }
  process.exit(failed.length || profileFailed.length || survivors.length ? 1 : 0);
})();
