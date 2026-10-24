#!/usr/bin/env node
// Integration test for brain-tools.getResponseToolCalling().
// Real tools on pg-mem; the LLM is STUBBED with a scripted sequence so the
// loop is deterministic (no network, no model nondeterminism). Verifies:
//   - find_doctor → book_appointment round-trip executes the real tools
//   - tool results feed back into the next LLM turn
//   - a successful booking is reported (booked=true) + DB row created
//   - goodbye detection sets endCall
//   - on-call specialty routes through request_callback

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { setupTestDb, seedSaiShradha, skipUnlessSupported } = require('../tools/testHelpers/setupDb');
const { getResponseToolCalling, dedupeToolCalls } = require('../brain-tools');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A scripted "LLM": returns a queued sequence of responses. Each entry is
// either { content } (final) or { content, toolCalls:[...] } (tool round).
function scriptedLLM(sequence) {
  let i = 0;
  return async function complete(messages, opts) {
    const next = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return {
      content: next.content || '',
      toolCalls: next.toolCalls || null,
      provider: 'stub',
      model: 'stub'
    };
  };
}
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
// Calendar stub so the booking flow is deterministic and never depends on the
// live Google Calendar's state (avoids a real freebusy conflict failing the test).
const stubCalendarOK = { bookAppointment: async () => ({ success: true, eventId: 'stub_gcal_event' }) };

async function main() {
  const { pool, clinicId } = await setupTestDb();
  skipUnlessSupported(pool, 'cteInsert', 'the multi-turn tool-calling loop end to end, including the booking tool call');
  const docs = await seedSaiShradha(pool, clinicId);

  // ─── 0. dedupeToolCalls unit: collapse identical, keep different ───────
  console.log('\n[0] dedupeToolCalls — collapse exact dups, keep distinct');
  {
    const same = [toolCall('a', 'book_appointment', { d: 1 }), toolCall('b', 'book_appointment', { d: 1 })];
    const diff = [toolCall('a', 'book_appointment', { d: 1 }), toolCall('b', 'book_appointment', { d: 2 })];
    assert('identical → 1', dedupeToolCalls(same).length === 1, `got ${dedupeToolCalls(same).length}`);
    assert('different args → 2', dedupeToolCalls(diff).length === 2, `got ${dedupeToolCalls(diff).length}`);
    assert('two doctors kept (find+book distinct)',
      dedupeToolCalls([toolCall('a', 'find_doctor', { s: 'x' }), toolCall('b', 'book_appointment', { d: 1 })]).length === 2);
  }

  // ─── 1. Booking flow: find_doctor → book_appointment → confirm ─────────
  console.log('\n[1] Full booking via tool calls');
  {
    const complete = scriptedLLM([
      // turn 1: model calls find_doctor for "pet dard" (→ Internal Medicine / Patwardhan)
      { content: '', toolCalls: [toolCall('c1', 'find_doctor', { symptom: 'pet dard' })] },
      // turn 2: after seeing doctors, model calls book_appointment
      { content: '', toolCalls: [toolCall('c2', 'book_appointment', {
          patient_name: 'Siddharth',
          doctor_id: docs['Dr. Kapil Patwardhan'].id,
          appointment_datetime: '2026-05-25T19:00:00+05:30', // Monday 19:00, in Patwardhan's 18:30-20:30
          reason: 'pet dard'
      })] },
      // turn 3: final spoken confirmation
      { content: 'सिद्धार्थ जी, आपका अपॉइंटमेंट कन्फर्म हो गया है।' }
    ]);

    let toolStartCalls = 0;
    const r = await getResponseToolCalling(
      [{ role: 'user', content: 'mujhe pet dard hai, appointment chahiye' }],
      { pool, clinicId, patientPhone: '+919876543210', currentDatetime: '2026-05-24T10:00:00+05:30', complete, calendar: stubCalendarOK, onToolStart: () => { toolStartCalls++; } }
    );
    assert('booked=true', r.booked === true, JSON.stringify(r));
    assert('toolRounds=2', r.toolRounds === 2, `got ${r.toolRounds}`);
    assert('onToolStart fired once (filler hook)', toolStartCalls === 1, `got ${toolStartCalls}`);
    assert('final spoken text present', /कन्फर्म/.test(r.text));
    // Verify a real appointment row exists
    const { rows } = await pool.query(`SELECT status FROM appointments WHERE clinic_id=$1 AND status='booked'`, [clinicId]);
    assert('appointment row created', rows.length === 1, `got ${rows.length}`);
  }

  // ─── 2. On-call specialty → request_callback ───────────────────────────
  console.log('\n[2] On-call specialty routes to request_callback');
  {
    const complete = scriptedLLM([
      { content: '', toolCalls: [toolCall('c1', 'find_doctor', { symptom: 'neurology problem' })] },
      { content: '', toolCalls: [toolCall('c2', 'request_callback', {
          patient_name: 'Asha', specialty: 'Neurology', reason: 'migraine'
      })] },
      { content: 'आशा जी, हमारे न्यूरोलॉजी डॉक्टर 2-4 घंटे में कॉलबैक करेंगे।' }
    ]);
    const r = await getResponseToolCalling(
      [{ role: 'user', content: 'mujhe neurologist se baat karni hai' }],
      { pool, clinicId, patientPhone: '+919800000000', currentDatetime: '2026-05-24T10:00:00+05:30', complete }
    );
    assert('booked stays false (callback, not booking)', r.booked === false);
    // requestCallback stores the on-call doctor's canonical specialty
    // ("Neurologist" per the seed), not the patient's word ("Neurology").
    const cbRows = (await pool.query(`SELECT specialty FROM callbacks WHERE clinic_id=$1 AND patient_phone='9800000000'`, [clinicId])).rows;
    assert('callback row created', cbRows.length === 1, `got ${cbRows.length} (${cbRows.map(r=>r.specialty).join(',')})`);
    assert('spoken text mentions callback', /कॉलबैक/.test(r.text));
  }

  // ─── 3. Goodbye detection → endCall ────────────────────────────────────
  console.log('\n[3] Goodbye → endCall');
  {
    const complete = scriptedLLM([{ content: 'तो अलविदा, सिद्धार्थ जी!' }]);
    const r = await getResponseToolCalling(
      [{ role: 'user', content: 'nahi, bas itna hi' }],
      { pool, clinicId, patientPhone: '+919876543210', currentDatetime: '2026-05-24T10:00:00+05:30', complete }
    );
    assert('endCall=true on goodbye', r.endCall === true, JSON.stringify(r.text));
    assert('no tool rounds', r.toolRounds === 0);
  }

  // ─── 4. No-tool conversational turn (just talk) ────────────────────────
  console.log('\n[4] Plain conversational turn (no tools)');
  {
    const complete = scriptedLLM([{ content: 'जी बिल्कुल, आपका नाम क्या है?' }]);
    const r = await getResponseToolCalling(
      [{ role: 'user', content: 'hello' }],
      { pool, clinicId, patientPhone: '+919876543210', currentDatetime: '2026-05-24T10:00:00+05:30', complete }
    );
    assert('text returned', /नाम/.test(r.text));
    assert('endCall=false', r.endCall === false);
    assert('booked=false', r.booked === false);
  }

  console.log(`\n${pass}/${pass + fail} passing`);
  if (fail > 0) process.exit(1);
  console.log('✓ All tool-calling-loop tests passing.');
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
