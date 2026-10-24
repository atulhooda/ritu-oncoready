#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'on', 'the pre-visit intake itself is under test; a booking-only profile turns it off (see test-previsit-intake-switch.js)');
// The pre-visit intake on WhatsApp — the SAME voice machine, run on a hydrated
// adapter with its state on the conversation row. Drives whatsappChannel.runTurn
// across a thread with in-memory doubles for the row, the history and the
// medication table; every turn re-hydrates from the JSON the previous turn
// wrote, as a restart would.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-WA-NO-INTAKE          — the intake never asks (prototype returns null)
//   MUTANT=MUT-WA-GUARD-IGNORES-STAGE — the advice guard ignores the persisted stage
//   MUTANT=MUT-WA-ADAPTER-STARVED    — the adapter is built without the intake's own state fields
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

if (MUTANT === 'MUT-WA-GUARD-IGNORES-STAGE') require('../medicalAdviceGuard.js').adviceGuardSuppressed = () => false;
const db = require('../db.js');
const realUpdateConversationIntake = db.updateConversationIntake;   // driven against pg-mem in [7]; stubbed for the thread sections
const store = { intake: null, hist: [], msgs: [], meds: [] };
db.getConversationHistory = async () => store.hist;
db.updateConversationIntake = async (id, i) => { store.intake = JSON.parse(JSON.stringify(i)); return true; };   // a round trip through JSON, as Postgres would
db.saveWhatsAppMessage = async (c, p, d, b, t) => { store.msgs.push({ d, b, t }); return 'm'; };
db.getPatientMedications = async () => [];
db.saveConfirmedMedication = async (m) => { store.meds.push(m); return { id: 'x' }; };
require('../tools/findPatientAppointment.js').execute = async () => ({ appointments: [] });
const lean = require('../brain-lean.js');
const leanPath = require.resolve('../brain-lean.js');
let brainCalls = 0;
require.cache[leanPath].exports = { ...lean, getLeanResponse: async () => { brainCalls++; return { text: 'ठीक है जी।', canned: false, booked: false, endCall: false }; } };
delete require.cache[require.resolve('../whatsappChannel.js')];
const wa = require('../whatsappChannel.js');
const { CallHandler } = require('../callHandler.js');
if (MUTANT === 'MUT-WA-NO-INTAKE') CallHandler.prototype._maybeHistoryQuestion = () => null;
lean._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'डॉ. दिव्या साने', specialty: 'Dermatologist', windows: [], taken: [] }] });
const L = CallHandler._INTAKE_LINES || require('../callHandler.js')._INTAKE_LINES;
const ASK_DURATION = L.HISTORY_ASK_DURATION['hi-IN'], ASK_MEDS = L.HISTORY_ASK_MEDS['hi-IN'];

const reset = () => { store.intake = null; store.hist = []; store.msgs = []; store.meds = []; brainCalls = 0; };
const turn = async (text) => {
  store.hist.push({ role: 'user', content: text });
  const conv = { id: 7, language: 'hi-IN', intake: store.intake ? JSON.stringify(store.intake) : null };   // the row hands back a JSON string
  const r = await wa.runTurn({ phone: '919999999999', conv, patientName: 'x', patientTextAll: text, patientId: null });
  store.hist.push({ role: 'assistant', content: r.text });
  return r;
};

(async () => {
  console.log('\nWHATSAPP INTAKE — the voice machine, on a thread\n');

  console.log('[1] the ladder: duration → meds → read-back → verified → brain');
  reset();
  const t1 = await turn('मुझे दो दिन से खुजली है');
  await ok('a complaint gets the duration question, LLM skipped', async () => { assert.strictEqual(t1.text, ASK_DURATION); assert.strictEqual(t1.intake, true); assert.strictEqual(brainCalls, 0); });
  await ok('stage 1 persisted on the row', async () => assert.strictEqual(store.intake.stage, 1));
  const t2 = await turn('दो दिन से');
  await ok('the answer gets the meds/allergy question', async () => { assert.strictEqual(t2.text, ASK_MEDS); assert.strictEqual(store.intake.stage, 2); });
  const t3 = await turn('Dolo 650 leta hoon');
  await ok('a recognised drug gets the read-back line, stage 2.5 with the pending persisted', async () => { assert.match(t3.text, /Dolo/); assert.strictEqual(store.intake.stage, 2.5); assert.ok(store.intake.readbackPending && store.intake.readbackPending.canonical, 'no pending on the row'); });
  const t4 = await turn('हाँ');
  await ok('a typed yes verifies: the brain answers this turn (as on voice)', async () => { assert.strictEqual(t4.intake, undefined); assert.strictEqual(brainCalls, 1); assert.strictEqual(store.intake.stage, 3); });
  await ok('the SAME patient_medications row voice would write', async () => { assert.strictEqual(store.meds.length, 1); assert.strictEqual(store.meds[0].canonical, 'Paracetamol'); assert.match(String(store.meds[0].resolution), /^affirmed/); assert.strictEqual(store.meds[0].phone, '919999999999'); assert.match(String(store.meds[0].callSid), /^wa:/); });
  await ok('the [VERIFIED] marker is persisted as an inbound row of its own type', async () => { const m = store.msgs.find((x) => x.t === 'intake-marker'); assert.ok(m, 'no marker row'); assert.match(m.b, /\[VERIFIED\]/); assert.strictEqual(m.d, 'inbound'); });
  const t5 = await turn('ठीक है, बुक कर दो');
  await ok('after stage 3 every turn goes to the brain', async () => { assert.strictEqual(t5.intake, undefined); assert.strictEqual(brainCalls, 2); });

  console.log('\n[2] the state survives a restart (every turn re-hydrates from the JSON string the row hands back)');
  reset();
  await turn('मुझे दो दिन से खुजली है');
  const snapshot = JSON.stringify(store.intake);
  store.intake = JSON.parse(snapshot);   // "process restarted"
  const t = await turn('दो दिन से');
  await ok('the thread continues at the right stage', async () => assert.strictEqual(t.text, ASK_MEDS));

  console.log('\n[3] a rushing patient is not interrogated; a plain booking ask is not either');
  reset();
  const r1 = await turn('जल्दी है, बस अपॉइंटमेंट बुक कर दो');
  await ok('no complaint → no intake, brain answers', async () => { assert.strictEqual(r1.intake, undefined); assert.strictEqual(brainCalls, 1); });

  console.log('\n[4] a day of silence starts a new episode');
  {
    const stale = { v: 1, stage: 2.5, readbackPending: { canonical: 'Paracetamol' }, at: Date.now() - wa.INTAKE_EPISODE_MS - 1000 };
    const fresh = wa.hydrateIntake({ intake: stale });
    await ok('stale state → fresh episode', async () => { assert.strictEqual(fresh.stage, 0); assert.strictEqual(fresh.readbackPending, null); });
    const live = wa.hydrateIntake({ intake: { ...stale, at: Date.now() - 60000 } });
    await ok('recent state → kept', async () => assert.strictEqual(live.stage, 2.5));
    await ok('NULL column → fresh', async () => assert.strictEqual(wa.hydrateIntake({ intake: null }).stage, 0));
  }

  console.log('\n[5] the guard stands down on the persisted stage (the meds answer is not deflected)');
  {
    const { runInboundGuards } = require('../whatsappGuards.js');
    const r = runInboundGuards('kaun si dawai loon iske liye?', 'hi-IN', { historyStage: 2 });
    await ok('stage 2 → null', async () => assert.strictEqual(r, null));
    const r2 = runInboundGuards('kaun si dawai loon iske liye?', 'hi-IN', { historyStage: 0 });
    await ok('stage 0 → medical_advice', async () => assert.strictEqual(r2 && r2.kind, 'medical_advice'));
  }

  console.log('\n[6] the adapter contract: the machine reads nothing the adapter does not hydrate');
  {
    const intake = wa.hydrateIntake({ intake: null });
    const hist = [{ role: 'user', content: 'मुझे दो दिन से खुजली है' }];
    const adapter = wa.buildIntakeAdapter({ conv: { id: 1 }, phone: '919999999999', language: 'hi-IN', history: hist, intake });
    if (MUTANT === 'MUT-WA-ADAPTER-STARVED') for (const k of ['_historyStage', '_readbackPending', '_medRepeatPending', '_readbackDone', '_medsHeld', '_durationReasked']) delete adapter[k];
    const hydrated = new Set(Object.keys(adapter));
    const proto = new Set(Object.getOwnPropertyNames(CallHandler.prototype));
    const reads = new Set();
    const p = new Proxy(adapter, { get(tgt, k, rcv) { if (typeof k === 'string') reads.add(k); return Reflect.get(tgt, k, rcv); } });
    const seq = ['मुझे दो दिन से खुजली है', 'दो दिन से', 'Dolo 650 leta hoon', 'हाँ'];
    for (const s of seq) { p.conversationHistory.push({ role: 'user', content: s }); p._maybeHistoryQuestion(s); }
    const unhydrated = [...reads].filter((k) => !hydrated.has(k) && !proto.has(k));
    await ok(`every field the machine read is hydrated or a prototype method (read ${reads.size})`, async () => assert.deepStrictEqual(unhydrated, [], `read but not hydrated: ${unhydrated.join(', ')}`));
  }

  console.log('\n[7] the column writer itself, against a pg-mem double (every other section stubs it)');
  {
    const { newDb } = require('pg-mem');
    const mem = newDb();
    mem.public.none('CREATE TABLE whatsapp_conversations (id integer PRIMARY KEY, intake jsonb)');
    mem.public.none('INSERT INTO whatsapp_conversations (id) VALUES (1)');
    const { Pool } = mem.adapters.createPg();
    const memPool = new Pool();
    const realQuery = db.pool.query;
    db.pool.query = (...a) => memPool.query(...a);
    try {
      const written = { v: 1, stage: 2.5, readbackPending: { canonical: 'Paracetamol', brand: 'Dolo' }, at: 1725400000000 };
      const okWrite = await realUpdateConversationIntake(1, written);
      const { rows } = await memPool.query('SELECT intake FROM whatsapp_conversations WHERE id = 1');
      const back = typeof rows[0].intake === 'string' ? JSON.parse(rows[0].intake) : rows[0].intake;
      await ok('updateConversationIntake writes the JSON document', async () => { assert.strictEqual(okWrite, true); assert.deepStrictEqual(back, written); });
      await ok('...and hydrateIntake reads it back to the same state', async () => assert.strictEqual(wa.hydrateIntake({ intake: rows[0].intake }, written.at + 1000).stage, 2.5));
    } finally { db.pool.query = realQuery; }
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
