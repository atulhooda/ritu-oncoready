#!/usr/bin/env node
'use strict';
require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
// The cycle lock. callHandler → crm → whatsapp: crm.js destructures from
// whatsapp.js at load, so requiring callHandler while whatsapp.js is still
// loading binds that to undefined and voice silently stops sending its
// confirmation. whatsappChannel.runIntake requires callHandler LAZILY, at call
// time. This proves, in both load orders, that crm's binding is intact after
// the lazy require has happened.
process.env.SKIP_BOOT_AUDIO = '1';
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ✓ ${n}`); } catch (e) { fail++; console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const CHILD = (first) => `
process.env.SKIP_BOOT_AUDIO = '1';
require('./tests/_bootstrap');
require('${first}');
const db = require('./db'); db.getConversationHistory = async () => []; db.updateConversationIntake = async () => true; db.saveWhatsAppMessage = async () => 'm'; db.getPatientMedications = async () => [];
(async () => {
  const wa = require('./whatsappChannel');
  await wa.runIntake({ conv: { id: 1 }, phone: '919999999999', patientId: null, language: 'hi-IN', history: [], text: 'नमस्ते', intake: wa.hydrateIntake({ intake: null }) });
  const crm = require('./crm'); const w = require('./whatsapp');
  const crmSrc = require('fs').readFileSync('./crm.js', 'utf8');
  const bound = (crmSrc.match(/const \\{([^}]*)\\} = require\\('\\.\\/whatsapp'\\)/) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
  const missingOnWhatsapp = bound.filter((n) => typeof w[n] !== 'function');
  console.log('__RESULT__' + JSON.stringify({ callHandlerLoaded: Object.keys(require.cache).some((k) => k.endsWith('/callHandler.js')), bound, missingOnWhatsapp, crmLoaded: !!crm }));
})().catch((e) => { console.log('__RESULT__' + JSON.stringify({ error: String(e.message) })); });
`;
for (const [label, first] of [['WhatsApp path first (webhook process)', './whatsapp'], ['voice path first (index.js order)', './callHandler']]) {
  const r = spawnSync(process.execPath, ['-e', CHILD(first)], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000 });
  const m = String(r.stdout || '').match(/__RESULT__(\{.*\})/);
  ok(`${label}: the lazy require ran and crm's bindings from whatsapp are functions`, () => {
    assert.ok(m, `no result: ${String(r.stderr || '').slice(-200)}`);
    const res = JSON.parse(m[1]);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.callHandlerLoaded, true, 'callHandler was never required');
    assert.ok(res.bound.length > 0, 'crm binds nothing from whatsapp? (the lock is moot — check crm.js)');
    assert.deepStrictEqual(res.missingOnWhatsapp, [], `undefined at load: ${res.missingOnWhatsapp.join(', ')}`);
  });
}
ok('whatsappChannel has no TOP-LEVEL require of callHandler', () => {
  const src = require('fs').readFileSync(require.resolve('../whatsappChannel.js'), 'utf8');   // SOURCE-TEXT-OK: structural rule, behaviour proven above
  const top = src.split('\n').filter((l) => /^const .*require\('\.\/callHandler'\)/.test(l));
  assert.deepStrictEqual(top, []);
});
console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(fail ? 1 : 0);
