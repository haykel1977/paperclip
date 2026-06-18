import { describe, expect, it } from "vitest";
import { filterAcpxModelsByAgent } from "./acpx-model-filter";

const mixedModels = [
  { id: "claude-sovereign-sonnet", label: "Claude: Sovereign Sonnet" },
  { id: "sovereign-codex", label: "Codex: sovereign-codex" },
  { id: "provider/custom-model", label: "Custom model" },
];

describe("filterAcpxModelsByAgent", () => {
  it("keeps only Claude models when ACPX Claude is selected", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "claude").map((model) => model.id)).toEqual([
      "claude-sovereign-sonnet",
    ]);
  });

  it("keeps only Codex models when ACPX Codex is selected", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "codex").map((model) => model.id)).toEqual([
      "sovereign-codex",
    ]);
  });

  it("does not show built-in provider models for custom ACP commands", () => {
    expect(filterAcpxModelsByAgent(mixedModels, "custom")).toEqual([]);
  });
});
