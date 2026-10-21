// ═══════════════════════════════════════════════════════════════════════════
// llm/toolCallAccumulator.js
//
// OpenAI/Groq streaming delivers tool calls as fragments across many chunks:
//   delta.tool_calls = [{ index, id?, type?, function:{ name?, arguments? } }]
// The id + function.name arrive early; function.arguments stream in pieces.
// These helpers fold those fragments (keyed by `index`) back into complete
// tool-call objects so the streaming tool-loop can execute them.
// ═══════════════════════════════════════════════════════════════════════════

function accumulateToolCallDeltas(acc, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const tc of deltas) {
    const i = tc.index ?? 0;
    if (!acc[i]) acc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) acc[i].id = tc.id;
    if (tc.type) acc[i].type = tc.type;
    if (tc.function?.name) acc[i].function.name += tc.function.name;
    if (tc.function?.arguments) acc[i].function.arguments += tc.function.arguments;
  }
}

// Drop empty slots and any fragment that never got a function name.
function finalizeToolCalls(acc) {
  const out = acc.filter((tc) => tc && tc.function && tc.function.name);
  return out.length ? out : null;
}

module.exports = { accumulateToolCallDeltas, finalizeToolCalls };
