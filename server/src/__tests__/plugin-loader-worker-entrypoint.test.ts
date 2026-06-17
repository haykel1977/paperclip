import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfig: vi.fn(),
  listByStatus: vi.fn(),
  listInstalled: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const packageName = "paperclip-plugin-entrypoint-test";

async function exists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(() => true, () => false);
}

function manifest(worker: string): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.entrypoint-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Entrypoint Test",
    description: "Entrypoint test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["api.routes.register"],
    entrypoints: { worker },
  };
}

function pluginRecord(input: {
  packageRoot: string;
  manifest: PaperclipPluginManifestV1;
  packagePath?: string | null;
}): PluginRecord {
  return {
    id: pluginId,
    pluginKey: input.manifest.id,
    packageName,
    packagePath: input.packagePath ?? null,
    version: input.manifest.version,
    apiVersion: input.manifest.apiVersion,
    categories: input.manifest.categories,
    manifestJson: input.manifest,
    status: "ready",
    lastError: null,
    installOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as PluginRecord;
}

function runtimeServices() {
  const startWorker = vi.fn().mockResolvedValue({});
  const markError = vi.fn().mockResolvedValue(undefined);
  return {
    services: {
      workerManager: {
        startWorker,
      },
      eventBus: {
        forPlugin: vi.fn().mockReturnValue({}),
        subscriptionCount: vi.fn().mockReturnValue(0),
      },
      jobScheduler: {
        registerPlugin: vi.fn(),
      },
      jobStore: {
        syncJobDeclarations: vi.fn(),
      },
      toolDispatcher: {
        registerPluginTools: vi.fn(),
      },
      lifecycleManager: {
        load: vi.fn(),
        markError,
      },
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
    } as unknown as PluginRuntimeServices,
    startWorker,
    markError,
  };
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-entrypoint-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePluginPackage(packageRoot: string, pluginManifest: PaperclipPluginManifestV1) {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version: pluginManifest.version,
    paperclipPlugin: { manifest: "./manifest.js" },
  }), "utf8");
  await writeFile(
    path.join(packageRoot, "manifest.js"),
    `export default ${JSON.stringify(pluginManifest)};\n`,
    "utf8",
  );
}

describe("plugin loader worker entrypoint containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getConfig.mockResolvedValue(null);
    mockRegistry.listByStatus.mockResolvedValue([]);
    mockRegistry.listInstalled.mockResolvedValue([]);
    mockRegistry.update.mockResolvedValue(null);
  });

  it("starts workers from relative entrypoints inside the package root", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const packageRoot = path.join(localPluginDir, "node_modules", packageName);
      const pluginManifest = manifest("./dist/worker.js");
      await writePluginPackage(packageRoot, pluginManifest);
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      const workerPath = path.join(packageRoot, "dist", "worker.js");
      await writeFile(workerPath, "", "utf8");

      mockRegistry.getById.mockResolvedValue(pluginRecord({ packageRoot, manifest: pluginManifest }));
      const runtime = runtimeServices();
      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      }, runtime.services);

      const result = await loader.loadSingle(pluginId);

      expect(result.success).toBe(true);
      expect(runtime.startWorker).toHaveBeenCalledWith(pluginId, expect.objectContaining({
        entrypointPath: expect.stringContaining(path.join("dist", "worker.js")),
      }));
      expect(await exists(workerPath)).toBe(true);
    });
  });

  it("rejects absolute worker entrypoints before worker startup", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const packageRoot = path.join(localPluginDir, "node_modules", packageName);
      const outsideWorker = path.join(root, "outside-worker.js");
      const pluginManifest = manifest(outsideWorker);
      await writePluginPackage(packageRoot, pluginManifest);
      await writeFile(outsideWorker, "", "utf8");

      mockRegistry.getById.mockResolvedValue(pluginRecord({ packageRoot, manifest: pluginManifest }));
      const runtime = runtimeServices();
      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      }, runtime.services);

      const result = await loader.loadSingle(pluginId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("relative path inside the package root");
      expect(runtime.startWorker).not.toHaveBeenCalled();
      expect(runtime.markError).toHaveBeenCalledWith(pluginId, expect.stringContaining("relative path inside the package root"));
    });
  });

  it("rejects traversal worker entrypoints that would escape by sibling-prefix paths", async () => {
    await withTempDir(async (root) => {
      const localPluginDir = path.join(root, "plugins");
      const packageRoot = path.join(localPluginDir, "node_modules", packageName);
      const evilPackageRoot = path.join(localPluginDir, "node_modules", `${packageName}-evil`);
      const pluginManifest = manifest(`../${packageName}-evil/worker.js`);
      await writePluginPackage(packageRoot, pluginManifest);
      await mkdir(evilPackageRoot, { recursive: true });
      await writeFile(path.join(evilPackageRoot, "worker.js"), "", "utf8");

      mockRegistry.getById.mockResolvedValue(pluginRecord({ packageRoot, manifest: pluginManifest }));
      const runtime = runtimeServices();
      const loader = pluginLoader({} as never, {
        localPluginDir,
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      }, runtime.services);

      const result = await loader.loadSingle(pluginId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("relative path inside the package root");
      expect(runtime.startWorker).not.toHaveBeenCalled();
    });
  });
});
