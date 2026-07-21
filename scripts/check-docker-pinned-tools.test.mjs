import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findFloatingDockerBaseImages,
  findFloatingDockerVersionDefaults,
  findUnpinnedDockerToolInstalls,
  runDockerPinnedToolsCheck,
} from "./check-docker-pinned-tools.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-docker-pinned-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("findUnpinnedDockerToolInstalls flags package @latest", () => {
  const offenses = findUnpinnedDockerToolInstalls("RUN npm install --global pkg@latest\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findUnpinnedDockerToolInstalls accepts pinned package versions", () => {
  const offenses = findUnpinnedDockerToolInstalls("RUN npm install --global pkg@1.2.3 @scope/tool@4.5.6\n");
  assert.deepEqual(offenses, []);
});

test("findFloatingDockerBaseImages flags floating Node tags", () => {
  const text = "FROM node:lts-trixie-slim AS base\nFROM node:24-trixie-slim\nFROM node:latest\n";
  const offenses = findFloatingDockerBaseImages(text);
  assert.deepEqual(offenses.map((offense) => offense.lineNumber), [1, 2, 3]);
});

test("findFloatingDockerBaseImages accepts exact Node versions and digests", () => {
  const text = "FROM node:24.11.1-trixie-slim AS base\nFROM node:24.11.1@sha256:abc123\n";
  assert.deepEqual(findFloatingDockerBaseImages(text), []);
});

test("findFloatingDockerBaseImages does not flag multistage FROM aliases", () => {
  // 'FROM base AS deps' references the stage alias 'base' defined earlier —
  // it is not an unpinned external image and must not be flagged.
  const text = [
    "FROM node:24.11.1-trixie-slim AS base",
    "FROM base AS deps",
    "FROM base AS build",
    "FROM base AS production",
  ].join("\n") + "\n";
  assert.deepEqual(findFloatingDockerBaseImages(text), [],
    "multistage stage-alias FROM lines should not be flagged");
});

test("findFloatingDockerBaseImages still flags floating external images in multistage files", () => {
  // Even in a multistage file, a floating external image (e.g. node:lts) is an offense.
  const text = [
    "FROM node:24.11.1-trixie-slim AS base",
    "FROM node:lts-trixie-slim AS sidecar",
    "FROM base AS deps",
  ].join("\n") + "\n";
  const offenses = findFloatingDockerBaseImages(text);
  assert.deepEqual(offenses.map((o) => o.lineNumber), [2],
    "only the floating external image on line 2 should be flagged");
});

test("findFloatingDockerVersionDefaults flags latest defaults", () => {
  const offenses = findFloatingDockerVersionDefaults("ARG PAPERCLIPAI_VERSION=latest\nARG OTHER_VERSION=1.2.3\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("runDockerPinnedToolsCheck checks configured Dockerfiles", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "docker", "untrusted-review"), { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), "FROM node:24.11.1-trixie-slim\nRUN npm install --global pkg@1.2.3\n");
    writeFileSync(join(dir, "docker", "untrusted-review", "Dockerfile"), "FROM node:lts-trixie-slim\nRUN npm install --global other@latest\nARG TOOL_VERSION=latest\n");

    assert.equal(runDockerPinnedToolsCheck({ root: dir, dockerfiles: ["Dockerfile", "docker/untrusted-review/Dockerfile"], log() {}, error() {} }), 1);
  });
});
