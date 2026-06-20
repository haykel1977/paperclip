import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { findUnpinnedDockerToolInstalls, runDockerPinnedToolsCheck } from "./check-docker-pinned-tools.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-docker-pinned-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("findUnpinnedDockerToolInstalls flags @latest", () => {
  const offenses = findUnpinnedDockerToolInstalls("RUN npm install --global pkg@latest\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findUnpinnedDockerToolInstalls accepts pinned versions", () => {
  const offenses = findUnpinnedDockerToolInstalls("RUN npm install --global pkg@1.2.3 @scope/tool@4.5.6\n");
  assert.deepEqual(offenses, []);
});

test("runDockerPinnedToolsCheck checks configured Dockerfiles", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "docker", "untrusted-review"), { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), "RUN npm install --global pkg@1.2.3\n");
    writeFileSync(join(dir, "docker", "untrusted-review", "Dockerfile"), "RUN npm install --global other@latest\n");

    assert.equal(runDockerPinnedToolsCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
