#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE PATIENT SAID, MINUS WHAT WE WROTE DOWN
//
// THE NUMBER THIS PROJECT HAS NEVER HAD. capture-gap.js measures facts in the
// transcript that reached the record. Its denominator is the STT's output, so a
// drug the STT never heard was never counted as a miss — the metric could not
// see its own biggest failure mode. Every "46.2% capture" figure is really a
// PROCESSING rate.
//
// This reads call_truth, where independent transcribers' opinions are stored
// beside production's own, and reports the two losses separately:
//
//     STT LOSS   a drug an independent ear heard that is in NO transcript of
//                ours. Ritu cannot have said a drug she never heard, so this is
//                unambiguous — it is what Sarvam dropped before we ever saw it.
//
//     OUR LOSS   a drug that IS in our transcript and never reached
//                patient_medications. That is the half we have been fixing all
//                week, and the only half we could previously see.
//
// DELIBERATELY A LOWER BOUND ON STT LOSS. The second-ear transcripts are
// UNDIARIZED — one continuous blob with no speaker labels — so a drug present
// in both blobs cannot be attributed to the patient rather than to Ritu's own
// read-back. Counting only drugs absent from our side entirely avoids that
// question completely. The true STT loss is at least this, probably more, and
// saying "at least" honestly beats a bigger number that needs an asterisk.
//
//     node tools/truth-gap.js
//     node tools/truth-gap.js --verbose     # name every drug and every call
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { findAllDrugMentions } = require('../readback');

const VERBOSE = process.argv.includes('--verbose');
const URL = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: URL,
  ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
});

const drugsIn = (text) => {
  const found = findAllDrugMentions(String(text || ''), { brands: true, max: 12 });
  return [...new Set(found.map((d) => d.canonical))];
};

/**
 * Split one call's drug mentions into the three buckets. Pure, and exported so
 * the classification can be tested without a database — the DB part of this
 * tool is plumbing, the attribution is the claim.
 *
 * @param ours      production's transcript (what Sarvam wrote, patient turns)
 * @param earTexts  independent transcripts of the same audio
 * @param inRecord  drug names that reached patient_medications for this call
 */
// ─── SUBTRACT WHAT RITU SAID ────────────────────────────────────────────────
// The independent transcripts are of the WHOLE call, both voices. Ours was the
// patient turns only. That asymmetry alone made every drug in Ritu's own speech
// look like something the STT had lost.
//
// MEASURED 2026-08-16, first real run: 78 of 96 "drug mentions" were charged to
// the STT, and the single largest contributor was Rifampicin — in ALL 21 calls.
// The brand lexicon has 116,492 entries and some are ordinary words:
//
//     klinik -> Rifampicin        smile -> Carboxymethylcellulose
//     time   -> Nimesulide        fever -> Paracetamol
//
// The clinic is called "Smile Multispeciality Clinic", so Ritu's GREETING
// contains two false drug hits, on every call, on the ears' side of the diff
// only. The 81% was mostly the clinic's own name.
//
// We know exactly what Ritu said — it is our own TTS text — so remove it. Not a
// heuristic: a literal subtraction of known strings. What remains is what the
// caller contributed, without needing diarization.
function withoutRituSpeech(earText, rituTurns) {
  let t = String(earText || '');
  for (const turn of rituTurns || []) {
    for (const word of String(turn).split(/\s+/)) {
      const w = word.replace(/[।.,!?;:()]/g, '').trim();
      if (w.length < 3) continue;          // "है", "जी" carry no drug risk
      t = t.split(w).join(' ');
    }
  }
  return t;
}

function classifyCall(ours, earTexts, inRecord = [], rituTurns = []) {
  const mine = new Set(drugsIn(ours));
  const heard = new Set();
  for (const t of earTexts) for (const d of drugsIn(withoutRituSpeech(t, rituTurns))) heard.add(d);
  const rec = [...inRecord].map((r) => String(r).toLowerCase());

  return {
    // An independent ear heard it and our transcript has no trace of it. Ritu
    // cannot have spoken a drug she never heard, so this needs no diarization.
    missedByStt: [...heard].filter((d) => !mine.has(d)),
    // We transcribed it and it never became a row.
    missedByUs: [...mine].filter((d) => !rec.some((r) => r.includes(d.toLowerCase()))),
    got: [...mine].filter((d) => rec.some((r) => r.includes(d.toLowerCase()))),
  };
}

module.exports = { classifyCall, drugsIn, withoutRituSpeech };

async function main() {
  const { rows: have } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'call_truth'`);
  if (!have.length) {
    console.error('\n✗ call_truth does not exist yet. Migration 011 runs at deploy (npm prestart).');
    console.error('  Deploy, then run tools/transcribe-truth.js to populate it.\n');
    await pool.end();
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT exotel_call_sid, source, transcript FROM call_truth ORDER BY exotel_call_sid, source`);
  if (!rows.length) {
    console.error('\n✗ call_truth is empty. Run tools/transcribe-truth.js in the Railway shell first');
    console.error('  (Exotel is IP-whitelisted to the deployment — it returns 401 from a laptop).\n');
    await pool.end();
    return;
  }

  // Group by call, then split ours from the independent ears.
  const byCall = new Map();
  for (const r of rows) {
    if (!byCall.has(r.exotel_call_sid)) byCall.set(r.exotel_call_sid, { ours: null, ears: [] });
    const g = byCall.get(r.exotel_call_sid);
    if (r.source === 'sarvam-realtime') g.ours = r.transcript;
    else g.ears.push({ source: r.source, text: r.transcript });
  }

  // Ritu's own words, to subtract from the ears' transcripts. Read from
  // calls.transcript because that is where our TTS text is recorded verbatim.
  const rituTurns = new Map();
  {
    const { rows: tr } = await pool.query(
      `SELECT exotel_call_sid, transcript FROM calls WHERE exotel_call_sid = ANY($1)`, [[...byCall.keys()]]);
    for (const r of tr) {
      let t = r.transcript;
      if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = null; } }
      if (Array.isArray(t)) rituTurns.set(r.exotel_call_sid, t.filter((x) => x.role === 'ritu').map((x) => x.text));
    }
  }

  // What actually reached the clinical record.
  // JOINED ON call_sid, NOT patient_id. The first version joined
  // calls.patient_id = patient_medications.patient_id and selected m.name —
  // wrong column (it is `canonical`) and a key that is NULL on every row in
  // production. Worse, the query carried `.catch(() => ({rows: []}))`, so both
  // mistakes returned "no medications recorded" instead of an error, and the
  // tool reported 0% captured while the table held nine correct rows. A silent
  // catch around the query that supplies the numerator is how a metric lies
  // with a straight face.
  const { rows: meds } = await pool.query(
    `SELECT m.call_sid AS exotel_call_sid, m.canonical
       FROM patient_medications m
      WHERE m.call_sid = ANY($1)`, [[...byCall.keys()]]);
  const recorded = new Map();
  for (const m of meds) {
    if (!recorded.has(m.exotel_call_sid)) recorded.set(m.exotel_call_sid, new Set());
    recorded.get(m.exotel_call_sid).add(String(m.canonical));
  }

  let callsScored = 0, sttLost = 0, ourLost = 0, captured = 0;
  const detail = [];

  for (const [sid, g] of byCall) {
    if (!g.ours || !g.ears.length) continue;   // needs both sides to be a comparison
    callsScored++;
    // Through the exported function, not a second copy of it. The first draft of
    // this file had the attribution written out twice — here and in
    // classifyCall — which is the defect class this repo has paid for seven
    // times. A test can only vouch for the copy it calls.
    const { missedByStt, missedByUs, got } =
      classifyCall(g.ours, g.ears.map((e) => e.text), recorded.get(sid) || new Set(), rituTurns.get(sid) || []);

    sttLost += missedByStt.length;
    ourLost += missedByUs.length;
    captured += got.length;

    if (missedByStt.length || missedByUs.length || got.length) {
      detail.push({ sid, missedByStt, missedByUs, got, ears: g.ears.length });
    }
  }

  const spoken = sttLost + ourLost + captured;
  console.log(`\n  ${byCall.size} call(s) in call_truth, ${callsScored} with both our transcript and an independent ear\n`);

  if (!spoken) {
    console.log('  No drug mentions found on either side of these calls.');
    console.log('  That is a real answer — these callers did not name medications — but it is');
    console.log('  not a capture rate. Ground-truth calls where a drug WAS named to get one.\n');
    await pool.end();
    return;
  }

  const pct = (n) => `${((100 * n) / spoken).toFixed(0)}%`;
  console.log('  ── OF EVERY DRUG MENTION WE CAN ACCOUNT FOR ──');
  console.log(`     reached the record          ${String(captured).padStart(3)}   ${pct(captured)}`);
  console.log(`     LOST BY US (we heard it)    ${String(ourLost).padStart(3)}   ${pct(ourLost)}`);
  console.log(`     LOST BY THE STT (never saw) ${String(sttLost).padStart(3)}   ${pct(sttLost)}   ← lower bound`);
  console.log(`                                 ───`);
  console.log(`     total accounted for         ${String(spoken).padStart(3)}`);
  console.log('\n  The STT figure is a LOWER BOUND: the independent transcripts are undiarized,');
  console.log('  so a drug present on both sides cannot be told apart from Ritu\'s own read-back');
  console.log('  and is not counted here. The real STT loss is at least this.');

  if (VERBOSE && detail.length) {
    console.log('\n  ── PER CALL ──');
    for (const d of detail) {
      console.log(`  ${d.sid.slice(0, 16)}  (${d.ears} independent ear${d.ears > 1 ? 's' : ''})`);
      if (d.got.length)         console.log(`      ✓ recorded      ${d.got.join(', ')}`);
      if (d.missedByUs.length)  console.log(`      ✗ ours to lose  ${d.missedByUs.join(', ')}`);
      if (d.missedByStt.length) console.log(`      ✗ never heard   ${d.missedByStt.join(', ')}`);
    }
  } else if (detail.length) {
    console.log('\n  --verbose names every drug and every call.');
  }
  console.log('');
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error('truth-gap failed:', e.message); process.exit(1); });
}
