#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for brain-tools.streamResponseToolCalling (ENABLE_TOOL_STREAMING).
//
// The streaming transport is stubbed via context.stream so tests don't hit a
// real LLM. Each call to the stub returns ONE round's chunks; tool rounds
// carry toolCalls in the final {done} chunk (mirroring how the providers now
// accumulate streamed tool_call deltas), text rounds stream content pieces.
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha, skipUnlessSupported } = require('../tools/testHelpers/setupDb');
const { streamResponseToolCalling } = require('../brain-tools');

let pass = 0, fail = 0;
const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name, detail }); }
}

const stubCalendarOK = { bookAppointment: async () => ({ success: true, eventId: 'stub_gcal_stream' }) };

// Chunk text into small pieces so the sentence-assembler is exercised.
function pieces(text) { return text.match(/[\s\S]{1,6}/g) || []; }

// rounds: [{ content?: string } | { toolCalls: [...] }]. One round per stream() call.
function makeStreamStub(rounds) {
  let i = 0;
  return async function* stream() {
    const round = rounds[i++] || { content: 'ठीक है।' };
    if (round.content) {
      for (const p of pieces(round.content)) yield { content: p, done: false, provider: 'stub' };
    }
    yield { content: '', done: true, toolCalls: round.toolCalls || null, provider: 'stub' };
  };
}
function toolCall(name, args) {
  return { id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

async function collect(gen) {
  const sentences = [], events = [];
  let done = null;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.kind === 'sentence') sentences.push(ev.text);
    if (ev.kind === 'done') done = ev.result;
  }
  return { sentences, done, events };
}

async function main() {
  const { pool, clinicId } = await setupTestDb();
  skipUnlessSupported(pool, 'cteInsert', 'the streamed tool path, including the booking tool call');
  const docs = await seedSaiShradha(pool, clinicId);
  const baseCtx = { pool, clinicId, patientPhone: '+919876543210', currentDatetime: '2026-05-24T10:00:00+05:30', calendar: stubCalendarOK };

  // ─── 1: tool round → reply round; reply streams, booking executes ──────────
  console.log('\n[1] Booking: tool round (no audio) then streamed confirmation');
  {
    const stream = makeStreamStub([
      { toolCalls: [toolCall('book_appointment', {
          patient_name: 'StreamTest', doctor_id: docs['Dr. Priyanka Bhosale'].id,
          appointment_datetime: '2026-05-25T15:30:00+05:30', reason: 'consultation' })] },
      { content: 'StreamTest जी, आपकी अपॉइंटमेंट बुक हो गई है। और कुछ मदद चाहिए?' }
    ]);
    const { sentences, done, events } = await collect(streamResponseToolCalling([], { ...baseCtx, stream }));
    assert('reply streamed as ≥1 sentence',   sentences.length >= 1, JSON.stringify(sentences));
    assert('done.booked = true',              done && done.booked === true, JSON.stringify(done));
    assert('done.text non-empty',             !!(done && done.text), JSON.stringify(done));
    // Ordering: every sentence event comes AFTER tool execution (round 1 had no
    // content → first sentence is from round 2, after the calendar write).
    const firstSentenceIdx = events.findIndex(e => e.kind === 'sentence');
    assert('no audio before the tool round',  firstSentenceIdx === 0 || events.slice(0, firstSentenceIdx).every(e => e.kind !== 'sentence'));
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM appointments a JOIN patients p ON p.id=a.patient_id
       WHERE p.clinic_id=$1 AND LOWER(p.name)=LOWER($2) AND a.status='booked'`, [clinicId, 'StreamTest']);
    assert('appointment row written to DB',   rows[0].n === 1, `got ${rows[0].n}`);
  }

  // ─── 2: find_doctor round → streamed reply (no booking) ────────────────────
  console.log('\n[2] find_doctor then streamed question, booked stays false');
  {
    const stream = makeStreamStub([
      { toolCalls: [toolCall('find_doctor', { symptom: 'pet dard' })] },
      { content: 'डॉ. कपिल पाटवर्धन उपलब्ध हैं। क्या बुक करूँ?' }
    ]);
    const { sentences, done } = await collect(streamResponseToolCalling([], { ...baseCtx, stream }));
    assert('reply streamed',                  sentences.length >= 1, JSON.stringify(sentences));
    assert('booked = false',                  done && done.booked === false);
    assert('text non-empty',                  !!(done && done.text));
  }

  // ─── 3: pure conversational turn (no tool) — buffered then flushed ─────────
  console.log('\n[3] No-tool turn still produces spoken sentences + done');
  {
    const stream = makeStreamStub([
      { content: 'नमस्ते! मैं ऋतु हूँ। कैसे मदद करूँ?' }
    ]);
    const { sentences, done } = await collect(streamResponseToolCalling([], { ...baseCtx, stream }));
    assert('sentences emitted',               sentences.length >= 1, JSON.stringify(sentences));
    assert('booked = false',                  done && done.booked === false);
    assert('text matches content',            done && /ऋतु/.test(done.text));
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    console.log('\nFAILED:'); for (const f of failures) console.log(' -', f.name, f.detail ? `(${f.detail})` : '');
    process.exit(1);
  } else {
    console.log('\n✓ All tool-streaming tests passing.');
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
