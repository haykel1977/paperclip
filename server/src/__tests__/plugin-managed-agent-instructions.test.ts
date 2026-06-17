import { describe, expect, it } from "vitest";
import type { PluginManagedAgentDeclaration } from "@paperclipai/shared";
import {
  buildDeclaredInstructionFiles,
  normalizeManagedAgentInstructionFilePath,
} from "../services/plugin-managed-agents.js";

function declaration(instructions: PluginManagedAgentDeclaration["instructions"]): PluginManagedAgentDeclaration {
  return {
    agentKey: "wiki-maintainer",
    displayName: "Wiki Maintainer",
    instructions,
  };
}

describe("plugin managed agent instruction file paths", () => {
  it("accepts safe relative instruction paths", () => {
    expect(normalizeManagedAgentInstructionFilePath("AGENTS.md")).toBe("AGENTS.md");
    expect(normalizeManagedAgentInstructionFilePath("docs/README.md")).toBe("docs/README.md");
  });

  it("rejects unsafe instruction paths", () => {
    for (const filePath of [
      "",
      "/AGENTS.md",
      "../AGENTS.md",
      "docs/../AGENTS.md",
      "./AGENTS.md",
      "docs//README.md",
      "docs/./README.md",
      "docs\\README.md",
      "C:/Users/plugin/AGENTS.md",
      "C:\\Users\\plugin\\AGENTS.md",
      "promptTemplate.legacy.md",
    ]) {
      expect(() => normalizeManagedAgentInstructionFilePath(filePath)).toThrow();
    }
  });

  it("renders declared files into a null-prototype map", () => {
    const declared = buildDeclaredInstructionFiles(
      declaration({
        entryFile: "AGENTS.md",
        content: "Hello {{companyName}}",
        files: {
          "docs/README.md": "Docs for {{companyName}}",
        },
      }),
      { companyName: "Paperclip" },
    );

    expect(declared).not.toBeNull();
    expect(declared!.entryFile).toBe("AGENTS.md");
    expect(declared!.files["AGENTS.md"]).toBe("Hello Paperclip");
    expect(declared!.files["docs/README.md"]).toBe("Docs for Paperclip");
    expect(Object.getPrototypeOf(declared!.files)).toBeNull();
  });

  it("fails closed when persisted manifests contain unsafe instruction file paths", () => {
    expect(() =>
      buildDeclaredInstructionFiles(
        declaration({
          entryFile: "AGENTS.md",
          files: {
            "../outside.md": "escape",
          },
        }),
        {},
      ),
    ).toThrow(/relative paths/);
  });
});
