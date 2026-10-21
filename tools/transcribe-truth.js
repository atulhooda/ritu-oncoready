#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// A SECOND EAR — so the transcript can be checked without a human listening
//
// Every accuracy number here has come from calls.transcript, which IS Sarvam's
// realtime output. Marking Sarvam's homework with Sarvam's homework is not a
// measurement, and the cost showed up on 2026-08-15: a caller named DEEKSHITHA
// was heard as "आनंद", then "ಸುಧೀಶೇತನ್", then "ದೀಕ್ಷಿತ". The only reason we know
// is that the owner was on the call.
//
// He also, reasonably, does not want to be the transcription service.
//
// So: send the RECORDING to a model that was not in the loop — Gemini takes
// audio natively — and diff its transcript against ours. Where two independent
// systems agree and ours differs, ours is very likely wrong. That is not ground
// truth (only a human ear is), but it is the first thing this repo has had that
// can be produced at scale and pointed at a specific word.
//
//     node tools/transcribe-truth.js --sid 7da9c84c...      # fetch + compare
//     node tools/transcribe-truth.js --file /tmp/rec/x.mp3  # a local file
//     node tools/transcribe-truth.js --since 120            # every recent call
//
// FETCHING NEEDS THE RAILWAY SHELL — Exotel is IP-whitelisted to the deployment
// (401 from a laptop, verified on both hosts, v1 and v2). Comparison against a
// --file works anywhere.
//
// WHAT THIS IS NOT. Gemini is not a reference transcriber for 8kHz Indic
// telephony and nobody should treat its output as correct. It is a SECOND
// OPINION. Disagreement means "look here", not "we were wrong" — and the script
// prints both so the difference can be judged rather than assumed.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { extractNameFromSpeech } = require('../nameGuard');

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SID = val('sid', null);
const FILE = val('file', null);
const SINCE_MIN = parseInt(val('since', '0'), 10);
// Cap a single run: each call costs one Gemini request per model, and a large
// backlog should be worked through deliberately rather than in one surprise bill.
const LIMIT = parseInt(val('limit', '10'), 10);
// MODELS, PLURAL, AND THE CHOICE IS NOT VALIDATED. A probe on 2026-08-15 asked
// five systems to transcribe one clip of "My name is Deekshitha and I take
// Dolo" and got five different names:
//
//     gemini-2.5-flash   Vikshita          saarika:v2.5   Vikshita N. N. Golo
//     gemini-3.5-flash   Vichita / Zolo    saaras:v3      Vikshita / Volo
//     gemini-3.6-flash   Richita / Yolo    saaras:v4      Vikshita / Volo
//     gemini-3.7-flash   Richard / Golo
//
// NEWER WAS NOT BETTER: 3.7 produced "Richard", further from the truth than
// 2.5's "Vikshita". So no default here is defensible as "the good one", and
// picking the newest would be cargo cult. Two are run by default and BOTH
// transcripts are printed.
//
// The disagreement is the point. Where independent systems produce different
// names, the name is uncertain — and that is actionable without knowing the
// truth: it is exactly when Ritu should read the name back to the caller.
const MODELS = (val('model', 'gemini-3.5-flash,gemini-2.5-flash')).split(',').map((m) => m.trim()).filter(Boolean);
const SAVE = val('save', null);

// ─── IMPORTING A FILE MUST NOT KILL THE PROCESS ─────────────────────────────
// This was a bare `if (!KEY) process.exit(1)` at module scope. tests/test-truth-
// gap.js imports this file for ONE constant (BACKLOG_SQL, so the test asserts
// against the real query instead of a copy of it) — and that import alone
// terminated the run. All 12 of the test's own checks passed first; it then
// died reaching for a string.
//
// CI is where this surfaced, because a laptop has GEMINI_API_KEY in .env and
// GitHub does not. It looked like "the test needs a secret". It wasn't: the
// test needs no key at all, it needs an import that doesn't call process.exit.
//
// The check now runs where the key is actually USED, so a real run without a
// key still stops immediately and loudly — which is right, that IS a fatal
// misconfiguration for this tool — while merely loading the module is inert.
const KEY = process.env.GEMINI_API_KEY;
function requireKey() {
  if (!KEY) {
    console.error('✗ GEMINI_API_KEY is not set — transcribe-truth needs it to call Gemini.');
    process.exit(1);
  }
  return KEY;
}

const EX_HOST = process.env.EXOTEL_HOST || 'api.exotel.com';
const EX_ACC = process.env.EXOTEL_SID || '';
const EX_AUTH = 'Basic ' + Buffer.from(`${process.env.EXOTEL_API_KEY || ''}:${process.env.EXOTEL_API_TOKEN || ''}`).toString('base64');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// THE BACKLOG: calls that have audio and no independent transcript yet.
//
// The subtle clause is `t.source <> 'sarvam-realtime'`. Production's OWN
// transcript is stored in call_truth too, so a plain EXISTS check would mark a
// call "done" the moment we saved our own opinion of it — and the tool would
// skip precisely the calls it exists to second-guess. Exported so the test
// suite runs this exact string; a query nothing executes is a query that drifts.
// Written as a LEFT JOIN … IS NULL rather than NOT EXISTS: both are correct
// Postgres, but the pg-mem double cannot resolve the outer alias inside a
// correlated subquery, and a query the double cannot run is a query only half
// the suite covers.
const BACKLOG_SQL = `
  SELECT c.exotel_call_sid, c.created_at, c.language, c.duration_seconds, c.recording_url, c.transcript
    FROM calls c
    LEFT JOIN call_truth t
      ON t.exotel_call_sid = c.exotel_call_sid
     AND t.source <> 'sarvam-realtime'
   WHERE c.recording_url IS NOT NULL
     AND jsonb_array_length(c.transcript) >= 2
     AND t.id IS NULL
   ORDER BY c.created_at DESC
   LIMIT $1`;

module.exports = { BACKLOG_SQL };

// MINIMAL, AND THAT IS A CORRECTION. The first version of this prompt described
// the scenario ("a call to an Indian clinic, an AI receptionist called Ritu, a
// patient") and asked for a structured report — NAMES HEARD / MEDICINES HEARD /
// AUDIO NOTES. Given a TWO-SECOND clip, gemini-3.5-flash returned a complete
// invented consultation:
//
//     RITU: Hello, welcome to Aster Clinic. I am Ritu, your digital assistant…
//     PATIENT: My name is Lichita and need yellow fever vaccine.
//     RITU: …could you please share your age?      PATIENT: 24.
//
// None of it was in the audio. The prompt supplied a template and the model
// filled it in. An instrument built to catch fabrication that fabricates is
// worse than no instrument, because its output looks like evidence.
//
// So: no scenario, no roles, no sections to complete, and an explicit escape
// for silence. Verbatim words only. Everything the caller wants to know —
// which name, which drug — is read off the transcript afterwards, not asked
// for in a shape the model can confabulate into.
const PROMPT = `Transcribe the speech in this audio verbatim.

Output ONLY the words spoken, in the script the speaker used. Do not translate.
Do not transliterate. Do not add speaker labels, punctuation you cannot hear,
context, or any commentary.

If a word is unclear, write [unclear]. Never substitute a plausible word.
If there is no speech at all, output exactly: [no speech]`;

// A FABRICATION TRIPWIRE. Speech runs at roughly 2-3 words per second; nobody
// fits a consultation into two seconds. If a transcript carries far more words
// than the audio could possibly hold, it was invented, and saying so loudly is
// the difference between an instrument and a liability.
function fabricationSuspect(text, seconds) {
  if (!seconds || seconds <= 0) return null;
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const ceiling = Math.ceil(seconds * 4) + 12;   // 4 w/s is already unnaturally fast
  return words > ceiling
    ? `${words} words from ${seconds}s of audio (ceiling ~${ceiling}) — almost certainly FABRICATED, do not use`
    : null;
}

async function geminiTranscribe(buf, mime, model) {
  // Where the key is actually needed — not at import. See requireKey above.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${requireKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: buf.toString('base64') } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) return { err: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const j = await res.json();
  const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && (j.candidates[0].content.parts || []).map((p) => p.text).filter(Boolean).join('');
  return text ? { text } : { err: `no text in response: ${JSON.stringify(j).slice(0, 300)}` };
}

async function audioFor(call) {
  let url = call.recording_url;
  if (!url) {
    const r = await fetch(
      `https://${EX_HOST}/v1/Accounts/${encodeURIComponent(EX_ACC)}/Calls/${encodeURIComponent(call.exotel_call_sid)}.json`,
      { headers: { Authorization: EX_AUTH } });
    if (r.status === 401) throw new Error('Exotel 401 — IP-whitelisted to the deployment. Run this in the Railway shell.');
    if (!r.ok) return { err: `Exotel HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    url = j && j.Call && j.Call.RecordingUrl;
    if (!url) return { err: 'no recording yet (Exotel takes ~5 min)' };
    await pool.query(`UPDATE calls SET recording_url = $1 WHERE exotel_call_sid = $2`, [url, call.exotel_call_sid]);
  }
  const a = await fetch(url, { headers: { Authorization: EX_AUTH } });
  if (!a.ok) return { err: `audio HTTP ${a.status}${a.status === 401 ? ' — run this in the Railway shell' : ''}` };
  return { buf: Buffer.from(await a.arrayBuffer()), mime: url.endsWith('.wav') ? 'audio/wav' : 'audio/mp3' };
}

const ourTurns = (t) => {
  try { const a = typeof t === 'string' ? JSON.parse(t) : t; return Array.isArray(a) ? a : []; }
  catch { return []; }
};

async function main() {
  // ── a local file, no database involved ──────────────────────────────────
  if (FILE) {
    const buf = fs.readFileSync(FILE);
    console.log(`\n${path.basename(FILE)} — ${(buf.length / 1024).toFixed(0)} KB\n`);
    for (const m of MODELS) {
      const r = await geminiTranscribe(buf, FILE.endsWith('.wav') ? 'audio/wav' : 'audio/mp3', m);
      console.log(`── ${m} ──`);
      if (r.err) { console.log(`✗ ${r.err}`); }
      else {
        // Rough duration from the file size: 8kHz 16-bit mono is 16000 B/s.
        const secs = Math.max(1, Math.round(buf.length / 16000));
        const suspect = fabricationSuspect(r.text, secs);
        console.log(suspect ? `⚠ DISCARDED — ${suspect}` : r.text);
      }
      console.log('');
    }
    await pool.end();
    return;
  }

  // ─── THE DEFAULT IS THE WORK QUEUE, NOT A TIME WINDOW ────────────────────
  // This used to default to "calls in the last 120 minutes", which meant that
  // running it the morning after a testing session printed "No matching calls."
  // and stopped — the calls were 14 hours old. The window was never what anyone
  // wanted; the question is "which calls have audio and no ground truth yet",
  // and that set is exactly the backlog. Defaulting to it also makes the tool
  // idempotent: run it repeatedly and it works through what is left, spending
  // nothing on calls already transcribed.
  //
  // --since and --sid still override, for re-running a specific call after a
  // change to the prompt or the model list.
  let calls;
  if (SID) {
    ({ rows: calls } = await pool.query(
      `SELECT exotel_call_sid, created_at, language, duration_seconds, recording_url, transcript
         FROM calls WHERE exotel_call_sid = $1`, [SID]));
  } else if (SINCE_MIN) {
    ({ rows: calls } = await pool.query(
      `SELECT exotel_call_sid, created_at, language, duration_seconds, recording_url, transcript
         FROM calls WHERE created_at > NOW() - ($1 || ' minutes')::interval
        ORDER BY created_at DESC`, [String(SINCE_MIN)]));
  } else {
    ({ rows: calls } = await pool.query(BACKLOG_SQL, [LIMIT]));
  }

  if (!calls.length) {
    // "No matching calls" with no reason sent the last run into a dead end.
    // Say which set was empty and what to do about it.
    if (SID) console.log(`No call with sid ${SID}.`);
    else if (SINCE_MIN) console.log(`No calls in the last ${SINCE_MIN} minutes. Try a wider --since, or omit it to work the backlog.`);
    else {
      const { rows: n } = await pool.query(
        `SELECT count(*) FILTER (WHERE recording_url IS NOT NULL)::int AS with_audio,
                count(*)::int AS total FROM calls`);
      console.log(`\nNothing left to transcribe.`);
      console.log(`  ${n[0].with_audio} of ${n[0].total} calls have audio, and all of them already have ground truth.`);
      console.log(`  To add more: make calls, or run tools/fetch-recording.js to pull audio for older ones.`);
      console.log(`  To re-transcribe one anyway: --sid <call_sid>\n`);
    }
    await pool.end();
    return;
  }
  if (SAVE) fs.mkdirSync(SAVE, { recursive: true });

  for (const c of calls) {
    console.log('\n' + '═'.repeat(74));
    console.log(`${c.created_at.toISOString()}  ${c.exotel_call_sid}  ${c.duration_seconds}s  ${c.language || '?'}`);
    let a;
    try { a = await audioFor(c); } catch (e) { console.error(`  ✗ ${e.message}`); break; }
    if (a.err) { console.log(`  ✗ ${a.err}`); continue; }
    console.log(`  audio ${(a.buf.length / 1024).toFixed(0)} KB — asking ${MODELS.join(', ')}…`);

    console.log('\n── WHAT WE TRANSCRIBED (Sarvam realtime — what production acted on) ──');
    ourTurns(c.transcript).forEach((t) => console.log(`  ${t.role === 'ritu' ? 'RITU   ' : 'PATIENT'}  ${t.text}`));

    const opinions = [];
    for (const m of MODELS) {
      const g = await geminiTranscribe(a.buf, a.mime, m);
      if (g.err) { console.log(`\n  ✗ ${m}: ${g.err}`); continue; }
      const suspect = fabricationSuspect(g.text, c.duration_seconds);
      console.log(`\n── SECOND EAR: ${m} (not in the live loop) ──`);
      if (suspect) {
        console.log(`  ⚠ DISCARDED — ${suspect}`);
      } else {
        opinions.push({ model: m, text: g.text });
        console.log(g.text.split('\n').map((l) => '  ' + l).join('\n'));
        // ─── KEEP IT ────────────────────────────────────────────────────────
        // This used to exist only as a file under --save, which on the
        // deployment means /tmp inside a container that restarts on every
        // deploy. The most valuable data this project has produced had a
        // lifetime measured in hours, and the first 19-call run was very nearly
        // lost. ON CONFLICT because a re-run must REPLACE this source's opinion,
        // not accumulate copies that double every later count.
        await pool.query(
          `INSERT INTO call_truth (exotel_call_sid, source, transcript, meta)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (exotel_call_sid, source)
           DO UPDATE SET transcript = EXCLUDED.transcript, meta = EXCLUDED.meta, created_at = NOW()`,
          [c.exotel_call_sid, m, g.text, JSON.stringify({ durationSeconds: c.duration_seconds, language: c.language })]
        ).catch((e) => console.log(`  ⚠ could not persist ${m}: ${e.message}`));
      }
    }

    // Production's own transcript, stored beside the others so a comparison is
    // a single query rather than a join plus a JSONB walk. 'sarvam-realtime' is
    // the reserved source name for what production actually acted on.
    {
      const ourText = ourTurns(c.transcript).filter((t) => t.role !== 'ritu').map((t) => t.text).join(' । ');
      if (ourText) {
        await pool.query(
          `INSERT INTO call_truth (exotel_call_sid, source, transcript, meta)
                VALUES ($1, 'sarvam-realtime', $2, $3)
           ON CONFLICT (exotel_call_sid, source)
           DO UPDATE SET transcript = EXCLUDED.transcript, meta = EXCLUDED.meta, created_at = NOW()`,
          [c.exotel_call_sid, ourText, JSON.stringify({ durationSeconds: c.duration_seconds, language: c.language, inLiveLoop: true })]
        ).catch((e) => console.log(`  ⚠ could not persist ours: ${e.message}`));
      }
    }

    // The names each independent system heard, side by side. Five systems
    // produced five different names on a probe clip, which is why this is
    // printed rather than reconciled: disagreement is a CONFIDENCE signal, and
    // reconciling it would throw away the only thing it reliably tells us.
    // Read the whole transcript out per system rather than parsing a section
    // the prompt no longer asks for — the section WAS the fabrication vector.
    // This printed the first 90 characters of the whole transcript under a
    // heading promising names — a half-finished change. The parsing was removed
    // because ASKING A MODEL to report the name was the fabrication vector, and
    // that reasoning was right; what was missing is that we now have a
    // DETERMINISTIC extractor (nameGuard.extractNameFromSpeech, 9c5e9fe) which
    // slices the name out of the caller's own carrier phrase by position. No
    // model is asked anything, so there is nothing to fabricate — and running
    // the SAME extractor over each system's text is exactly the comparison this
    // section always wanted: not "what did the model say the name was", but
    // "what name does production's own logic derive from each transcript".
    const namesFrom = (t) => {
      const found = [];
      for (const sentence of String(t || '').split(/[।.?!\n]+/)) {
        const n = extractNameFromSpeech(sentence);
        if (n && !found.includes(n)) found.push(n);
      }
      return found;
    };
    if (opinions.length > 1) {
      console.log('\n── NAMES OUR OWN EXTRACTOR DERIVES FROM EACH TRANSCRIPT ──');
      const ourText = ourTurns(c.transcript).filter((t) => t.role !== 'ritu').map((t) => t.text).join(' । ');
      const rows = [['sarvam (production)', namesFrom(ourText)], ...opinions.map((o) => [o.model, namesFrom(o.text)])];
      for (const [label, names] of rows) {
        console.log(`  ${String(label).padEnd(20)} ${names.length ? names.join(' | ') : '(no carrier phrase — bare name or none)'}`);
      }
      const sets = rows.map(([, n]) => n.join('|'));
      if (new Set(sets).size > 1) {
        console.log('  ⚠ THE TRANSCRIPTS DISAGREE ON THE NAME — this is the case Ritu must read back.');
      } else if (sets[0]) {
        console.log('  All transcripts agree. If the RECORD differs from this, the loss was ours, not the STT\'s.');
      }
    }
    console.log('\n  Disagreement means LOOK HERE. None of these is ground truth.');

    if (SAVE) {
      const out = path.join(SAVE, `${c.exotel_call_sid}.compare.txt`);
      fs.writeFileSync(out,
        `call ${c.exotel_call_sid}  ${c.created_at.toISOString()}  ${c.duration_seconds}s  ${c.language}\n\n` +
        `=== OURS (Sarvam realtime — what production acted on) ===\n` +
        ourTurns(c.transcript).map((t) => `${t.role === 'ritu' ? 'RITU   ' : 'PATIENT'}  ${t.text}`).join('\n') +
        opinions.map((o) => `\n\n=== SECOND EAR (${o.model}) ===\n${o.text}\n`).join(''));
      console.log(`  saved -> ${out}`);
    }
  }
  await pool.end();
}

// GUARDED. Adding module.exports without this made `require()` of the tool run
// the ENTIRE tool — against the production database and Exotel — which is what
// happened the first time the test tried to import BACKLOG_SQL. A file that is
// both a CLI and a module has to say which one it is being asked to be.
if (require.main === module) {
  main().catch((e) => { console.error('transcribe-truth failed:', e.message); process.exit(1); });
}
