import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { findForbiddenRootArtifacts, runRootArtifactCheck } from "./check-root-artifacts.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-root-artifacts-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("passes when no forbidden root artifacts exist", () => {
  withTempDir((dir) => {
    assert.deepEqual(findForbiddenRootArtifacts(dir), []);
    assert.equal(runRootArtifactCheck({ root: dir, log() {}, error() {} }), 0);
  });
});

test("allows an empty root src directory", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "src"));

    assert.deepEqual(findForbiddenRootArtifacts(dir), []);
    assert.equal(runRootArtifactCheck({ root: dir, log() {}, error() {} }), 0);
  });
});

test("reports accidental root Go and src artifacts", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "go.mod"), "module accidental\n");
    writeFileSync(join(dir, "money.go"), "package money\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.tsx"), "export {};\n");

    assert.deepEqual(findForbiddenRootArtifacts(dir), ["go.mod", "money.go", "src"]);
    assert.equal(runRootArtifactCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
