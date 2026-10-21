#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// GET THE AUDIO — the feedback loop this project has never had
//
// Every number produced about Ritu's accuracy has come from calls.transcript,
// and the transcript IS THE STT'S OUTPUT. So "the STT got it wrong" has been
// structurally invisible: we can see what Sarvam produced, never what the
// caller said.
//
// 2026-08-15 made the cost concrete. A Kannada caller gave her name three times
// — heard as "आनंद", then "ಸುಧೀಶೇತನ್", then "ದೀಕ್ಷಿತ". The owner, who was on
// the call, says her name is DEEKSHITHA. Nothing in the database could have
// told us that. capture-gap.js reports 46.2% of stated facts reaching the
// record, and that denominator only counts facts the STT already transcribed —
// it cannot see a drug or a name that never made it into text at all.
//
// WHY THIS SCRIPT EXISTS RATHER THAN A DASHBOARD CLICK. Exotel's API is
// IP-whitelisted to the deployment's egress address: the same credentials that
// return 200 from Railway return 401 from a laptop (verified 2026-08-15 against
// both api.exotel.com and api.in.exotel.com, v1 and v2). RUN THIS IN THE
// RAILWAY SHELL, where the address is already allowed:
//
//     node tools/fetch-recording.js --since 120        # last 2h of calls
//     node tools/fetch-recording.js --sid 7da9c84c...  # one call
//     node tools/fetch-recording.js --since 120 --save /tmp/rec
//
// It caches recording_url onto the calls row exactly as the dashboard does
// (ritu-desk-demo app/api/recordings/[callSid]/route.ts), so a URL fetched once
// is there for everyone afterwards.
//
// WHAT IT DOES NOT DO. It does not tell you what was said. Only a human ear can
// do that, which is the point: --save writes the audio next to the transcript
// we produced, so the two can be compared and the difference written down. That
// difference is the first ground truth this project will have.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SID = val('sid', null);
const SINCE_MIN = parseInt(val('since', '120'), 10);
const SAVE_DIR = val('save', null);

const HOST = process.env.EXOTEL_HOST || 'api.exotel.com';
const ACC = process.env.EXOTEL_SID || '';
const KEY = process.env.EXOTEL_API_KEY || '';
const TOK = process.env.EXOTEL_API_TOKEN || '';
const auth = 'Basic ' + Buffer.from(`${KEY}:${TOK}`).toString('base64');

if (!ACC || !KEY || !TOK) {
  console.error('✗ EXOTEL_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN are not all set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function recordingUrlFor(callSid) {
  const url = `https://${HOST}/v1/Accounts/${encodeURIComponent(ACC)}/Calls/${encodeURIComponent(callSid)}.json`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 401) {
    throw new Error(
      'Exotel returned 401. The credentials are almost certainly fine — the API is ' +
      'IP-whitelisted to the deployment. Run this in the Railway shell, not locally.'
    );
  }
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const j = await res.json().catch(() => null);
  const rec = j && j.Call && j.Call.RecordingUrl;
  return { url: typeof rec === 'string' && rec ? rec : null };
}

(async () => {
  const { rows: calls } = SID
    ? await pool.query(
      `SELECT exotel_call_sid, created_at, language, duration_seconds, recording_url, transcript
         FROM calls WHERE exotel_call_sid = $1`, [SID])
    : await pool.query(
      `SELECT exotel_call_sid, created_at, language, duration_seconds, recording_url, transcript
         FROM calls WHERE created_at > NOW() - ($1 || ' minutes')::interval
        ORDER BY created_at DESC`, [SINCE_MIN]);

  if (!calls.length) {
    console.log(SID ? `No call ${SID}.` : `No calls in the last ${SINCE_MIN} minutes.`);
    await pool.end();
    return;
  }

  if (SAVE_DIR) fs.mkdirSync(SAVE_DIR, { recursive: true });
  console.log(`\n${calls.length} call(s)\n`);

  for (const c of calls) {
    const sid = c.exotel_call_sid;
    console.log('═'.repeat(72));
    console.log(`${c.created_at.toISOString()}  ${sid}  ${c.duration_seconds}s  ${c.language || '?'}`);

    let recUrl = c.recording_url;
    if (!recUrl) {
      let got;
      try { got = await recordingUrlFor(sid); }
      catch (e) { console.error(`  ✗ ${e.message}`); break; }
      if (got.err) { console.log(`  ✗ Exotel: ${got.err}`); continue; }
      if (!got.url) { console.log('  · no recording yet (Exotel takes ~5 min after hangup)'); continue; }
      recUrl = got.url;
      // Cache it on the row, exactly as the dashboard does — so the next person
      // to want this call does not pay the API round trip.
      await pool.query(`UPDATE calls SET recording_url = $1 WHERE exotel_call_sid = $2`, [recUrl, sid]);
      console.log('  ✓ recording_url fetched and cached on the row');
    } else {
      console.log('  ✓ recording_url already cached');
    }

    if (SAVE_DIR) {
      const res = await fetch(recUrl, { headers: { Authorization: auth } });
      if (!res.ok) {
        console.log(`  ✗ audio download: HTTP ${res.status}`);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        const wav = path.join(SAVE_DIR, `${sid}.wav`);
        fs.writeFileSync(wav, buf);
        // The transcript beside the audio, so the comparison is one file open
        // rather than a database query. This pairing IS the deliverable.
        const turns = (() => {
          try { const t = typeof c.transcript === 'string' ? JSON.parse(c.transcript) : c.transcript; return Array.isArray(t) ? t : []; }
          catch { return []; }
        })();
        fs.writeFileSync(path.join(SAVE_DIR, `${sid}.txt`),
          `call ${sid}\n${c.created_at.toISOString()}  ${c.duration_seconds}s  ${c.language || '?'}\n` +
          `recording: ${wav}\n\n` +
          `WHAT WE TRANSCRIBED — listen, and write the truth beside anything wrong.\n` +
          `The gap between these two columns is the only STT measurement this\n` +
          `project has ever been able to make.\n\n` +
          turns.map((t) => `${t.role === 'ritu' ? 'RITU   ' : 'PATIENT'}  ${t.text}`).join('\n') + '\n');
        console.log(`  ✓ saved ${(buf.length / 1024).toFixed(0)} KB -> ${wav}`);
        console.log(`  ✓ transcript beside it -> ${wav.replace(/\.wav$/, '.txt')}`);
      }
    } else {
      console.log(`  ${recUrl}`);
    }
  }

  console.log('\n' + '─'.repeat(72));
  console.log('Listen, then write down what was ACTUALLY said where we got it wrong.');
  console.log('That is ground truth, and nothing in this repo has ever had any.\n');
  await pool.end();
})().catch((e) => { console.error('fetch-recording failed:', e.message); process.exit(1); });
