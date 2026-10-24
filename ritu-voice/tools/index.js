// ═══════════════════════════════════════════════════════════════════════════
// Tool registry — single source of truth for the LLM's available tools.
//
// brain.js (Phase 4 onward) calls:
//   getAllSchemas() — array of OpenAI-spec function-call schemas, passed
//                     as `tools` to completeWithFailover().
//   executeTool(name, args, context) — invokes the right handler and returns
//                     its JSON-serializable result for the next LLM turn.
//
// Adding a new tool:
//   1. Create tools/<newTool>.js exporting { schema, execute }.
//   2. Add a require() + a key in TOOLS below.
//
// Tools added in this phase:
//   find_doctor              — symptom/specialty/name → matching doctors
//   book_appointment         — create an appointment after availability check
//   find_patient_appointment — look up caller's existing appointments
//   update_appointment       — reschedule or cancel
//   request_callback         — on-call specialist callback queue insert
// ═══════════════════════════════════════════════════════════════════════════

const findDoctor              = require('./findDoctor');
const bookAppointment         = require('./bookAppointment');
const findPatientAppointment  = require('./findPatientAppointment');
const updateAppointment       = require('./updateAppointment');
const requestCallback         = require('./requestCallback');

const TOOLS = {
  find_doctor:              findDoctor,
  book_appointment:         bookAppointment,
  find_patient_appointment: findPatientAppointment,
  update_appointment:       updateAppointment,
  request_callback:         requestCallback
};

function getAllSchemas() {
  return Object.values(TOOLS).map(t => t.schema);
}

function getToolNames() {
  return Object.keys(TOOLS);
}

async function executeTool(name, args, context) {
  const tool = TOOLS[name];
  if (!tool) {
    return {
      success: false,
      error_message: `Unknown tool: "${name}". Available: ${getToolNames().join(', ')}.`
    };
  }
  try {
    return await tool.execute(args || {}, context);
  } catch (err) {
    // Tool execution should never throw to the LLM loop — return a
    // structured error the model can react to. Internal errors are logged
    // for operator visibility.
    console.error(`[TOOLS] ${name} threw: ${err.stack || err.message}`);
    return {
      success: false,
      error_message: `Internal error in ${name}: ${err.message}`
    };
  }
}

module.exports = {
  TOOLS,
  getAllSchemas,
  getToolNames,
  executeTool
};
