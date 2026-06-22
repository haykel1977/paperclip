#!/usr/bin/env node

import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = process.cwd();
const sdkDir = join(repoRoot, "packages", "plugins", "sdk");
const scopeDir = join(packageDir, "node_modules", "@paperclipai");
const linkTarget = join(scopeDir, "plugin-sdk");

if (!existsSync(join(packageDir, "package.json"))) {
  throw new Error(`No package.json found in plugin directory: ${packageDir}`);
}

// Guard 1: sdk source directory is not present (Docker deps-only stage, or
// published npm package context) — nothing to link, exit cleanly.
if (!existsSync(sdkDir)) {
  console.log("  i SDK source not found, skipping local link (Docker / published-package context)");
  process.exit(0);
}

// Guard 2: running inside a pnpm workspace — pnpm resolves workspace:*
// dependencies natively so the dev symlink is redundant and can cause
// conflicts with the virtual store entries pnpm already manages.
const pnpmVirtualStore = join(repoRoot, "node_modules", ".pnpm");
if (existsSync(pnpmVirtualStore)) {
  console.log("  i pnpm workspace detected, skipping local link (workspace:* protocol handles resolution)");
  process.exit(0);
}

mkdirSync(scopeDir, { recursive: true });

try {
  const stat = lstatSync(linkTarget);
  if (stat.isSymbolicLink()) {
    rmSync(linkTarget, { force: true });
  } else {
    console.log("  i Keeping existing installed @paperclipai/plugin-sdk directory in place");
    process.exit(0);
  }
} catch {
  // target does not exist yet
}

const relativeSdkDir = relative(scopeDir, sdkDir);
symlinkSync(relativeSdkDir, linkTarget, "dir");

console.log(`  ✓ Linked local @paperclipai/plugin-sdk for ${packageDir}`);
