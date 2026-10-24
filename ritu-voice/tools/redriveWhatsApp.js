#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// redriveWhatsApp.js — hand-run replay of dead-lettered WhatsApp sends
//
// After fixing the cause of failed sends (token rotated, template approved…),
// the operator replays them so patients still get their confirmations —
// late instead of never. NEVER scheduled, never automatic.
//
// Run:   node tools/redriveWhatsApp.js --dry-run     (list what would send)
//        node tools/redriveWhatsApp.js               (send definitive failures)
//
// Flags:
//   --dry-run                 list candidates, send nothing
//   --limit N                 max rows to process (default 50)
//   --max-age-hours N         skip rows older than N hours (default 48 — a
//                             confirmation for a long-past appointment is noise)
//   --include-indeterminate   ALSO redrive timeout/connection-drop rows.
//                             ⚠ Meta has no send idempotency key — these rows
//                             may already have a wamid on Meta's side, and a
//                             re-send would double-message the patient. Only
//                             use after confirming (webhook_events statuses /
//                             asking the patient) that nothing arrived.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { sendDlqRedrive } = require('../whatsapp');
const db = require('../db');

function argFlag(name) { return process.argv.includes(name); }
function argNum(name, dflt) {
  const i = process.argv.indexOf(name);
  const v = i > -1 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

(async () => {
  const opts = {
    dryRun: argFlag('--dry-run'),
    includeIndeterminate: argFlag('--include-indeterminate'),
    limit: argNum('--limit', 50),
    maxAgeHours: argNum('--max-age-hours', 48)
  };
  console.log(`[REDRIVE] starting with ${JSON.stringify(opts)}`);
  let exitCode = 0;
  try {
    const result = await sendDlqRedrive(opts);
    console.log(`[REDRIVE] done: ${JSON.stringify(result)}`);
    exitCode = result.failed > 0 ? 1 : 0;
  } catch (err) {
    console.error('[REDRIVE] fatal:', err.message);
    exitCode = 1;
  }
  await db.pool.end().catch(() => {});
  process.exit(exitCode);
})();
