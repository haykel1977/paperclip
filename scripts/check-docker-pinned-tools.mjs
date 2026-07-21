#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const defaultDockerfiles = [
  "Dockerfile",
  "docker/Dockerfile.onboard-smoke",
  "docker/openclaw-smoke/Dockerfile",
  "docker/untrusted-review/Dockerfile",
];

function stripDockerfileInlineComment(line) {
  const hashIndex = line.indexOf("#");
  return hashIndex >= 0 ? line.slice(0, hashIndex) : line;
}

export function findUnpinnedDockerToolInstalls(text) {
  const offenses = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripDockerfileInlineComment(lines[index]);
    if (!line.includes("npm install") && !line.includes("@latest")) continue;
    if (line.includes("@latest")) {
      offenses.push({ lineNumber: index + 1, line: lines[index].trim() });
    }
  }
  return offenses;
}

export function findFloatingDockerVersionDefaults(text) {
  const offenses = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripDockerfileInlineComment(lines[index]);
    if (/^\s*ARG\s+[A-Z0-9_]*VERSION\s*=\s*latest\s*$/i.test(line)) {
      offenses.push({ lineNumber: index + 1, line: lines[index].trim() });
    }
  }
  return offenses;
}

function parseFromImage(line) {
  const tokens = stripDockerfileInlineComment(line).trim().split(/\s+/);
  if (tokens[0]?.toUpperCase() !== "FROM") return null;
  let imageIndex = 1;

  while (tokens[imageIndex]?.startsWith("--")) imageIndex += 1;
  return tokens[imageIndex] ?? null;
}

function isPinnedNodeImage(image) {
  const [imageWithoutDigest, digest] = image.split("@");
  if (digest?.startsWith("sha256:")) return true;
  const colonIndex = imageWithoutDigest.lastIndexOf(":");
  if (colonIndex < 0) return false;
  const name = imageWithoutDigest.slice(0, colonIndex);
  const tag = imageWithoutDigest.slice(colonIndex + 1);
  if (name !== "node" && !name.endsWith("/node")) return true;
  return /^\d+\.\d+\.\d+[-\w.]*$/.test(tag);
}

export function findFloatingDockerBaseImages(text) {
  const offenses = [];
  const lines = text.split("\n");

  // Collect stage aliases defined via 'FROM <image> AS <alias>' so that
  // subsequent 'FROM <alias> AS <next>' lines (multistage references) are
  // not mistakenly flagged as unpinned external images.
  const definedStages = new Set();
  for (const line of lines) {
    const tokens = stripDockerfileInlineComment(line).trim().split(/\s+/);
    if (tokens[0]?.toUpperCase() !== "FROM") continue;
    const asIndex = tokens.findIndex((t) => t.toUpperCase() === "AS");
    if (asIndex > 0 && tokens[asIndex + 1]) {
      definedStages.add(tokens[asIndex + 1].toLowerCase());
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const image = parseFromImage(lines[index]);
    if (!image) continue;
    // Skip references to a previously defined stage alias.
    if (definedStages.has(image.toLowerCase())) continue;
    if (!isPinnedNodeImage(image)) {
      offenses.push({ lineNumber: index + 1, image, line: lines[index].trim() });
    }
  }
  return offenses;
}

export function runDockerPinnedToolsCheck({
  root = process.cwd(),
  dockerfiles = defaultDockerfiles,
  log = console.log,
  error = console.error,
} = {}) {
  let failed = false;
  for (const dockerfile of dockerfiles) {
    const path = resolve(root, dockerfile);
    const text = readFileSync(path, "utf8");

    const installOffenses = findUnpinnedDockerToolInstalls(text);
    for (const offense of installOffenses) {
      failed = true;
      error(`${dockerfile}:${offense.lineNumber}: avoid @latest in Docker tool installs: ${offense.line}`);
    }

    const baseImageOffenses = findFloatingDockerBaseImages(text);
    for (const offense of baseImageOffenses) {
      failed = true;
      error(`${dockerfile}:${offense.lineNumber}: pin Node base images to an exact version or digest: ${offense.line}`);
    }

    const versionDefaultOffenses = findFloatingDockerVersionDefaults(text);
    for (const offense of versionDefaultOffenses) {
      failed = true;
      error(`${dockerfile}:${offense.lineNumber}: avoid latest as a Docker version default: ${offense.line}`);
    }
  }

  if (failed) {
    error("Docker tool installs, version defaults, and Node base images must be pinned for reproducible builds.");
    return 1;
  }

  log("  ✓  Docker tool installs, version defaults, and Node base images are pinned.");
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runDockerPinnedToolsCheck());
}
