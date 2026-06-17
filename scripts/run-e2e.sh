#!/usr/bin/env bash
# run-e2e.sh — run Playwright E2E reliably on macOS + Linux/CI.
#
# WHY: on macOS/Apple Silicon the system `node` is a *universal* binary; when the
# E2E webServer spawns the Paperclip server (onboard -> spawn(process.execPath))
# the x86_64 slice can be selected, which then cannot dlopen a single-arch arm64
# `sqlite3` ("incompatible architecture"). The arch preference does NOT propagate
# to that grandchild spawn, so the robust fix is to make sqlite3 a *universal*
# (x86_64+arm64) binary that loads under whichever slice the server runs.
# This step is idempotent (skips when already universal) and a no-op on Linux/CI.
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  SQ="$(find node_modules/.pnpm -maxdepth 1 -type d -name 'sqlite3@*' 2>/dev/null | head -1)/node_modules/sqlite3"
  NODE_FILE="$SQ/build/Release/node_sqlite3.node"
  if [ -f "$NODE_FILE" ] && ! { file "$NODE_FILE" | grep -q x86_64 && file "$NODE_FILE" | grep -q arm64; }; then
    echo "[run-e2e] rebuilding sqlite3 as a universal (x86_64+arm64) binary for arch-safe E2E..."
    CFLAGS="-arch x86_64 -arch arm64" CXXFLAGS="-arch x86_64 -arch arm64" LDFLAGS="-arch x86_64 -arch arm64" \
      npm rebuild --prefix "$SQ" sqlite3 >/dev/null 2>&1 || echo "[run-e2e] sqlite3 universal rebuild failed (continuing)"
  fi
fi

exec npx playwright test "$@"
