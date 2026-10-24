#!/bin/sh
# Point git at the committed hooks. Run once per clone:
#
#     sh tools/install-hooks.sh
#
# Without this, .githooks/ is just files — git keeps looking in .git/hooks,
# which a clone never receives. That gap is exactly what this directory fixes,
# so the last step cannot be left implicit.
set -eu

REPO="$(git rev-parse --show-toplevel)"
git -C "$REPO" config core.hooksPath .githooks
chmod +x "$REPO/.githooks/pre-push" "$REPO/tools/gate.sh" 2>/dev/null || true

echo "✓ core.hooksPath = .githooks"
echo "  A push to main now runs tools/gate.sh first."
echo ""
echo "  Verify it is live:   git config core.hooksPath"
echo "  Run the gate by hand: sh tools/gate.sh"
