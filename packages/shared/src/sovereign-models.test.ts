import { describe, expect, it } from "vitest";
import { filterSovereignAgentModels, isSovereignAgentModelValue } from "./sovereign-models.js";

describe("sovereign agent model detection", () => {
  it.each([
    "sovereign-gpt-5.4",
    "openai/sovereign-gpt-5.4",
    "Sovereign Claude Opus",
    "souverain-mistral-large",
  ])("accepts explicit sovereign model value %s", (value) => {
    expect(isSovereignAgentModelValue(value)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "non-sovereign-gpt-4o",
    "not sovereign gpt-4o",
    "anti-sovereign-model",
    "unsouverain-modele",
    "",
  ])("rejects non-sovereign or negated model value %s", (value) => {
    expect(isSovereignAgentModelValue(value)).toBe(false);
  });

  it("allows sovereign labels while rejecting non-sovereign labels", () => {
    expect(filterSovereignAgentModels([
      { id: "qwen2.5-coder:32b", label: "Sovereign qwen2.5-coder:32b" },
      { id: "gpt-4o", label: "non-sovereign GPT-4o" },
      { id: "claude", label: "Claude" },
    ])).toEqual([
      { id: "qwen2.5-coder:32b", label: "Sovereign qwen2.5-coder:32b" },
    ]);
  });
});
