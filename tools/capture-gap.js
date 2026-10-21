#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE GAP BETWEEN HEARD AND RECORDED
//
// Drug recall is 38.82%, measured by running the matcher over transcripts.
// That number cannot see the failure this week was made of:
//
//   2026-08-11  "हाँ दवाई तो डोलो ले रहा हूँ"        transcribed  ->  no row
//   2026-08-11  "मुझे पेनिसिलिन से एलर्जी है"         transcribed  ->  no row
//   2026-08-12  "डोलो ...और पेनिसिलिन से एलर्जी है"   transcribed  ->  drug only
//
// Every one of those was heard PERFECTLY. The matcher would score them 100%.
// They are absent from patient_medications anyway, because the loss happened
// downstream of the matcher — in the read-back state machine, in a branch that
// only fired when there were no medications, in a turn that returned before the
// splitter ran. A metric that stops at the transcript is structurally blind to
// all three, which is why all three shipped.
//
// So this measures the OTHER half, on production calls:
//
//     of the clinical entities a patient actually stated,
//     how many reached the medical record?
//
// It reads the transcripts we already have (144 calls), runs the SAME splitter
// the call path runs — imported, not copied — over the PATIENT turns only, and
// joins against patient_medications by call_sid.
//
//     node tools/capture-gap.js               # summary
//     node tools/capture-gap.js --detail      # every loss, with the utterance
//     node tools/capture-gap.js --since 30    # only the last N days
//
// WHAT THIS IS NOT. It is not a WER or an STT number: the transcript is taken
// as given, so a drug Sarvam never heard is invisible here and belongs to the
// 38.82%. The two metrics multiply — end-to-end capture is roughly
// (matcher recall) x (this), and only the second one is fully ours to fix.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DETAIL = has('detail');
const SINCE_DAYS = parseInt(val('since', '365'), 10);

// The real ones. See the export note in callHandler.js.
const { _splitMedsAndAllergens } = require('../callHandler.js');
const { findAllDrugMentions } = require('../readback.js');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── brands:true IS SCOPED TO ONE TURN, AND SO IS THIS ─────────────────────
// The first version of this tool ran { brands: true } over EVERY patient turn
// and reported 19.4% capture. The detail listing showed why that was worthless:
//
//     "दो तीन दिन हो गए"        -> Dosulepin        ("dotin")
//     "कर दो यार"                -> Serratiopeptidase ("kikar")
//     "मेरे दांतों में ही तो"    -> Cyproheptadine   ("hito")
//     "at a very advanced stage" -> Cefpodoxime      ("stage")
//
// Nobody named a drug in any of those. callHandler.js states the rule in a
// comment right above the call site — "brands:true ONLY here ... ungated the
// brand index false-fires at 29.8% on ordinary speech (measured)" — and the
// first version ignored it, inflating the denominator with noise and making the
// system look four times worse than it is.
//
// A metric that measures a matcher production never runs is the same error as a
// test whose environment production never has. Both were made in this repo this
// week; this one is mine, on the tool built to catch the other.
//
// So: brands only in the turn that ANSWERS the medicines question, exactly as
// the call path does. Everywhere else, molecules only.
const OPTS_MEDS_TURN = { brands: true, max: 2 };
const OPTS_ELSEWHERE = { brands: false, max: 2 };

// Ritu's stage-2 question, in the 11 languages it ships in — matched loosely
// because the model paraphrases it. "Is any medicine running, or any allergy?"
const MEDS_QUESTION_RE = /दवाई|दवा|औषध|ओषध|medicine|medication|एलर्जी|अलर्जी|allerg|ಔಷಧ|ਦਵਾਈ|மருந்து|మందు|ওষুধ|દવા|മരുന്ന്/i;

const norm = (s) => String(s || '').toLowerCase().trim();

(async () => {
  const { rows: calls } = await pool.query(
    `SELECT c.id, c.exotel_call_sid sid, c.created_at, c.language, c.outcome, c.transcript,
            cl.name clinic
       FROM calls c JOIN clinics cl ON cl.id = c.clinic_id
      WHERE c.transcript IS NOT NULL
        AND c.created_at > NOW() - ($1 || ' days')::interval
      ORDER BY c.created_at`,
    [SINCE_DAYS]
  );

  const { rows: meds } = await pool.query(
    `SELECT call_sid, canonical, entity_type, resolution, heard_surface FROM patient_medications`
  );
  const bySid = new Map();
  for (const m of meds) {
    if (!bySid.has(m.call_sid)) bySid.set(m.call_sid, []);
    bySid.get(m.call_sid).push(m);
  }

  let statedMeds = 0, statedAllergens = 0, recordedMeds = 0, recordedAllergens = 0;
  let callsWithSomething = 0, callsFullyCaptured = 0;
  const losses = [];

  for (const c of calls) {
    let turns;
    try { turns = typeof c.transcript === 'string' ? JSON.parse(c.transcript) : c.transcript; }
    catch { continue; }
    if (!Array.isArray(turns)) continue;

    // PATIENT TURNS ONLY. Ritu's own read-back line contains the drug name;
    // counting it would score the system on its own echo and report ~100%.
    //
    // Each patient turn carries whether it ANSWERS the medicines question — the
    // preceding Ritu turn decides, exactly as the live phase does. Only those
    // turns get the brand index.
    const said = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || t.role !== 'patient' || !t.text) continue;
      let prevRitu = null;
      for (let j = i - 1; j >= 0; j--) { if (turns[j] && turns[j].role === 'ritu' && turns[j].text) { prevRitu = turns[j].text; break; } }
      said.push({ text: t.text, medsContext: !!(prevRitu && MEDS_QUESTION_RE.test(prevRitu)) });
    }

    const stated = { meds: [], allergens: [] };
    for (const t of said) {
      const opts = t.medsContext ? OPTS_MEDS_TURN : OPTS_ELSEWHERE;
      const split = _splitMedsAndAllergens(t.text, opts);
      if (split) {
        for (const m of split.meds) if (!stated.meds.some((x) => x.canonical === m.canonical)) stated.meds.push({ ...m, utt: t.text, ctx: t.medsContext });
        for (const a of split.allergens) if (!stated.allergens.some((x) => x.canonical === a.canonical)) stated.allergens.push({ ...a, utt: t.text, ctx: t.medsContext });
      } else {
        for (const m of findAllDrugMentions(t.text, opts)) {
          if (!stated.meds.some((x) => x.canonical === m.canonical)) stated.meds.push({ ...m, utt: t.text, ctx: t.medsContext });
        }
      }
    }
    if (!stated.meds.length && !stated.allergens.length) continue;
    callsWithSomething++;

    const got = bySid.get(c.sid) || [];
    const gotMed = new Set(got.filter((g) => g.entity_type !== 'allergy').map((g) => norm(g.canonical)));
    const gotAll = new Set(got.filter((g) => g.entity_type === 'allergy').map((g) => norm(g.canonical)));

    let lost = 0;
    for (const m of stated.meds) {
      statedMeds++;
      if (gotMed.has(norm(m.canonical))) recordedMeds++;
      else { lost++; losses.push({ c, kind: 'medication', ent: m }); }
    }
    for (const a of stated.allergens) {
      statedAllergens++;
      // An allergen recorded as a MEDICATION is not a capture — it is the
      // 2026-08-10 defect, and counting it as one would hide the regression.
      if (gotAll.has(norm(a.canonical))) recordedAllergens++;
      else {
        lost++;
        losses.push({ c, kind: gotMed.has(norm(a.canonical)) ? 'allergy-AS-MEDICATION' : 'allergy', ent: a });
      }
    }
    if (!lost) callsFullyCaptured++;
  }

  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const totalStated = statedMeds + statedAllergens;
  const totalRec = recordedMeds + recordedAllergens;

  console.log(`\n══ CAPTURE GAP ─ what a patient SAID vs what a doctor SEES`);
  console.log(`   ${calls.length} production calls, last ${SINCE_DAYS} days\n`);
  console.log(`   calls where a patient named something clinical ..... ${callsWithSomething}`);
  console.log(`   of those, calls with NOTHING lost ................. ${callsFullyCaptured}  (${pct(callsFullyCaptured, callsWithSomething)})\n`);
  console.log(`   medications stated ${String(statedMeds).padStart(4)}   recorded ${String(recordedMeds).padStart(4)}   captured ${pct(recordedMeds, statedMeds)}`);
  console.log(`   allergies   stated ${String(statedAllergens).padStart(4)}   recorded ${String(recordedAllergens).padStart(4)}   captured ${pct(recordedAllergens, statedAllergens)}`);
  console.log(`   ─────────────────────────────────────────────────────────────`);
  console.log(`   TOTAL              ${String(totalStated).padStart(4)}            ${String(totalRec).padStart(4)}   CAPTURE  ${pct(totalRec, totalStated)}\n`);

  const asMed = losses.filter((l) => l.kind === 'allergy-AS-MEDICATION').length;
  if (asMed) console.log(`   ⚠ ${asMed} allergen(s) recorded AS A MEDICATION — the 2026-08-10 defect\n`);

  if (DETAIL && losses.length) {
    console.log(`── every loss (${losses.length}) ─────────────────────────────────────────`);
    for (const l of losses) {
      console.log(`\n  ${l.c.created_at.toISOString().slice(0, 16)}  ${String(l.c.sid).slice(0, 10)}  ${l.c.language || '?'}  ${l.c.outcome || '?'}`);
      console.log(`    LOST ${l.kind.toUpperCase()}: ${l.ent.canonical}   (heard "${l.ent.surface}")`);
      console.log(`    patient said: "${String(l.ent.utt).slice(0, 150)}"`);
    }
    console.log();
  } else if (losses.length) {
    console.log(`   ${losses.length} losses — run with --detail to see each utterance\n`);
  }

  await pool.end();
})().catch((e) => { console.error('capture-gap failed:', e.message); process.exit(1); });
