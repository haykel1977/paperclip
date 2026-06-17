#!/usr/bin/env bash
# run-e2e.sh — run Playwright E2E with an arch-consistent process tree.
#
# WHY: on Apple Silicon the system `node` can be a *universal* binary. When the
# E2E webServer spawns the Paperclip server (tsx -> spawn(process.execPath)),
# the x86_64 slice may be selected, which then cannot dlopen arm64 native
# modules (sqlite3) -> "incompatible architecture". The arch preference does NOT
# propagate to grandchild spawns, so it must be set at the ROOT of the run.
# Wrapping the whole `playwright test` invocation under `arch -arm64` makes the
# entire tree (playwright -> onboard -> server) arm64. No-op on Linux/CI and on
# non-arm64 macs.
#
# Usage: bash scripts/run-e2e.sh --config tests/e2e/playwright.config.ts [...]
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] && arch -arm64 true >/dev/null 2>&1; then
  exec arch -arm64 npx playwright test "$@"
fi

exec npx playwright test "$@"
