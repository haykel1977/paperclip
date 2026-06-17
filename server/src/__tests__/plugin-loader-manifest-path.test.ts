import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginLoader } from "../services/plugin-loader.js";

const packageName = "paperclip-plugin-manifest-path-test";

async function exists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(() => true, () => false);
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.manifest-path-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Manifest Path Test",
    description: "Manifest path containment test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["api.routes.register"],
    entrypoints: { worker: "dist/worker.js" },
  };
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-manifest-path-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePackageJson(packageRoot: string, manifestPath: string) {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version: "1.0.0",
    type: "module",
    paperclipPlugin: { manifest: manifestPath },
  }), "utf8");
}

async function writeManifestModule(targetPath: string, pluginManifest: PaperclipPluginManifestV1 = manifest()) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    `export default ${JSON.stringify(pluginManifest)};\n`,
    "utf8",
  );
}

describe("plugin loader manifest path containment", () => {
  it("loads package-declared manifest files inside the package root", async () => {
    await withTempDir(async (root) => {
      const packageRoot = path.join(root, "package");
      await writePackageJson(packageRoot, "./dist/manifest.js");
      await writeManifestModule(path.join(packageRoot, "dist", "manifest.js"));

      const loader = pluginLoader({} as never, {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      const parsed = await loader.loadManifest(packageRoot);

      expect(parsed?.id).toBe("paperclip.manifest-path-test");
    });
  });

  it("rejects package-declared manifest traversal paths before import", async () => {
    await withTempDir(async (root) => {
      const packageRoot = path.join(root, "package");
      const markerPath = path.join(root, "outside-imported.txt");
      await writePackageJson(packageRoot, "../outside/manifest.js");
      await mkdir(path.join(root, "outside"), { recursive: true });
      await writeFile(
        path.join(root, "outside", "manifest.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "imported");\nexport default ${JSON.stringify(manifest())};\n`,
        "utf8",
      );

      const loader = pluginLoader({} as never, {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await expect(loader.loadManifest(packageRoot)).rejects.toThrow(
        /Plugin manifest path must be a relative path inside the package root/,
      );
      expect(await exists(markerPath)).toBe(false);
    });
  });

  it("rejects package-declared manifest drive-prefixed paths", async () => {
    await withTempDir(async (root) => {
      const packageRoot = path.join(root, "package");
      await writePackageJson(packageRoot, "C:manifest.js");

      const loader = pluginLoader({} as never, {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await expect(loader.loadManifest(packageRoot)).rejects.toThrow(
        /Plugin manifest path must be a relative path inside the package root/,
      );
    });
  });

  it.skipIf(process.platform === "win32")("rejects package-declared manifest symlinks that escape the package root", async () => {
    await withTempDir(async (root) => {
      const packageRoot = path.join(root, "package");
      const outsideManifestPath = path.join(root, "outside", "manifest.js");
      await writePackageJson(packageRoot, "./manifest.js");
      await writeManifestModule(outsideManifestPath);
      await symlink(outsideManifestPath, path.join(packageRoot, "manifest.js"));

      const loader = pluginLoader({} as never, {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await expect(loader.loadManifest(packageRoot)).rejects.toThrow(
        /Plugin manifest path must stay inside the package root/,
      );
    });
  });
});
