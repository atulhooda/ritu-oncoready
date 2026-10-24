#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// STEREOSCOPIC SECOND PASS (S2 T9 / advisor idea ①) — post-call accuracy
// recovery. Re-transcribes a call recording through Sarvam REST in TWO output
// modes (codemix + transliterate) and reconciles medical entities: two views
// of the same audio triangulate what the live stream mangled or dropped.
//
// POST-CALL, OFF the latency path, costs one batch transcription per mode —
// no live socket, no second live-stream fee (the exact double-cost trap the
// unit-economics work flagged). Runs by hand or from a post-call job.
//
// RECONCILE RULES (S2 §4 — entity-level, never word-level ROVER):
//   agree      → both views resolve the same canonical drug → HIGH confidence
//   one-view   → only one view found it → BACKFILL CANDIDATE (dashboard flag,
//                never auto-written into the record)
//   conflict   → views resolve different drugs → CONFLICT (both surfaced,
//                audio link, human adjudicates — never auto-pick)
//
// USAGE:
//   node tools/secondPass.js <audio.wav|url> [--out report.json]   (live, paid)
//   node tools/secondPass.js --mock <fixture.json> [--out r.json]  (offline)
// Mock fixture: { "codemix": "<transcript>", "transliterate": "<transcript>" }
//
// LIVE-API NOTE: uses POST https://api.sarvam.ai/speech-to-text (multipart,
// api-subscription-key header, model=saaras:v3) with the mode parameter the
// streaming socket honors.
//
// FIXED 2026-07-25 — this tool had NEVER produced two real views. It sent
// mode='transliterate', which is not in the API enum (transcribe | translate |
// verbatim | translit | codemix), so that call either 422'd or silently fell
// back to the default. Both "views" were therefore the same view and every
// agree/backfill/conflict number this tool ever printed was meaningless. The
// views_identical flag existed to catch exactly this and would have caught it
// on the first live run — which never happened. Correct value: 'translit'.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { findDrugMention } = require(path.join(__dirname, '..', 'readback'));

function extractEntities(transcript) {
  // Scan every Latin token window for a drug resolution (readback's measured
  // Levenshtein matcher, recall@3 ~100% on NLEM). Collect unique canonicals
  // with their surfaces.
  const found = new Map();
  const words = String(transcript || '').split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (const span of [words[i], words.slice(i, i + 2).join(' ')]) {
      const m = findDrugMention(span);
      if (m.mentioned && !found.has(m.canonical)) {
        found.set(m.canonical, { canonical: m.canonical, surface: m.surface, score: m.score });
      }
    }
  }
  return [...found.values()];
}

function reconcile(codemixEntities, translitEntities) {
  const a = new Map(codemixEntities.map(e => [e.canonical, e]));
  const b = new Map(translitEntities.map(e => [e.canonical, e]));
  const agree = [], oneView = [];
  for (const [canon, e] of a) {
    if (b.has(canon)) agree.push({ ...e, confidence: 'high', views: 2 });
    else oneView.push({ ...e, view: 'codemix', confidence: 'backfill-candidate' });
  }
  for (const [canon, e] of b) {
    if (!a.has(canon)) oneView.push({ ...e, view: 'transliterate', confidence: 'backfill-candidate' });
  }
  // conflict = same SURFACE resolving to different canonicals across views
  const conflicts = [];
  for (const ea of codemixEntities) for (const eb of translitEntities) {
    if (ea.surface === eb.surface && ea.canonical !== eb.canonical) {
      conflicts.push({ surface: ea.surface, codemix: ea.canonical, transliterate: eb.canonical, action: 'human-adjudicate' });
    }
  }
  return { agree, oneView, conflicts };
}

// The exact enum Sarvam's speech-to-text accepts. Anything else is silently
// wrong (see the FIXED note in the header) — validate before spending a call.
const VALID_MODES = ['transcribe', 'translate', 'verbatim', 'translit', 'codemix'];

async function transcribeLive(audioPath, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`invalid mode '${mode}' — must be one of ${VALID_MODES.join(' | ')}`);
  }
  const axios = require('axios');
  const FormData = require('form-data');
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not set');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'saaras:v3');
  form.append('mode', mode);
  const res = await axios.post('https://api.sarvam.ai/speech-to-text', form, {
    headers: { ...form.getHeaders(), 'api-subscription-key': apiKey }, timeout: 120000,
  });
  return (res.data && (res.data.transcript || res.data.text)) || '';
}

(async () => {
  const args = process.argv.slice(2);
  const mock = args.includes('--mock');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx > -1 ? args[outIdx + 1] : null;
  const input = args.filter(a => a !== '--mock' && a !== outPath && a !== '--out')[0];
  if (!input) { console.error('usage: secondPass.js <audio|--mock fixture.json> [--out report.json]'); process.exit(2); }

  let codemix, transliterate;
  if (mock) {
    const fx = JSON.parse(fs.readFileSync(input, 'utf8'));
    codemix = fx.codemix; transliterate = fx.transliterate;
    console.log('[2ND-PASS] mock mode — fixture transcripts loaded');
  } else {
    console.log('[2ND-PASS] transcribing (codemix)…');
    codemix = await transcribeLive(input, 'codemix');
    console.log('[2ND-PASS] transcribing (translit)…');
    transliterate = await transcribeLive(input, 'translit');
  }

  const viewsIdentical = String(codemix).trim() === String(transliterate).trim();
  const ce = extractEntities(codemix), te = extractEntities(transliterate);
  const rec = reconcile(ce, te);

  const report = {
    generated_by: 'tools/secondPass.js', mode: mock ? 'mock' : 'live',
    views_identical: viewsIdentical,
    entities: { codemix: ce, transliterate: te },
    reconciliation: rec,
    summary: `${rec.agree.length} agreed (high-conf) · ${rec.oneView.length} single-view backfill candidate(s) · ${rec.conflicts.length} conflict(s)`,
  };
  console.log('\n[2ND-PASS] ' + report.summary);
  if (viewsIdentical && !mock) console.log('[2ND-PASS] ⚠ both modes returned IDENTICAL text — REST may be ignoring the mode param (verify with Sarvam)');
  for (const e of rec.agree) console.log(`  AGREE     ${e.canonical}  (heard "${e.surface}")`);
  for (const e of rec.oneView) console.log(`  BACKFILL? ${e.canonical}  (only in ${e.view}, heard "${e.surface}") — dashboard flag, never auto-write`);
  for (const c of rec.conflicts) console.log(`  CONFLICT  "${c.surface}" → ${c.codemix} vs ${c.transliterate} — human adjudicates`);
  if (outPath) { fs.writeFileSync(outPath, JSON.stringify(report, null, 2)); console.log(`[2ND-PASS] report → ${outPath}`); }
})().catch(e => { console.error('[2ND-PASS] FAILED:', e.message); process.exit(1); });
