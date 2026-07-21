#!/usr/bin/env node

import { existsSync, mkdirSync, lstatSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

mkdirSync(scopeDir, { recursive: true });

// Remove any existing entry at linkTarget (symlink or real directory) so that
// symlinkSync never throws EEXIST. This handles three Docker build scenarios:
//
// 1. Stage deps: pnpm installs workspace packages and creates a symlink to the
//    sdk directory before postinstall runs. The symlink may point to an
//    incomplete path since source files haven't been COPYed yet. Replace it.
//
// 2. Stage build (COPY . . then pnpm re-runs postinstall): linkTarget is a
//    symlink left over from the deps stage. Replace it so it resolves to the
//    now-complete sdk source tree.
//
// 3. Local dev: linkTarget may be a real installed directory. Replace with the
//    local workspace symlink so editors and tests use the local SDK source.
try {
  lstatSync(linkTarget); // throws if not found → nothing to remove
  rmSync(linkTarget, { recursive: true, force: true });
} catch {
  // target does not exist yet — nothing to remove
}

const relativeSdkDir = relative(scopeDir, sdkDir);
symlinkSync(relativeSdkDir, linkTarget, "dir");

console.log(`  ✓ Linked local @paperclipai/plugin-sdk for ${packageDir}`);
