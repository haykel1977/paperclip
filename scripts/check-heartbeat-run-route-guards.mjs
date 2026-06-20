#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const defaultRoutesDir = "server/src/routes";

const routePattern = /router\.(get|post|patch|put|delete)\s*\(\s*(["'`])([^"'`]*)\2/g;
const runReadGuardPatterns = [
  /\bassertRunReadAllowed\s*\(\s*req\s*,\s*res\s*,/,
];
const companyRunReadGuardPatterns = [
  /\bassertCompanyRunReadAllowed\s*\(\s*req\s*,\s*res\s*,/,
  /action\s*:\s*["']company_scope:read["']/,
];
const heartbeatRunRoutePattern = /^\/heartbeat-runs\/:[^/]+(?:\/(?:events|log|workspace-operations))?$/;
const companyHeartbeatRunRoutePattern = /^\/companies\/:companyId\/(?:heartbeat-runs|live-runs)$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) inString = "";
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function hasAnyGuard(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function collectGuardHelpers(text, patterns) {
  const helpers = [];
  const helperPatterns = [
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{}]+)?\{/g,
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/g,
  ];

  for (const pattern of helperPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const openIndex = text.indexOf("{", match.index);
      const closeIndex = findMatchingBrace(text, openIndex);
      if (closeIndex < openIndex) continue;
      helpers.push({
        name: match[1],
        body: text.slice(openIndex, closeIndex + 1),
        guarded: false,
      });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const helper of helpers) {
      if (helper.guarded) continue;
      const guardedByDirectCall = hasAnyGuard(helper.body, patterns);
      const guardedByHelper = helpers.some(
        (other) => other.guarded && new RegExp(`\\b${escapeRegExp(other.name)}\\s*\\(`).test(helper.body),
      );
      if (guardedByDirectCall || guardedByHelper) {
        helper.guarded = true;
        changed = true;
      }
    }
  }

  return helpers.filter((helper) => helper.guarded).map((helper) => helper.name);
}

function routeCallsGuardedHelper(routeBlock, helperNames) {
  return helperNames.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(routeBlock));
}

function routeRequiredGuardPatterns(method, route) {
  if (method !== "get") return null;
  if (heartbeatRunRoutePattern.test(route)) return runReadGuardPatterns;
  if (companyHeartbeatRunRoutePattern.test(route)) return companyRunReadGuardPatterns;
  return null;
}

export function findHeartbeatRunRoutesMissingBoundaryGuardInText(text, filePath = "<input>") {
  const runGuardedHelpers = collectGuardHelpers(text, runReadGuardPatterns);
  const companyRunGuardedHelpers = collectGuardHelpers(text, companyRunReadGuardPatterns);
  const routeMatches = [...text.matchAll(routePattern)];
  const offenses = [];

  for (let index = 0; index < routeMatches.length; index += 1) {
    const match = routeMatches[index];
    const start = match.index ?? 0;
    const end = index + 1 < routeMatches.length ? routeMatches[index + 1].index ?? text.length : text.length;
    const method = match[1].toLowerCase();
    const route = match[3];
    const requiredGuardPatterns = routeRequiredGuardPatterns(method, route);
    if (!requiredGuardPatterns) continue;

    const routeBlock = text.slice(start, end);
    const guardedHelpers = requiredGuardPatterns === runReadGuardPatterns
      ? runGuardedHelpers
      : companyRunGuardedHelpers;

    if (hasAnyGuard(routeBlock, requiredGuardPatterns) || routeCallsGuardedHelper(routeBlock, guardedHelpers)) {
      continue;
    }

    offenses.push({
      filePath,
      lineNumber: lineNumberAt(text, start),
      method: match[1].toUpperCase(),
      route,
    });
  }

  return offenses;
}

function listRouteFiles(root, routesDir) {
  const baseDir = resolve(root, routesDir);
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && path.endsWith(".ts")) {
        files.push(path);
      }
    }
  }

  walk(baseDir);
  return files;
}

export function findHeartbeatRunRoutesMissingBoundaryGuard({ root = process.cwd(), routesDir = defaultRoutesDir } = {}) {
  const offenses = [];
  for (const file of listRouteFiles(root, routesDir)) {
    const relativePath = relative(root, file);
    offenses.push(...findHeartbeatRunRoutesMissingBoundaryGuardInText(readFileSync(file, "utf8"), relativePath));
  }
  return offenses;
}

export function runHeartbeatRunRouteGuardCheck({
  root = process.cwd(),
  routesDir = defaultRoutesDir,
  log = console.log,
  error = console.error,
} = {}) {
  const offenses = findHeartbeatRunRoutesMissingBoundaryGuard({ root, routesDir });

  if (offenses.length > 0) {
    for (const offense of offenses) {
      error(
        `${offense.filePath}:${offense.lineNumber}: ${offense.method} ${offense.route} must validate heartbeat run read authorization with assertRunReadAllowed/assertCompanyRunReadAllowed or an equivalent guarded helper.`,
      );
    }
    error("Heartbeat run read routes must enforce run/issue/company-scope authorization boundaries, not just company membership.");
    return 1;
  }

  log("  ✓  Heartbeat run read routes validate run authorization boundaries.");
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runHeartbeatRunRouteGuardCheck());
}
