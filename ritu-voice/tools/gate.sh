#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# THE DEPLOY GATE — DEFINED ONCE, RUN FROM TWO PLACES.
#
# .githooks/pre-push runs this before a push to main. .github/workflows/gate.yml
# runs the same file on GitHub. Neither owns a copy of the steps.
#
# WHY THAT MATTERS HERE SPECIFICALLY. This repo has paid for the same defect six
# times: one rule written down in two places, drifting until the two disagreed
# and only one was consulted when it counted. A gate is the worst possible place
# to repeat it — a CI job that has drifted from the local hook reports green on
# checks the hook would have failed, which is worse than having no CI at all.
#
# WHAT THIS REPLACED. Until now the gate lived ONLY in .git/hooks/pre-push:
# uncommitted, so no clone ever received it, and hardcoded to
# /Users/siddharthpathania/… so it could not run anywhere else. Every quality
# claim in this repo rested on one file on one laptop.
#
# Usage:  tools/gate.sh            # every gate; missing eval repo is FATAL
#         tools/gate.sh --ci       # in-repo gates always; eval gates if present
#
# RITU_EVALS_DIR overrides where the eval repo lives (default: ../ritu-evals).
# ═══════════════════════════════════════════════════════════════════════════
set -u

CI_MODE=0
[ "${1:-}" = "--ci" ] && CI_MODE=1

# Repo-relative, always. `git rev-parse` rather than $0 so the gate behaves the
# same whether it is invoked by the hook, by CI, or by hand from a subdirectory.
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[GATE] ✗ not inside a git repository"; exit 1; }
EVALS="${RITU_EVALS_DIR:-$REPO/../ritu-evals}"
LOGDIR="${TMPDIR:-/tmp}"

fail=0
ran=""
skipped=""

# run <label> <log-name> <failure message> <command…>
run_step() {
  label="$1"; logname="$2"; msg="$3"; shift 3
  log="$LOGDIR/gate-$logname.log"
  echo "[GATE] $label"
  if "$@" > "$log" 2>&1; then
    tail -3 "$log"
    echo "[GATE] ✓ $label"
    ran="$ran $logname"
    return 0
  fi
  tail -20 "$log"
  echo "[GATE] ✗ $msg"
  echo "[GATE]   full output: $log"
  fail=1
  return 1
}

# ─── IN-REPO GATES — these always run, everywhere ───────────────────────────

# First, because it is the fastest gate and the one most likely to catch what a
# change just broke. Added 2026-08-14: until then this gate ran everything
# EXCEPT the repo's own tests, so a regression in any of them pushed green.
run_step "lint: no-dupe-keys + no-unused-vars (eslint.config.js)" "lint" \
  "LINT FAILED — a duplicate object key or a dead name is a defect twin; push BLOCKED" \
  npx eslint .

run_step "call-path tests (tests/)" "unit" \
  "CALL-PATH TESTS FAILED — push BLOCKED" \
  node "$REPO/tools/run-tests.js"

# 2026-08-03: a `git add -A` swept an untracked migration containing
# CREATE INDEX CONCURRENTLY into a deploy. db/migrate.js wrapped it in
# BEGIN/COMMIT, Postgres refused it (25001), prestart exited 1, and the voice
# line was 502 for an hour — with every other gate green, because none of them
# runs prestart.
run_step "migration safety (would prestart survive this deploy?)" "migration" \
  "A MIGRATION WOULD CRASH prestart — the server would never boot. Push BLOCKED" \
  node "$REPO/tools/check-migration-safety.js"

# ─── EVAL-REPO GATES — they live in ritu-evals ──────────────────────────────
# Locally this repo is always present and its absence is FATAL: the laptop is
# where deploys originate, and a deploy machine that cannot run the eval suite
# must not be quietly downgraded to a weaker gate.
#
# In CI it may legitimately be absent (separate private repo, no checkout). We
# then run what we can and SAY SO — a CI green that silently covered three
# fewer checks is the drift this file exists to prevent.
if [ ! -d "$EVALS" ]; then
  if [ "$CI_MODE" = "1" ]; then
    echo "[GATE] ⚠ ritu-evals not checked out — immune suite, boot-smoke and"
    echo "[GATE]   vendor-claim checks DID NOT RUN. This CI pass is partial."
    echo "[GATE]   Set RITU_EVALS_DIR or add a checkout step to close the gap."
    skipped=" suite boot-smoke vendor-claims"
  else
    echo "[GATE] ✗ ritu-evals not found at $EVALS"
    echo "[GATE]   The eval suite, boot-smoke and vendor-claim gates cannot run."
    echo "[GATE]   Set RITU_EVALS_DIR=/path/to/ritu-evals, or clone it beside this repo."
    fail=1
  fi
else
  run_step "immune suite (frozen offline eval)" "suite" \
    "SUITE FAILED — push BLOCKED" \
    node "$EVALS/suite/run-suite.js"

  run_step "boot-smoke matrix (env-shape crash check)" "boot-smoke" \
    "BOOT-SMOKE FAILED — a deploy could crash-loop at boot. Push BLOCKED" \
    node "$EVALS/suite/smoke-boot-matrix.js"

  # 2026-07-26: added after negative_frames_count=8 shipped on a GUESS about its
  # semantics (it is N-of-M within a window, not trailing silence) and cut a
  # caller's "Dolo 650" in half for weeks. Every third-party parameter must now
  # carry DOC:/MEASURED:/ASSUMED evidence.
  run_step "vendor-claim check (every third-party param cites its evidence)" "vendor-claims" \
    "VENDOR-CLAIM CHECK FAILED — a parameter is a guess about someone else's system. Push BLOCKED" \
    node "$EVALS/tools/check-vendor-claims.js"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "[GATE] ✗ BLOCKED —ran:${ran:- none}"
  exit 1
fi
if [ -n "$skipped" ]; then
  echo "[GATE] ✓ PARTIAL PASS — ran:${ran}   NOT RUN:${skipped}"
  exit 0
fi
echo "[GATE] ✓ ALL GATES GREEN — deploy allowed"
exit 0
