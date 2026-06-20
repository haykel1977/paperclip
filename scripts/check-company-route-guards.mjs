#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const defaultRoutesDir = "server/src/routes";

const routePattern = /router\.(get|post|patch|put|delete)\s*\(\s*(["'`])([^"'`]*)\2/g;
const directGuardPatterns = [
  /\bassertCompanyAccess\s*\(\s*req\s*,/,
  /\bassertCompanyPermission\s*\(\s*req\s*,/,
];
const requestCompanyScopePatterns = [
  /\breq\.query\.companyId\b/,
  /\breq\.body\.companyId\b/,
  /\bbody(?:\.|\?\.)companyId\b/,
  /\bstringQuery\s*\(\s*req\.query\.companyId\s*,\s*["']companyId["']\s*\)/,
  /\bstringBody\s*\(\s*req\.body\s*,\s*["']companyId["']\s*\)/,
];

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

function hasDirectCompanyGuard(text) {
  return directGuardPatterns.some((pattern) => pattern.test(text));
}

function collectCompanyGuardHelpers(text) {
  const helpers = [];
  const patterns = [
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\bcompanyId\b[^)]*\)\s*(?::\s*[^{}]+)?\{/g,
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\bcompanyId\b[^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/g,
  ];

  for (const pattern of patterns) {
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
      const guardedByDirectCall = hasDirectCompanyGuard(helper.body);
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

function routeUsesCompanyScope(route, routeBlock) {
  return route.includes(":companyId") || requestCompanyScopePatterns.some((pattern) => pattern.test(routeBlock));
}

export function findUnguardedCompanyRoutesInText(text, filePath = "<input>") {
  const guardedHelpers = collectCompanyGuardHelpers(text);
  const routeMatches = [...text.matchAll(routePattern)];
  const offenses = [];

  for (let index = 0; index < routeMatches.length; index += 1) {
    const match = routeMatches[index];
    const start = match.index ?? 0;
    const end = index + 1 < routeMatches.length ? routeMatches[index + 1].index ?? text.length : text.length;
    const route = match[3];
    const routeBlock = text.slice(start, end);

    if (!routeUsesCompanyScope(route, routeBlock)) {
      continue;
    }

    if (hasDirectCompanyGuard(routeBlock) || routeCallsGuardedHelper(routeBlock, guardedHelpers)) {
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

export function findUnguardedCompanyRoutes({ root = process.cwd(), routesDir = defaultRoutesDir } = {}) {
  const offenses = [];
  for (const file of listRouteFiles(root, routesDir)) {
    const relativePath = relative(root, file);
    offenses.push(...findUnguardedCompanyRoutesInText(readFileSync(file, "utf8"), relativePath));
  }
  return offenses;
}

export function runCompanyRouteGuardCheck({
  root = process.cwd(),
  routesDir = defaultRoutesDir,
  log = console.log,
  error = console.error,
} = {}) {
  const offenses = findUnguardedCompanyRoutes({ root, routesDir });

  if (offenses.length > 0) {
    for (const offense of offenses) {
      error(
        `${offense.filePath}:${offense.lineNumber}: ${offense.method} ${offense.route} must validate company access with assertCompanyAccess/assertCompanyPermission or an equivalent guarded helper.`,
      );
    }
    error("Company-scoped routes must validate access to the route company before reading or mutating company data.");
    return 1;
  }

  log("  ✓  Company-scoped routes validate route company access.");
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exit(runCompanyRouteGuardCheck());
}
