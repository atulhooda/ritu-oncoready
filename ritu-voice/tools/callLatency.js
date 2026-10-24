#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// callLatency.js — what callers actually waited, per call, from the rows.
//
// callHandler measures every turn (eos → dispatch → reply → first audio) and
// writes the percentiles into calls.diagnostics at hangup. Until now the only
// way to read them was the Railway log, which rotates within hours. This
// prints the last N calls of THIS clinic with dead-air p50/p95 and the
// stt / llm+tool / tts split, so "is latency handled?" has a number.
//
//   railway ssh -s engageo-server-v2 -- npm run calls:latency -- --last 20
//   flags: --last N (default 20)   --all-clinics   --include-test   --detail (why a slow call was slow)
// (no parentheses or pipes on a railway ssh command line — it mangles them)
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
process.env.SKIP_BOOT_AUDIO = '1';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const ms = (v) => (v == null || !Number.isFinite(Number(v)) ? '   —' : String(Math.round(Number(v))).padStart(5));
const mask = (p) => String(p || '').replace(/\d(?=\d{4})/g, '•');

async function main() {
  const db = require('../db');
  const config = require('../config');
  const last = Math.max(1, parseInt(arg('--last', '20'), 10) || 20);
  const where = [];
  const params = [];
  if (!has('--all-clinics') && config.clinicId) { params.push(config.clinicId); where.push(`clinic_id = $${params.length}`); }
  if (!has('--include-test')) where.push('COALESCE(is_test, FALSE) = FALSE');
  params.push(last);
  const { rows } = await db.pool.query(
    `SELECT created_at, patient_phone, duration_seconds, outcome, language, diagnostics
       FROM calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`, params);
  if (!rows.length) { console.log('no calls found'); await db.pool.end(); return; }
  console.log(`\nLast ${rows.length} call(s)${config.clinicId && !has('--all-clinics') ? ' for clinic …' + String(config.clinicId).slice(-4) : ''} — dead-air = caller stopped speaking → Ritu's first audio (ms)\n`);
  console.log('  when (IST)        phone         dur  outcome      turns  p50   p95 | stt  llm  tts (p50 split)   model  tool');
  const all = [];
  for (const r of rows) {
    const d = r.diagnostics || {};
    const ls = d.latencySplit || {}; // callHandler nests the stt/llm/tts split
    const when = new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const turns = d.patientTurns ?? ls.splitTurns ?? '—';
    if (d.deadAirP50 != null && Number.isFinite(Number(d.deadAirP50))) all.push(Number(d.deadAirP50)); // null is 'no turns', not 0 ms
    console.log(`  ${when.padEnd(17)} ${mask(r.patient_phone).padEnd(13)} ${String(r.duration_seconds ?? '—').padStart(4)}  ${String(r.outcome || '—').padEnd(12)} ${String(turns).padStart(5)} ${ms(d.deadAirP50)} ${ms(d.deadAirP95)} | ${ms(ls.sttDebounceP50)} ${ms(ls.llmToolP50)} ${ms(ls.ttsFirstByteP50)}   ${ms(ls.llmOnlyP50)} ${ms(ls.toolP50)}`);
    if (has('--detail') && d.deadAirP50 != null) {
      // Why a slow call was slow: the record keeps the levers, not a per-turn trace.
      const sp = d.speculation || {}, llm = d.llm || {}, tts = d.tts || {}, cfg = d.config || {};
      const reasons = sp.cancelReasons ? Object.entries(sp.cancelReasons).map(([k, v]) => `${k}:${v}`).join(',') : '';
      console.log(`      speculation started=${sp.started ?? '—'} claimed=${sp.claimed ?? '—'} cancelled=${sp.cancelled ?? '—'}${reasons ? ' (' + reasons + ')' : ''}` +
                  ` | llm turns=${llm.turns ?? '—'} promptTokens/turn=${llm.promptTokensPerTurn ?? '—'} cachedRatio=${llm.cachedRatio ?? '—'}` +
                  ` | tts coldDials=${tts.coldDials ?? '—'}/${tts.sentences ?? '—'} | filler-masked=${ls.fillerMaskedTurns ?? '—'} | errors=${(d.criticalErrors && d.criticalErrors.length) || 0} bookFail=${d.bookFailKind || '—'}` +
                  ` | llm=${cfg.llmPrimary || cfg.llm || '—'} lang=${d.languageEffective || '—'}`);
    }
  }
  if (all.length) {
    const s = [...all].sort((a, b) => a - b);
    console.log(`\n  across ${all.length} call(s) with turns: median of per-call p50 = ${Math.round(s[Math.floor(s.length / 2)])} ms, worst p50 = ${Math.round(s[s.length - 1])} ms`);
  } else console.log('\n  no call carried turn timings (single-turn or filler-masked calls have none)');
  await db.pool.end();
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
