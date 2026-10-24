#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
// ENABLE_PREVISIT_INTAKE=off: a booking-only clinic (Skin Essence). ONE
// definition (config.previsitIntake) read by the voice intake, the WhatsApp
// intake and the prompt — so "no pre-visit questions" holds on every surface,
// deterministic and model-side alike.
//
// Mutants (each must exit 1):
//   MUTANT=MUT-INTAKE-IGNORES-SWITCH — a consumer stops reading the switch
require('./_bootstrap').unpin('ENABLE_PREVISIT_INTAKE', 'off', 'the switch itself is under test — this file drives the OFF side; the ON side runs in a child');
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const MUTANT = process.env.MUTANT || null; if (MUTANT) console.log(`  [MUTANT] ${MUTANT}\n`);

const config = require('../config.js');
const db = require('../db.js');
db.getConversationHistory = async () => [{ role: 'user', content: 'મને બે દિવસથી ખંજવાળ છે' }];
let intakeWrites = 0; db.updateConversationIntake = async () => { intakeWrites++; return true; };
db.saveWhatsAppMessage = async () => 'm'; db.getPatientMedications = async () => [];
require('../tools/findPatientAppointment.js').execute = async () => ({ appointments: [] });
const lean = require('../brain-lean.js');
const leanPath = require.resolve('../brain-lean.js');
let brainCalls = 0;
require.cache[leanPath].exports = { ...lean, getLeanResponse: async () => { brainCalls++; return { text: 'ઠીક છે.', canned: false, booked: false, endCall: false }; } };
delete require.cache[require.resolve('../whatsappChannel.js')];
const wa = require('../whatsappChannel.js');
const { CallHandler } = require('../callHandler.js');
lean._setRosterForTest({ text: '', doctors: [{ id: 'd1', name: 'Dr Daksha', specialty: 'Dermatologist', windows: [], taken: [] }] });
if (MUTANT === 'MUT-INTAKE-IGNORES-SWITCH') { try { config.previsitIntake = true; } catch (_) { /* frozen → the mutant cannot apply; it must still exit 1 below */ } }

(async () => {
  console.log('\nPRE-VISIT INTAKE SWITCH — off means off on every surface\n');
  await ok('the switch resolved OFF through config.js and runtimeConfig.js', async () => { assert.strictEqual(config.previsitIntake, MUTANT === 'MUT-INTAKE-IGNORES-SWITCH' ? true : false); assert.strictEqual(require('../runtimeConfig.js').runtimeConfig().previsitIntake, false); });

  console.log('\n[voice] a complaint gets no question and no state');
  {
    const h = Object.create(CallHandler.prototype);
    Object.assign(h, { callSid: 'sid-sw', callerPhone: '+919999999999', startTime: Date.now(), conversationHistory: [], appointmentBooked: false,
      _langCode: () => 'gu-IN', _hindiInCall: false, _historyStage: 0, _readbackPending: null, _medRepeatPending: null, _readbackDone: false, _medsHeld: false, _durationReasked: false, _priorMeds: [], confirmedMeds: [], _lastTimeExpr: null, _rmsSpeech: 0, _rmsFloor: 0, _lastTurnPeakRms: 0 });
    const ask = h._maybeHistoryQuestion('मुझे दो दिन से खुजली है');
    await ok('_maybeHistoryQuestion → null', async () => assert.strictEqual(ask, null));
    await ok('stage untouched', async () => assert.strictEqual(h._historyStage, 0));
  }

  console.log('\n[whatsapp] a complaint goes straight to the brain, nothing written to the intake column');
  {
    const r = await wa.runTurn({ phone: '919999999999', conv: { id: 3, language: 'gu-IN', intake: null }, patientName: 'x', patientTextAll: 'મને બે દિવસથી ખંજવાળ છે', patientId: null });
    await ok('brain answered', async () => { assert.strictEqual(r.intake, undefined); assert.strictEqual(brainCalls, 1); });
    await ok('no intake state written', async () => assert.strictEqual(intakeWrites, 0));
  }

  console.log('\n[prompt] the model is told NOT to ask');
  {
    const p = lean.buildSystemPrompt({}, {});
    await ok('step 3 says no pre-visit questions', async () => assert.match(p, /HISTORY MAT POOCH/));
    await ok('the ask-duration/meds instruction is absent', async () => assert.doesNotMatch(p, /HISTORY \(booking se PEHLE/));
  }

  console.log('\n[on] the same code with the switch ON asks (child process, the demo profile)');
  {
    const DRIVE = `
process.env.SKIP_BOOT_AUDIO = '1'; delete process.env.ENABLE_PREVISIT_INTAKE; delete process.env.BOOTSTRAP_PROFILE;
require('./tests/_bootstrap');
const { CallHandler } = require('./callHandler.js');
const h = Object.create(CallHandler.prototype);
Object.assign(h, { callSid: 'sid-on', callerPhone: '+919999999999', startTime: Date.now(), conversationHistory: [], appointmentBooked: false,
  _langCode: () => 'hi-IN', _hindiInCall: true, _historyStage: 0, _readbackPending: null, _medRepeatPending: null, _readbackDone: false, _medsHeld: false, _durationReasked: false, _priorMeds: [], confirmedMeds: [], _lastTimeExpr: null, _rmsSpeech: 0, _rmsFloor: 0, _lastTurnPeakRms: 0 });
console.log('__RESULT__' + JSON.stringify({ ask: h._maybeHistoryQuestion('मुझे दो दिन से खुजली है'), on: require('./config').previsitIntake, prompt: /HISTORY \\(booking se PEHLE/.test(require('./brain-lean').buildSystemPrompt({}, {})) }));
`;
    const r = spawnSync(process.execPath, ['-e', DRIVE], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000, env: { ...process.env, MUTANT: '' } });
    const m = String(r.stdout || '').match(/__RESULT__(\{.*\})/);
    await ok('switch ON → the duration question is asked and the prompt carries step 3', async () => { assert.ok(m, `child gave no result: ${String(r.stderr || '').slice(-200)}`); const res = JSON.parse(m[1]); assert.strictEqual(res.on, true); assert.ok(res.ask, 'no question asked'); assert.strictEqual(res.prompt, true); });
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (MUTANT && fail === 0) { console.log(`  ✗ MUTANT ${MUTANT} SURVIVED\n`); process.exit(1); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
