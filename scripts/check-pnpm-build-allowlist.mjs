#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const expectedPnpmBuiltDependencies = ["esbuild", "sharp", "sqlite3"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePackageManager(packageJsonText) {
  const packageJson = JSON.parse(packageJsonText);
  const packageManager = packageJson.packageManager;
  const match = typeof packageManager === "string" ? packageManager.match(/^pnpm@(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/) : null;
  if (!match) {
    throw new Error("package.json must declare an exact pnpm packageManager version, for example pnpm@9.15.4.");
  }
  return { value: packageManager, major: Number(match[1]) };
}

function findTopLevelSection(text, name) {
  const lines = text.split(/\r?\n/);
  const headerPattern = new RegExp(`^${escapeRegExp(name)}:\\s*(?:#.*)?$`);
  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S[^:]*:/.test(line)) {
      endIndex = index;
      break;
    }
  }

  return {
    startLine: startIndex + 1,
    lines: lines.slice(startIndex + 1, endIndex),
  };
}

function parseYamlListSection(text, name) {
  const section = findTopLevelSection(text, name);
  if (!section) return { present: false, startLine: null, entries: [], invalidLines: [] };

  const entries = [];
  const invalidLines = [];
  for (let index = 0; index < section.lines.length; index += 1) {
    const line = section.lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = line.match(/^\s*-\s+([@A-Za-z0-9._/-]+)\s*(?:#.*)?$/);
    if (match) {
      entries.push({ value: match[1], lineNumber: section.startLine + index + 1 });
    } else {
      invalidLines.push({ lineNumber: section.startLine + index + 1, line: line.trim() });
    }
  }

  return { present: true, startLine: section.startLine, entries, invalidLines };
}

function parseYamlBooleanMapSection(text, name) {
  const section = findTopLevelSection(text, name);
  if (!section) return { present: false, startLine: null, entries: [], invalidLines: [] };

  const entries = [];
  const invalidLines = [];
  for (let index = 0; index < section.lines.length; index += 1) {
    const line = section.lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = line.match(/^\s+([@A-Za-z0-9._/-]+):\s*(true|false)\s*(?:#.*)?$/);
    if (match) {
      entries.push({ key: match[1], value: match[2] === "true", lineNumber: section.startLine + index + 1 });
    } else {
      invalidLines.push({ lineNumber: section.startLine + index + 1, line: line.trim() });
    }
  }

  return { present: true, startLine: section.startLine, entries, invalidLines };
}

function valuesEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function formatList(values) {
  return values.length === 0 ? "(empty)" : values.join(", ");
}

export function parseLockfilePackageNames(lockfileText) {
  const names = new Set();
  for (const line of lockfileText.split(/\r?\n/)) {
    const match = line.match(/^\s{2}((?:@[^/\s]+\/)?[^@\s:]+)@[^:\s]+:/);
    if (match) names.add(match[1]);
  }
  return names;
}

export function checkPnpmBuildAllowlist({ packageJsonText, workspaceText, lockfileText = "" }) {
  const packageManager = parsePackageManager(packageJsonText);
  const onlyBuiltDependencies = parseYamlListSection(workspaceText, "onlyBuiltDependencies");
  const allowBuilds = parseYamlBooleanMapSection(workspaceText, "allowBuilds");
  const lockfilePackageNames = parseLockfilePackageNames(lockfileText);
  const errors = [];

  if (lockfileText) {
    for (const dependency of expectedPnpmBuiltDependencies) {
      if (!lockfilePackageNames.has(dependency)) {
        errors.push(`pnpm-lock.yaml: expected lifecycle-build dependency ${dependency} is not present in the lockfile.`);
      }
    }
  }

  if (packageManager.major < 11) {
    if (allowBuilds.present) {
      errors.push(`pnpm-workspace.yaml:${allowBuilds.startLine}: allowBuilds is not active for ${packageManager.value}; use onlyBuiltDependencies instead.`);
    }
    if (!onlyBuiltDependencies.present) {
      errors.push("pnpm-workspace.yaml: missing onlyBuiltDependencies for dependency lifecycle-script approval.");
    }
    for (const invalidLine of onlyBuiltDependencies.invalidLines) {
      errors.push(`pnpm-workspace.yaml:${invalidLine.lineNumber}: expected an onlyBuiltDependencies list item: ${invalidLine.line}`);
    }

    const actual = onlyBuiltDependencies.entries.map((entry) => entry.value);
    if (onlyBuiltDependencies.present && !valuesEqual(actual, expectedPnpmBuiltDependencies)) {
      errors.push(`pnpm-workspace.yaml:${onlyBuiltDependencies.startLine}: onlyBuiltDependencies must be exactly [${formatList(expectedPnpmBuiltDependencies)}]; found [${formatList(actual)}].`);
    }
  } else {
    if (onlyBuiltDependencies.present) {
      errors.push(`pnpm-workspace.yaml:${onlyBuiltDependencies.startLine}: onlyBuiltDependencies is legacy for ${packageManager.value}; use allowBuilds instead.`);
    }
    if (!allowBuilds.present) {
      errors.push("pnpm-workspace.yaml: missing allowBuilds for dependency lifecycle-script approval.");
    }
    for (const invalidLine of allowBuilds.invalidLines) {
      errors.push(`pnpm-workspace.yaml:${invalidLine.lineNumber}: expected an allowBuilds boolean map item: ${invalidLine.line}`);
    }

    const actual = allowBuilds.entries.filter((entry) => entry.value).map((entry) => entry.key);
    const denied = allowBuilds.entries.filter((entry) => !entry.value).map((entry) => entry.key);
    if (denied.length > 0) {
      errors.push(`pnpm-workspace.yaml:${allowBuilds.startLine}: remove denied allowBuilds entries and keep only approved packages; found false entries [${formatList(denied)}].`);
    }
    if (allowBuilds.present && !valuesEqual(actual, expectedPnpmBuiltDependencies)) {
      errors.push(`pnpm-workspace.yaml:${allowBuilds.startLine}: allowBuilds must be exactly [${formatList(expectedPnpmBuiltDependencies)}]; found [${formatList(actual)}].`);
    }
  }

  return errors;
}

export function runPnpmBuildAllowlistCheck({
  root = process.cwd(),
  log = console.log,
  error = console.error,
} = {}) {
  const packageJsonText = readFileSync(resolve(root, "package.json"), "utf8");
  const workspaceText = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  const lockfileText = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  const errors = checkPnpmBuildAllowlist({ packageJsonText, workspaceText, lockfileText });

  if (errors.length > 0) {
    for (const message of errors) error(message);
    error("pnpm dependency lifecycle-script approvals must match the pinned pnpm version and stay minimal.");
    return 1;
  }

  log("  ✓  pnpm dependency lifecycle-script approvals are active and minimal.");
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runPnpmBuildAllowlistCheck());
}
