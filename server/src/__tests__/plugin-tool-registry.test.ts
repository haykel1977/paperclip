import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const pluginKey = "acme.demo";
const pluginDbId = "00000000-0000-4000-8000-000000000001";

function manifestWithTools(names: string[]): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Demo plugin",
    description: "Tool registry test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
    tools: names.map((name) => ({
      name,
      displayName: "Demo tool",
      description: "Runs a demo tool.",
      parametersSchema: { type: "object" },
    })),
  } as PaperclipPluginManifestV1;
}

function manifestWithTool(name: string): PaperclipPluginManifestV1 {
  return manifestWithTools([name]);
}

describe("plugin tool registry input hardening", () => {
  it("rejects persisted tool names that would confuse namespaced dispatch", () => {
    const registry = createPluginToolRegistry();

    for (const name of ["foo:bar", "foo/bar", "foo bar", "__proto__", "constructor"]) {
      expect(() => registry.registerPlugin(pluginKey, manifestWithTool(name), pluginDbId)).toThrow(
        /Invalid plugin tool name/,
      );
    }

    expect(registry.toolCount()).toBe(0);
    expect(registry.parseNamespacedName(`${pluginKey}:foo:bar`)).toBeNull();
  });

  it("rejects invalid manifests before replacing existing registrations", () => {
    const registry = createPluginToolRegistry();

    registry.registerPlugin(pluginKey, manifestWithTool("ping"), pluginDbId);
    expect(() => registry.registerPlugin(pluginKey, manifestWithTools(["safe", "bad:name"]), pluginDbId)).toThrow(
      /Invalid plugin tool name/,
    );

    expect(registry.toolCount(pluginKey)).toBe(1);
    expect(registry.getTool(`${pluginKey}:ping`)).not.toBeNull();
  });

  it("rejects malformed plugin namespaces at the registry boundary", () => {
    const registry = createPluginToolRegistry();

    expect(() => registry.registerPlugin("acme:demo", manifestWithTool("ping"), pluginDbId)).toThrow(
      /Invalid plugin tool namespace/,
    );
  });

  it("dispatches safe names without truncating the tool name", async () => {
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginDbId),
      call: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    } as unknown as PluginWorkerManager;
    const registry = createPluginToolRegistry(workerManager);

    registry.registerPlugin(pluginKey, manifestWithTool("wiki.search_pages-1"), pluginDbId);
    await expect(registry.executeTool(`${pluginKey}:wiki.search_pages-1`, {}, {
      agentId: "agent-1",
      runId: "run-1",
      companyId: "company-1",
      projectId: "project-1",
    })).resolves.toMatchObject({
      pluginId: pluginKey,
      toolName: "wiki.search_pages-1",
    });

    expect(workerManager.call).toHaveBeenCalledWith(pluginDbId, "executeTool", expect.objectContaining({
      toolName: "wiki.search_pages-1",
    }));
  });
});
