import { mkdtemp, mkdir, rm, writeFile, access, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { pluginLoader } from "../services/plugin-loader.js";

async function exists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(() => true, () => false);
}

function pluginRecord(overrides: Partial<PluginRecord> & { packageName: string }): PluginRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pluginKey: "paperclip.cleanup-test",
    packageName: overrides.packageName,
    packagePath: overrides.packagePath ?? null,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: {
      id: "paperclip.cleanup-test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Cleanup Test",
      description: "Cleanup test plugin",
      author: "Paperclip",
      categories: [],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    },
    status: "ready",
    lastError: null,
    installOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PluginRecord;
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-cleanup-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("plugin loader cleanup containment", () => {
  it("removes managed node_modules package directories", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const packageDir = path.join(localPluginDir, "node_modules", "paperclip-plugin-safe");
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(packageDir, "package.json"), "{}", "utf8");

      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await loader.cleanupInstallArtifacts(pluginRecord({ packageName: "paperclip-plugin-safe" }));

      expect(await exists(packageDir)).toBe(false);
    });
  });

  it("does not derive cleanup paths from traversal package names", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const outsideTarget = path.join(root, "outside-target");
      await mkdir(path.join(localPluginDir, "node_modules"), { recursive: true });
      await mkdir(outsideTarget, { recursive: true });
      await writeFile(path.join(outsideTarget, "sentinel.txt"), "keep", "utf8");

      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await loader.cleanupInstallArtifacts(pluginRecord({ packageName: "../../outside-target" }));

      expect(await exists(path.join(outsideTarget, "sentinel.txt"))).toBe(true);
    });
  });

  it("does not treat node_modules itself as a removable direct package directory", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const nodeModulesDir = path.join(localPluginDir, "node_modules");
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(path.join(nodeModulesDir, "sentinel.txt"), "keep", "utf8");

      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await loader.cleanupInstallArtifacts(pluginRecord({ packageName: "node_modules" }));

      expect(await exists(path.join(nodeModulesDir, "sentinel.txt"))).toBe(true);
    });
  });

  it.skipIf(process.platform === "win32")("does not remove packagePath targets that escape through symlinked parents", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const outsideDir = path.join(root, "outside");
      const outsidePackageDir = path.join(outsideDir, "package");
      const linkPath = path.join(localPluginDir, "linked-outside");
      await mkdir(localPluginDir, { recursive: true });
      await mkdir(outsidePackageDir, { recursive: true });
      await writeFile(path.join(outsidePackageDir, "sentinel.txt"), "keep", "utf8");
      await symlink(outsideDir, linkPath, "dir");

      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await loader.cleanupInstallArtifacts(pluginRecord({
        packageName: "paperclip-plugin-safe",
        packagePath: path.join(linkPath, "package"),
      }));

      expect(await exists(path.join(outsidePackageDir, "sentinel.txt"))).toBe(true);
    });
  });
});
