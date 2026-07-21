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
  // Single-pass: aliases are registered only when their FROM ... AS <name>
  // line is processed. A FROM referencing a name not yet defined is an
  // external image reference and must be pinned.
  const definedAliases = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripDockerfileInlineComment(lines[index]).trim();
    // Parse the FROM tokens
    const tokens = stripped.split(/\s+/);
    if (tokens[0]?.toUpperCase() !== "FROM") continue;

    // Skip platform flags (--platform=...)
    let imageIndex = 1;
    while (tokens[imageIndex]?.startsWith("--")) imageIndex += 1;

    const image = tokens[imageIndex];
    if (!image) continue;

    // Check for AS <alias>
    const asIndex = tokens.findIndex((t, i) => i > imageIndex && t.toUpperCase() === "AS");
    const alias = asIndex > 0 ? tokens[asIndex + 1] : null;

    // If the image is a previously defined stage alias, it's an internal
    // multi-stage reference — not an external image.
    if (definedAliases.has(image)) {
      // Register alias for this stage too if present
      if (alias) definedAliases.add(alias);
      continue;
    }

    // External image: must be pinned
    if (!isPinnedNodeImage(image)) {
      offenses.push({ lineNumber: index + 1, image, line: lines[index].trim() });
    }

    // Register alias AFTER processing (forward references remain unresolved)
    if (alias) definedAliases.add(alias);
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
