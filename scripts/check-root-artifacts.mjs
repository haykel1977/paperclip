#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const forbiddenRootArtifacts = [
  "go.mod",
  "go.sum",
  "money.go",
  "money_test.go",
  "src",
];

function artifactExists(root, artifact) {
  const path = resolve(root, artifact);
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isDirectory()) return true;
  return readdirSync(path).length > 0;
}

export function findForbiddenRootArtifacts(root = process.cwd()) {
  return forbiddenRootArtifacts.filter((artifact) => artifactExists(root, artifact));
}

export function runRootArtifactCheck({ root = process.cwd(), log = console.log, error = console.error } = {}) {
  const found = findForbiddenRootArtifacts(root);
  if (found.length === 0) {
    log("  ✓  No unexpected root-level app artifacts found.");
    return 0;
  }

  error("Unexpected root-level app artifacts found:");
  for (const artifact of found) {
    error(`  - ${artifact}`);
  }
  error("\nPaperclip source belongs in server/, ui/, cli/, packages/, tests/, docs/, or scripts/. Remove accidental root-level app files.");
  return 1;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runRootArtifactCheck());
}
