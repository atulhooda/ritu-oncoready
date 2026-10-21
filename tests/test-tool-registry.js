#!/usr/bin/env node
// Smoke test for tools/index.js — confirms all 5 tools are wired correctly
// and that the registry's getAllSchemas() returns OpenAI-compatible function
// schemas suitable for direct pass-through to completeWithFailover().

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { TOOLS, getAllSchemas, getToolNames, executeTool } = require('../tools');

let pass = 0, fail = 0, failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push({ name }); }
}

const EXPECTED_TOOLS = [
  'find_doctor',
  'book_appointment',
  'find_patient_appointment',
  'update_appointment',
  'request_callback'
];

console.log('\n[1] Registry shape');
const names = getToolNames();
assert('5 tools registered', names.length === 5, `got ${names.length}`);
for (const n of EXPECTED_TOOLS) assert(`registered: ${n}`, names.includes(n));

console.log('\n[2] Schemas are OpenAI-compatible');
const schemas = getAllSchemas();
assert('schemas is array of 5', Array.isArray(schemas) && schemas.length === 5);
for (const s of schemas) {
  const ok = s && s.type === 'function' && s.function && s.function.name && s.function.parameters;
  assert(`schema for ${s?.function?.name || '?'} has type+function+parameters`, ok);
}

console.log('\n[3] executeTool routes by name');
(async () => {
  // Calling an unknown tool returns a structured error, not a throw.
  const r = await executeTool('does_not_exist', {}, {});
  assert('unknown tool returns error', r.success === false && /Unknown tool/i.test(r.error_message));

  // Calling a real tool with missing context returns a structured error.
  const r2 = await executeTool('find_doctor', { symptom: 'fever' }, {});
  assert('missing context surfaces error', r2.success === false && /context/i.test(r2.error_message), r2.error_message);

  console.log(`\n${pass}/${pass + fail} passing`);
  if (failures.length > 0) {
    for (const f of failures) console.log(' -', f.name);
    process.exit(1);
  }
  console.log('\n✓ All registry tests passing.');
})();
