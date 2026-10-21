#!/usr/bin/env node
// ─── TWO CLINICAL FACTS, VOLUNTEERED, NEITHER RECORDED ──────────────────────
// LIVE CALL db712d3d18a43011e70104acd9d81a8b, 2026-08-11 09:52 IST, verbatim
// from calls.transcript:
//
//   ritu     समझ गई। कोई दवाई चल रही है या कोई एलर्जी है जी?
//   patient  हाँ दवाई तो डोलो ले रहा हूँ।
//   ritu     आप Dolo ले रहे हैं — मैंने सही सुना ना?
//   patient  और मुझे पेनिसिलिन से एलर्जी है।            <- 2.7 seconds later
//   ritu     जानकारी के लिए शुक्रिया।
//
// calls.reason recorded "सर दर्द, डोलो ले रहे हैं, पेनिसिलिन से एलर्जी है".
// patient_medications recorded NOTHING. Zero medications, zero allergies.
//
// TWO INDEPENDENT LOSSES, ONE TURN:
//
// 1. THE ALLERGY WAS NEVER EVEN LOOKED FOR. _maybeHistoryQuestion returns at
//    the read-back branch (callHandler.js:3377) before the clause splitter at
//    stage 2 runs. So the single turn in which the caller named an allergy was
//    the single turn that could not see one. classifyReply called it 'unclear'
//    — correctly; it is neither a yes nor a correction — and stepReadback drops
//    an unclear reply (readback.js:1449).
//
// 2. THE DRUG WAS DISCARDED. The unclear branch logs "proceeding unconfirmed
//    (fail-open)" and persisted nothing, so "unconfirmed" meant "discarded".
//
// Answering a question with a new fact instead of "हाँ" is ordinary speech.
// A doctor reading this record would see a patient on no medication with no
// allergies, and prescribe accordingly.
//
// THIS TEST DRIVES CallHandler. The read-back state machine is exactly the kind
// of thing a source-text assertion cannot check, and three of four production
// defects this week passed tests that read source instead of running it.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
const assert = require('assert');
// PIN PRODUCTION. clinicMode unset defaults to 'full', which makes
// _maybeHistoryQuestion return null on line 1 and this whole file assert
// nothing — that exact vacuous pass has already happened once in this repo.
process.env.CLINIC_MODE = 'lean';
process.env.READBACK = 'on';

let pass = 0, fail = 0;
const ok = (name, fn) => {
  const p = (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  })();
  return p;
};

console.log('\nMID-READ-BACK HISTORY — a fact volunteered is a fact recorded\n');

(async () => {
  const config = require('../config.js');
  assert.strictEqual(config.clinicMode, 'lean',
    'clinicMode is not lean — the history path is disabled and this file would pass while testing nothing');

  const { CallHandler } = require('../callHandler.js');
  const db = require('../db.js');

  // CAPTURE AT THE DATABASE, NOT AT THE MODULE. callHandler.js:9 destructures
  // saveConfirmedMedication at require time, so reassigning db.saveConfirmedMedication
  // here changes nothing the handler can see — the first version of this file
  // did exactly that and reported the fix as broken while the logs showed it
  // working. Stubbing pool.query also means the real saveConfirmedMedication
  // runs, so the column mapping (entity_type is the 13th of 13) is under test
  // too rather than mocked away.
  const realQuery = db.pool.query.bind(db.pool);
  let saved = [];
  db.pool.query = async (sql, params = []) => {
    if (/INSERT INTO patient_medications/i.test(String(sql))) {
      saved.push({
        canonical: params[4], brand: params[5], heardSurface: params[6],
        resolution: params[7], matchScore: params[8], viaBrand: params[9],
        entityType: params[12],
      });
      return { rows: [{ id: 'row-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  // A handler far enough into the conversation that a med read-back is pending,
  // exactly as it was on the live call.
  const mk = () => {
    const h = Object.create(CallHandler.prototype);
    h.callSid = 'test-sid';
    h.callerPhone = '+918273500806';
    h.startTime = Date.now();
    h.conversationHistory = [];
    h._historyStage = 2.5;
    h._readbackDone = true;
    h._priorMeds = [];
    h._langCode = () => 'hi-IN';
    h._lastTurnPeakRms = 0;
    h._readbackPending = {
      type: 'meds', canonical: 'Paracetamol', surface: 'डोलो', brand: 'dolo',
      score: 0.1, viaBrand: true, second: null,
    };
    return h;
  };

  // ── 1. the allergy, on the exact live utterance ──────────────────────────
  await ok('THE LIVE TURN: an allergy volunteered mid-read-back is recorded', async () => {
    saved = [];
    const h = mk();
    h._resolveReadback('और मुझे पेनिसिलिन से एलर्जी है।');
    await new Promise((r) => setImmediate(r));
    const allergies = saved.filter((m) => m.entityType === 'allergy');
    assert(allergies.length >= 1,
      `the caller named an allergy and nothing was written: ${JSON.stringify(saved)}`);
    assert(/penicillin/i.test(allergies[0].canonical),
      `recorded the wrong allergen: ${allergies[0].canonical}`);
  });

  await ok('it is an ALLERGY, never a medication — 009 stays honoured', async () => {
    saved = [];
    const h = mk();
    h._resolveReadback('और मुझे पेनिसिलिन से एलर्जी है।');
    await new Promise((r) => setImmediate(r));
    const asMed = saved.filter((m) => m.entityType !== 'allergy' && /penicillin/i.test(m.canonical));
    assert.deepStrictEqual(asMed, [],
      'the allergen was written as a medication — it tells a doctor the patient TOLERATES it');
  });

  await ok('the model is told, so the summary carries it and Ritu does not re-ask', async () => {
    const h = mk();
    h._resolveReadback('और मुझे पेनिसिलिन से एलर्जी है।');
    await new Promise((r) => setImmediate(r));
    assert(h.conversationHistory.some((m) => /ALLERGY/.test(m.content) && /penicillin/i.test(m.content)),
      `nothing reached the model: ${JSON.stringify(h.conversationHistory)}`);
  });

  // ── 2. the ordinary paths must not change ────────────────────────────────
  await ok('a plain "हाँ" still confirms the drug, unchanged', async () => {
    saved = [];
    const h = mk();
    h._resolveReadback('हाँ');
    await new Promise((r) => setImmediate(r));
    const meds = saved.filter((m) => m.entityType !== 'allergy');
    assert.strictEqual(meds.length, 1, `expected one confirmed medication, got ${JSON.stringify(saved)}`);
    assert.strictEqual(meds[0].canonical, 'Paracetamol');
    assert(/affirmed/.test(meds[0].resolution), `graded ${meds[0].resolution}`);
  });

  await ok('an unclear reply with NO clinical content writes nothing yet', async () => {
    // The DTMF window is still open; the drug is recorded at endCall if nothing
    // resolves it. Writing here would duplicate a later keypad confirmation.
    // NOT "अच्छा ठीक है" — MEASURED, classifyReply calls that an AFFIRM, so the
    // first version of this test was exercising the confirm path and asserting
    // the unclear one. "कल आऊँगा" is genuinely unclear.
    saved = [];
    const h = mk();
    h._resolveReadback('कल आऊँगा');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(saved, [],
      `wrote a row while the keypad could still confirm it: ${JSON.stringify(saved)}`);
    assert(h._readbackDtmfPending, 'the DTMF grace window was closed — a late keypress is now ignored');
  });

  // ── 3. the drug that was silently dropped ────────────────────────────────
  await ok('THE OTHER LOSS: a never-resolved read-back is recorded at call end', async () => {
    saved = [];
    const h = mk();
    h._resolveReadback('और मुझे पेनिसिलिन से एलर्जी है।');
    await new Promise((r) => setImmediate(r));
    saved = []; // ignore the allergy; this assertion is about the DRUG

    // Drive the real endCall far enough to reach the flush, then stop.
    h._ended = false;
    h._clearSilenceTimers = () => { throw new Error('__STOP__'); };
    try { await h.endCall(); } catch (e) { if (!/__STOP__/.test(e.message)) throw e; }
    await new Promise((r) => setImmediate(r));

    const meds = saved.filter((m) => m.entityType !== 'allergy');
    assert.strictEqual(meds.length, 1,
      `the caller said "डोलो ले रहा हूँ" and the record shows no drug: ${JSON.stringify(saved)}`);
    assert.strictEqual(meds[0].canonical, 'Paracetamol');
    assert.strictEqual(meds[0].resolution, 'unconfirmed',
      'a drug nobody confirmed must not be graded as if they had');
  });

  await ok('a DTMF-confirmed read-back is NOT written twice at call end', async () => {
    saved = [];
    const h = mk();
    h._resolveReadback('कल आऊँगा');            // genuinely unclear -> grace window opens
    await new Promise((r) => setImmediate(r));
    h.onDtmf('1');                              // keypad resolves it properly
    await new Promise((r) => setImmediate(r));
    h._ended = false;
    h._clearSilenceTimers = () => { throw new Error('__STOP__'); };
    try { await h.endCall(); } catch (e) { if (!/__STOP__/.test(e.message)) throw e; }
    await new Promise((r) => setImmediate(r));

    const para = saved.filter((m) => m.canonical === 'Paracetamol');
    assert.strictEqual(para.length, 1,
      `one drug, one row — got ${para.length} with grades ${para.map((m) => m.resolution).join(', ')}`);
    assert(/affirmed/.test(para[0].resolution),
      `the keypad confirmation was overwritten by the unconfirmed flush: ${para[0].resolution}`);
  });

  // ── 3b. A DRUG AND AN ALLERGY IN ONE BREATH ─────────────────────────────
  // LIVE CALL 513a74cbbd1e1b71932eec755cc31a8c, 2026-08-12 06:51 IST — the
  // call placed to verify the fix above, which found the branch NEXT DOOR:
  //
  //   ritu     कोई दवाई चल रही है या कोई एलर्जी है जी?
  //   patient  हाँ मैं डोलो ले रहा हूँ और मुझे पेनिसिलिन से एलर्जी है।
  //   ritu     आप Dolo ले रहे हैं — मैंने सही सुना ना?
  //   patient  हाँ जी।
  //
  // Paracetamol persisted, affirmed-bare. Penicillin did not. _splitMedsAndAllergens
  // had already parsed BOTH correctly; the allergen branch only fired when there
  // were NO meds, so _split.meds was taken and _split.allergens dropped. Ritu
  // asked one question about two things and kept half the answer.
  await ok('THE ONE-BREATH TURN: a drug and an allergy both survive', async () => {
    saved = [];
    const h = mk();
    h._readbackPending = null;      // this is the meds TURN, not the read-back reply
    h._readbackDone = false;
    h._historyStage = 2;
    h.appointmentBooked = false;
    h.conversationHistory = [];
    const line = h._maybeHistoryQuestion('हाँ मैं डोलो ले रहा हूँ और मुझे पेनिसिलिन से एलर्जी है।');
    await new Promise((r) => setImmediate(r));

    const allergies = saved.filter((m) => m.entityType === 'allergy');
    assert(allergies.length >= 1,
      `the caller named an allergy in the same sentence as a drug and it was dropped: ${JSON.stringify(saved)}`);
    assert(/penicillin/i.test(allergies[0].canonical), `wrong allergen: ${allergies[0].canonical}`);
    // and the DRUG must still get its read-back — that half already worked
    assert(line && /Dolo/i.test(line),
      `the drug read-back was lost while fixing the allergy: ${JSON.stringify(line)}`);
    assert(h._readbackPending && h._readbackPending.canonical === 'Paracetamol',
      'the medication read-back is no longer pending');
  });

  // ── 4. the new grades must stay OUT of the matcher prior ────────────────
  await ok('an unconfirmed drug never becomes a prior on the next call', async () => {
    // The prior runs at PRIOR_MAX_DIST 0.50, twice the general bar. A molecule
    // we only THOUGHT we heard, fed back as a prior, makes the matcher likelier
    // to hear it again — and confirm itself into the record on the second pass.
    // The stub below HONOURS the WHERE clause rather than ignoring it, so the
    // assertion is about what the code asks for, not about what a mock returns.
    const ROWS = [
      { canonical: 'Metformin',    resolution: 'affirmed',    entity_type: 'medication' },
      { canonical: 'Atorvastatin', resolution: 'unconfirmed', entity_type: 'medication' },
      { canonical: 'Telmisartan',  resolution: 'volunteered', entity_type: 'medication' },
      { canonical: 'Penicillin',   resolution: 'volunteered', entity_type: 'allergy'    },
    ];
    db.pool.query = async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SELECT name FROM patients/i.test(s)) return { rows: [{ name: 'Prithvi' }], rowCount: 1 };
      if (/FROM patient_medications/i.test(s)) {
        const excluded = (s.match(/resolution NOT IN \(([^)]*)\)/i) || [])[1] || '';
        const banned = excluded.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
        const wantsMeds = /entity_type = 'medication'/.test(s);
        return {
          rows: ROWS.filter((r) => (!wantsMeds || r.entity_type === 'medication') && !banned.includes(r.resolution)),
          rowCount: 0,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const rows = await db.getPatientMedications('8273500806');
    const names = rows.map((r) => r.canonical).sort();
    assert.deepStrictEqual(names, ['Metformin'],
      `only caller-confirmed molecules may prime the matcher — got ${JSON.stringify(names)}`);
  });

  db.pool.query = realQuery;
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
