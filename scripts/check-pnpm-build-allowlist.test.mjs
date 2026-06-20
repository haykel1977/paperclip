import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { checkPnpmBuildAllowlist, runPnpmBuildAllowlistCheck } from "./check-pnpm-build-allowlist.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-pnpm-build-allowlist-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packageJson(packageManager = "pnpm@9.15.4") {
  return JSON.stringify({ packageManager });
}

const pnpm9Workspace = `packages:
  - cli

onlyBuiltDependencies:
  - esbuild
  - sharp
  - sqlite3
`;

test("accepts the minimal pnpm 9 lifecycle-build allowlist", () => {
  assert.deepEqual(checkPnpmBuildAllowlist({ packageJsonText: packageJson(), workspaceText: pnpm9Workspace }), []);

  withTempDir((dir) => {
    writeFileSync(join(dir, "package.json"), packageJson());
    writeFileSync(join(dir, "pnpm-workspace.yaml"), pnpm9Workspace);

    assert.equal(runPnpmBuildAllowlistCheck({ root: dir, log() {}, error() {} }), 0);
  });
});

test("rejects allowBuilds when the pinned pnpm version is 9", () => {
  const workspaceText = `packages:
  - cli

allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
`;

  const errors = checkPnpmBuildAllowlist({ packageJsonText: packageJson(), workspaceText });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /allowBuilds is not active for pnpm@9\.15\.4/);
  assert.match(errors[1], /missing onlyBuiltDependencies/);
});

test("rejects extra lifecycle-build approvals", () => {
  const workspaceText = `${pnpm9Workspace}  - node-gyp
`;

  const errors = checkPnpmBuildAllowlist({ packageJsonText: packageJson(), workspaceText });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /onlyBuiltDependencies must be exactly \[esbuild, sharp, sqlite3\]/);
});

test("rejects malformed onlyBuiltDependencies entries", () => {
  const workspaceText = `packages:
  - cli

onlyBuiltDependencies:
  esbuild: true
  sharp: true
  sqlite3: true
`;

  const errors = checkPnpmBuildAllowlist({ packageJsonText: packageJson(), workspaceText });
  assert.equal(errors.length, 4);
  assert.match(errors[0], /expected an onlyBuiltDependencies list item/);
  assert.match(errors[3], /found \[\(empty\)\]/);
});

test("accepts allowBuilds only for pnpm 11 and newer", () => {
  const workspaceText = `packages:
  - cli

allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
`;

  assert.deepEqual(checkPnpmBuildAllowlist({ packageJsonText: packageJson("pnpm@11.0.0"), workspaceText }), []);
});
