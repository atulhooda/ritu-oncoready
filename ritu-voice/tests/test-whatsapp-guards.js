#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// THE WHATSAPP PATH MUST REFUSE THE SAME THINGS THE PHONE REFUSES.
//
// The inbound WhatsApp path had ZERO detector calls. Tolerable while Ritu could
// only confirm and cancel; not tolerable once she can converse and book, because
// people then type what is actually wrong with them.
//
// BOTH ARMS, throughout. A guard that fires on everything is not safety, it is a
// broken product — a patient asking "kitne baje khula hai?" must reach the brain.
// So every FIRE case is matched by ORDINARY messages that must NOT fire.
//
// The self-harm arm is the one that matters most and is asserted hardest: the
// reply must carry Tele-MANAS 14416 and must NEVER say 108. An earlier version
// of the text adapter stripped the helpline sentence entirely — because that
// sentence says "please CALL Tele-MANAS", and the call-clause filter removed it.
// It would have sent someone in crisis sympathy with no number. That is why the
// assertions below check what must SURVIVE, not only what must go.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { runInboundGuards } = require('../whatsappGuards');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const A = require('assert');

// ── MUST FIRE ──────────────────────────────────────────────────────────────
const EMERGENCIES = [
  ['hi-IN', 'papa ko chest pain ho raha hai', 'romanised Hinglish'],
  ['hi-IN', 'सीने में दर्द हो रहा है', 'Devanagari'],
  ['pa-IN', 'ਮੇਰੇ ਪਾਪਾ ਨੂੰ ਸਾਹ ਨਹੀਂ ਆ ਰਿਹਾ', 'Gurmukhi — breathing'],
  ['mr-IN', 'खूप रक्त येत आहे', 'Marathi — bleeding'],
];

for (const [lang, text, why] of EMERGENCIES) {
  check(`EMERGENCY fires — ${why}`, () => {
    const hit = runInboundGuards(text, lang);
    A.ok(hit, 'no guard fired');
    A.strictEqual(hit.kind, 'emergency', `kind was ${hit.kind}`);
    A.ok(/\d/.test(hit.reply), 'reply carries no number to dial');
    // The voice line promises to end the call. On text that is simply untrue.
    A.ok(!/कॉल|\bcall\b|ਕਾਲ/i.test(hit.reply) || /\d{3}/.test(hit.reply),
      `reply still talks about ending a call: ${hit.reply}`);
  });
}

check('SELF-HARM gets Tele-MANAS, never 108', () => {
  const hit = runInboundGuards('mujhe marna hai, main suicide karna chahta hoon', 'hi-IN');
  A.ok(hit, 'no guard fired');
  A.strictEqual(hit.kind, 'self_harm', `kind was ${hit.kind}`);
  A.ok(/14416/.test(hit.reply), `Tele-MANAS 14416 MISSING from: ${hit.reply.slice(0, 120)}`);
  A.ok(!/\b108\b/.test(hit.reply), 'self-harm reply must never say 108 (that is the ambulance line)');
});

check('MEDICAL ADVICE is deflected, not answered', () => {
  const hit = runInboundGuards('bukhar ke liye kaun si dawa loon?', 'hi-IN');
  A.ok(hit, 'no guard fired — this would have reached the model');
  A.strictEqual(hit.kind, 'medical_advice', `kind was ${hit.kind}`);
  A.ok(hit.reply && hit.reply.length > 10, 'no usable reply');
});

// ── MUST NOT FIRE (the arm that keeps the product usable) ──────────────────
const ORDINARY = [
  ['hi-IN', 'kitne baje khula hai clinic?'],
  ['hi-IN', 'मुझे कल appointment चाहिए'],
  ['hi-IN', 'हाँ ठीक है, बुक कर दीजिए'],
  ['mr-IN', 'डॉक्टर कधी उपलब्ध आहेत?'],
  ['hi-IN', 'Dr. Kapil se milna hai'],
  ['hi-IN', 'fees kitni hai?'],
  ['hi-IN', 'मैं city area में रहता हूँ'],   // 'city' — the drug matcher's nemesis
  ['en-IN', 'thanks, see you tomorrow'],
];

for (const [lang, text] of ORDINARY) {
  check(`ordinary message passes through — "${text.slice(0, 34)}"`, () => {
    const hit = runInboundGuards(text, lang);
    A.strictEqual(hit, null, `guard ${hit && hit.kind} fired on an ordinary message: ${hit && hit.detail}`);
  });
}

check('empty / whitespace input is not a guard hit', () => {
  A.strictEqual(runInboundGuards('', 'hi-IN'), null);
  A.strictEqual(runInboundGuards('   ', 'hi-IN'), null);
  A.strictEqual(runInboundGuards(null, 'hi-IN'), null);
});

// ── ordering: emergency outranks everything else ───────────────────────────
check('emergency wins over an advice-shaped question in the same message', () => {
  // Reads as both "what medicine should I take" and a cardiac emergency.
  const hit = runInboundGuards('chest pain ho raha hai, kaun si dawa loon?', 'hi-IN');
  A.ok(hit, 'nothing fired');
  A.strictEqual(hit.kind, 'emergency', `the most dangerous reading must win, got ${hit.kind}`);
});

// ── the checks must be able to fail ────────────────────────────────────────
check('MUTATION: the detector is reachable and discriminating', () => {
  A.ok(runInboundGuards('chest pain', 'hi-IN'), 'nothing fires at all — every FIRE case above is vacuous');
  A.strictEqual(runInboundGuards('namaste', 'hi-IN'), null, 'everything fires — every PASS case above is vacuous');
});

// ─── the advice guard stands down on the persisted intake stage, exactly as voice ───
console.log('\n[stage] historyStage from whatsapp_conversations.intake');
{
  const { runInboundGuards } = require('../whatsappGuards.js');
  const kind = (o) => { const r = runInboundGuards('kaun si dawai loon iske liye?', 'hi-IN', o); return r ? r.kind : null; };
  check('stage 2 (Ritu just asked meds) → the answer is not deflected', () => A.strictEqual(kind({ historyStage: 2 }), null));
  check('stage 2.5 (read-back pending) → still deflected: exactly 2, as medicalAdviceGuard requires', () => A.strictEqual(kind({ historyStage: 2.5 }), 'medical_advice'));
  check('stage 0 → deflected', () => A.strictEqual(kind({ historyStage: 0 }), 'medical_advice'));
  check('no stage known (thread predates the column) → the last-outbound regex still stands in', () => A.strictEqual(kind({ lastOutbound: 'कोई दवाई चल रही है या एलर्जी?' }), null));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
