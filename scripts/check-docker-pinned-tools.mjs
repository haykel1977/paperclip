#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const defaultDockerfiles = [
  "Dockerfile",
  "docker/untrusted-review/Dockerfile",
];

export function findUnpinnedDockerToolInstalls(text) {
  const offenses = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("npm install") && !line.includes("@latest")) continue;
    if (line.includes("@latest")) {
      offenses.push({ lineNumber: index + 1, line: line.trim() });
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
    const offenses = findUnpinnedDockerToolInstalls(readFileSync(path, "utf8"));
    for (const offense of offenses) {
      failed = true;
      error(`${dockerfile}:${offense.lineNumber}: avoid @latest in Docker tool installs: ${offense.line}`);
    }
  }

  if (failed) {
    error("Docker tool installs must be version-pinned for reproducible builds.");
    return 1;
  }

  log("  ✓  Docker tool installs are version-pinned.");
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runDockerPinnedToolsCheck());
}
