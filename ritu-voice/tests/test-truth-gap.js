#!/usr/bin/env node
// ─── SEPARATING WHAT THE STT LOST FROM WHAT WE LOST ─────────────────────────
// capture-gap.js measures facts in the TRANSCRIPT that reached the record. Its
// denominator is the STT's output, so a drug the STT never heard was never
// counted as a miss — the metric could not see its own biggest failure mode.
// Every "46.2% capture" number this project has quoted is a PROCESSING rate.
//
// On 2026-08-16 audio for 19 calls was transcribed by two models outside the
// live loop, and on call e370519a all three systems agreed the caller said
// "ನನ್ನ ಹೆಸರು ರಾಜಮ್ಮ ಅಲ್ಲ". Sarvam had heard it perfectly and the record was
// still wrong: first measured vendor/us split, 0 / 1. This is the machinery
// that turns that from an anecdote into a number over many calls.
//
// THE STT FIGURE IS A LOWER BOUND, ON PURPOSE. The independent transcripts are
// UNDIARIZED — one blob, no speaker labels — so a drug present on BOTH sides
// cannot be told apart from Ritu's own read-back of it. Counting only drugs
// absent from our side entirely sidesteps that. "At least this much" is worth
// more than a larger number carrying an asterisk.
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const assert = require('assert');
const { classifyCall } = require('../tools/truth-gap.js');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nTRUTH GAP — whose loss was it\n');

// ── 1. THE STT LOST IT ─────────────────────────────────────────────────────
ok('a drug only an independent ear heard is attributed to the STT', () => {
  const r = classifyCall(
    'ನನಗೆ ಜ್ವರ ಇದೆ',                              // ours: no drug at all
    ['ನನಗೆ ಜ್ವರ ಇದೆ ರಾತ್ರಿ ಡೋಲೋ ತಗೊಂಡೆ'],          // ear: heard the Dolo
    []);
  assert.deepStrictEqual(r.missedByStt, ['Paracetamol'], JSON.stringify(r));
  assert.deepStrictEqual(r.missedByUs, [], 'blamed on us a drug we never received');
});

ok('WHY NO DIARIZATION IS NEEDED for that call: Ritu cannot read back what she never heard', () => {
  // The whole reason this attribution is safe. If a drug is absent from our
  // transcript, no turn of Ritu's could contain it either — she generates from
  // the transcript. So its presence in the ear's blob can only be the patient.
  const r = classifyCall('कोई दवाई नहीं', ['मैं Telma लेता हूँ'], []);
  assert.deepStrictEqual(r.missedByStt, ['Telmisartan']);
});

// ── 2. WE LOST IT ──────────────────────────────────────────────────────────
ok('a drug we transcribed that never reached the record is attributed to us', () => {
  const r = classifyCall('ಬರೀ ಡೋಲೋ 650 ತಗೊಂತಾ ಇದ್ದೀನಿ', ['ಬರೀ ಡೋಲೋ 650 ತಗೊಂತಾ ಇದ್ದೀನಿ'], []);
  assert.deepStrictEqual(r.missedByUs, ['Paracetamol'], JSON.stringify(r));
  assert.deepStrictEqual(r.missedByStt, [], 'blamed the STT for a drug it transcribed correctly');
});

ok('a drug that DID reach the record counts as captured, not as a loss', () => {
  const r = classifyCall('ಬರೀ ಡೋಲೋ 650 ತಗೊಂತಾ ಇದ್ದೀನಿ', ['ಬರೀ ಡೋಲೋ 650'], ['Paracetamol']);
  assert.deepStrictEqual(r.got, ['Paracetamol'], JSON.stringify(r));
  assert.deepStrictEqual(r.missedByUs, []);
  assert.deepStrictEqual(r.missedByStt, []);
});

ok('the record is matched loosely — "Paracetamol 650" still counts as Paracetamol', () => {
  const r = classifyCall('डोलो 650 लेता हूँ', ['डोलो 650'], ['Paracetamol 650 mg']);
  assert.deepStrictEqual(r.got, ['Paracetamol'], JSON.stringify(r));
});

// ── 3. THE BUCKETS MUST NOT OVERLAP OR LEAK ────────────────────────────────
ok('every drug lands in exactly one bucket', () => {
  const r = classifyCall(
    'मैं Telma लेता हूँ और डोलो भी',
    ['मैं Telma लेता हूँ और डोलो भी, penicillin से एलर्जी है'],
    ['Telmisartan']);
  const all = [...r.got, ...r.missedByUs, ...r.missedByStt];
  assert.strictEqual(new Set(all).size, all.length, `a drug is double-counted: ${JSON.stringify(r)}`);
  assert(r.got.includes('Telmisartan'), 'the recorded drug was not credited');
  assert(r.missedByUs.includes('Paracetamol'), 'a transcribed-but-unrecorded drug was not charged to us');
  assert(r.missedByStt.includes('Penicillin'), 'a drug only the ear heard was not charged to the STT');
});

ok('several ears are unioned, not counted twice', () => {
  const r = classifyCall('ಜ್ವರ ಇದೆ', ['ರಾತ್ರಿ ಡೋಲೋ ತಗೊಂಡೆ', 'ಡೋಲೋ ತಗೊಂಡಿದ್ದೆ'], []);
  assert.deepStrictEqual(r.missedByStt, ['Paracetamol'], 'two ears hearing one drug counted it twice');
});

// ── 4. THE QUIET WAY THIS METRIC COULD LIE ─────────────────────────────────
ok('no ears at all reports NO STT loss — absence of evidence is not evidence', () => {
  // A call with no independent transcript must not read as "the STT lost
  // nothing". The CLI refuses to score such calls; this pins the same rule in
  // the pure function, because a future caller may not be so careful.
  const r = classifyCall('ಬರೀ ಡೋಲೋ ತಗೊಂತಾ ಇದ್ದೀನಿ', [], []);
  assert.deepStrictEqual(r.missedByStt, [], 'invented an STT loss with nothing to compare against');
  assert.deepStrictEqual(r.missedByUs, ['Paracetamol'], 'our own loss is still visible without a second ear');
});

ok('a call where nobody named a drug produces no numbers at all', () => {
  const r = classifyCall('ನನಗೆ ಹೊಟ್ಟೆ ನೋವಿದೆ', ['ನನಗೆ ಹೊಟ್ಟೆ ನೋವಿದೆ'], []);
  assert.deepStrictEqual([r.got, r.missedByUs, r.missedByStt], [[], [], []],
    'a drug appeared from a call with no medication in it');
});

// ── 5. THE CLI AND THE FUNCTION MUST BE THE SAME LOGIC ─────────────────────
ok('the CLI classifies through the exported function, not a second copy', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'truth-gap.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert(/classifyCall\(g\.ours,/.test(main),
    'main() no longer calls classifyCall — the reported numbers would come from a copy this test never sees');
  assert(!/const missedByStt = \[\.\.\.heard\]/.test(main),
    'main() has its own inline attribution again');
});

// ── 5b. RITU'S OWN SPEECH IS NOT THE CALLER'S ─────────────────────────────
// FIRST REAL RUN, 2026-08-16: 78 of 96 "drug mentions" were charged to the STT,
// and the top contributor was Rifampicin — present in ALL 21 calls. Cause: the
// brand lexicon has 116,492 entries and some are ordinary words —
// klinik -> Rifampicin, smile -> Carboxymethylcellulose, fever -> Paracetamol.
// The clinic is called "Smile Multispeciality Clinic", so Ritu's GREETING
// carried two false hits on every call, on the ears' side of the diff only,
// because our side was patient turns and theirs was the whole call.
//
// 81% of the headline number was the clinic's own name.
ok('THE CLINIC NAME IS NOT A DRUG: Ritu\'s speech is subtracted before matching', () => {
  const greeting = 'नमस्कार! मी ऋतू, स्माईल मल्टीस्पेशालिटी क्लिनिक मधून.';
  const ear = 'नमस्कार मी ऋतू स्माईल मल्टीस्पेशालिटी क्लिनिक मधून यार मेरे सर में दर्द है नहीं मैंने बस पैरासिटामोल ली थी';
  const without = classifyCall('यार मेरे सर में दर्द है', [ear], [], [greeting]);
  assert(!without.missedByStt.includes('Rifampicin'),
    `the clinic's own name was scored as a drug the STT lost: ${JSON.stringify(without.missedByStt)}`);
  assert(without.missedByStt.includes('Paracetamol'),
    'subtracting Ritu also removed a real drug the caller said');
});

ok('subtraction does not delete a drug the CALLER said, even if Ritu said it too', () => {
  // Ritu reads medications back, so the drug appears in her turns as well. The
  // caller's mention must survive — it is in OUR transcript, so it is scored as
  // ours either way and must never be silently erased.
  const rituReadback = 'आप Paracetamol ले रहे हैं — मैंने सही सुना ना?';
  const r = classifyCall('मैंने बस Paracetamol ली थी', ['मैंने बस पैरासिटामोल ली थी आप पैरासिटामोल ले रहे हैं'],
    ['Paracetamol'], [rituReadback]);
  assert.deepStrictEqual(r.got, ['Paracetamol'], JSON.stringify(r));
});

ok('short words are not subtracted — that would gut the ear transcript', () => {
  const { withoutRituSpeech } = require('../tools/truth-gap.js');
  const out = withoutRituSpeech('मुझे डोलो दिया था', ['है जी का को']);
  assert(/डोलो/.test(out), 'subtracting 2-letter particles removed real content');
});

// ── 6. THE BACKLOG QUERY, RUN AGAINST A REAL DATABASE ─────────────────────
// transcribe-truth.js used to default to "calls in the last 120 minutes",
// so running it the morning after a testing session printed "No matching
// calls." and stopped — the calls were 14 hours old. It now defaults to the
// actual work queue: calls with audio and no independent transcript yet.
//
// The subtle clause is `t.source <> 'sarvam-realtime'`. Production's OWN
// transcript is stored in call_truth too, so a plain EXISTS check would mark a
// call done the moment we saved our own opinion — and the tool would skip
// exactly the calls it exists to second-guess.
(async () => {
  const { setupTestDb } = require('../tools/testHelpers/setupDb');
  const { BACKLOG_SQL } = require('../tools/transcribe-truth.js');
  const { pool, clinicId } = await setupTestDb();

  const has = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='call_truth'`);
  if (!has.rows.length) {
    console.log('  ⚠ SKIPPED — call_truth absent on this backend (migration 011 not applied)');
    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  }

  // `outcome` is set because calls has CHECK (outcome IN (...)). Real Postgres
  // accepts NULL there (unknown is not false); the pg-mem double rejects it. A
  // real row has an outcome anyway, so this is the fixture being more honest
  // rather than a workaround.
  const ins = async (sid, url) => pool.query(
    `INSERT INTO calls (clinic_id, exotel_call_sid, recording_url, transcript, outcome, created_at)
     VALUES ($1,$2,$3,$4::jsonb,'hangup', NOW())`,
    [clinicId, sid, url, '[{"role":"patient","text":"a"},{"role":"ritu","text":"b"}]']);

  await ins('audio_no_truth', 'http://x/a.wav');
  await ins('audio_with_truth', 'http://x/b.wav');
  await ins('audio_ours_only', 'http://x/c.wav');
  await ins('no_audio', null);
  await pool.query(`INSERT INTO call_truth (exotel_call_sid, source, transcript) VALUES
    ('audio_with_truth','gemini-3.5','an independent ear'),
    ('audio_ours_only','sarvam-realtime','our own transcript only')`);

  const { rows } = await pool.query(BACKLOG_SQL, [50]);
  const got = rows.map((r) => r.exotel_call_sid).sort();

  await (async () => {
    await ok('the backlog is calls WITH audio and WITHOUT an independent ear', () => {
      assert(got.includes('audio_no_truth'), 'a call with audio and no truth was not queued');
      assert(!got.includes('audio_with_truth'), 'a call already transcribed was queued again — a re-run would pay for it twice');
      assert(!got.includes('no_audio'), 'a call with no recording was queued — there is nothing to transcribe');
    });

    await ok('OUR OWN transcript does not mark a call done', () => {
      assert(got.includes('audio_ours_only'),
        'a call holding only the sarvam-realtime row was treated as complete — the tool would skip ' +
        'precisely the calls it exists to second-guess');
    });
  })();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
