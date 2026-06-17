import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePluginUiDir } from "../routes/plugin-ui-static.js";

function mkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

describe("resolvePluginUiDir", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  function makeTempDir() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-ui-static-"));
    return tempDir;
  }

  it("resolves UI directories inside npm-installed plugin packages", () => {
    const root = makeTempDir();
    const localPluginDir = path.join(root, "plugins");
    const packageRoot = path.join(localPluginDir, "node_modules", "paperclip-plugin-safe");
    const uiDir = path.join(packageRoot, "dist", "ui");
    mkdirp(uiDir);

    expect(resolvePluginUiDir(localPluginDir, "paperclip-plugin-safe", "./dist/ui")).toBe(
      fs.realpathSync(uiDir),
    );
  });

  it("rejects manifest UI entrypoints that escape the plugin package root", () => {
    const root = makeTempDir();
    const localPluginDir = path.join(root, "plugins");
    const packageRoot = path.join(localPluginDir, "node_modules", "paperclip-plugin-safe");
    const outsideUiDir = path.join(root, "outside-ui");
    mkdirp(packageRoot);
    mkdirp(outsideUiDir);

    const escapingEntrypoint = path.relative(packageRoot, outsideUiDir);

    expect(resolvePluginUiDir(localPluginDir, "paperclip-plugin-safe", escapingEntrypoint)).toBeNull();
  });

  it("rejects sibling package prefix escapes for local package paths", () => {
    const root = makeTempDir();
    const localPluginDir = path.join(root, "plugins");
    const packageRoot = path.join(root, "pkg");
    const siblingUiDir = path.join(root, "pkg-evil", "ui");
    mkdirp(packageRoot);
    mkdirp(siblingUiDir);

    const escapingEntrypoint = path.relative(packageRoot, siblingUiDir);

    expect(resolvePluginUiDir(localPluginDir, "paperclip-plugin-safe", escapingEntrypoint, packageRoot)).toBeNull();
  });

  it("does not let packageName fallback escape the managed plugin directory", () => {
    const root = makeTempDir();
    const localPluginDir = path.join(root, "plugins");
    const outsidePackageUiDir = path.join(root, "outside-package", "dist", "ui");
    mkdirp(localPluginDir);
    mkdirp(outsidePackageUiDir);

    expect(resolvePluginUiDir(localPluginDir, "../outside-package", "./dist/ui")).toBeNull();
  });

  it("does not let packageName escape the managed node_modules directory", () => {
    const root = makeTempDir();
    const localPluginDir = path.join(root, "plugins");
    const outsidePackageUiDir = path.join(root, "outside-package", "dist", "ui");
    mkdirp(path.join(localPluginDir, "node_modules"));
    mkdirp(outsidePackageUiDir);

    expect(resolvePluginUiDir(localPluginDir, "../../outside-package", "./dist/ui")).toBeNull();
  });
});
