import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABELS, acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts an explicit managed instructions bundle for new agents", () => {
    expect(
      createAgentSchema.parse({
        name: "Bundle Agent",
        adapterType: "codex_local",
        instructionsBundle: {
          files: {
            "AGENTS.md": "Use AGENTS.md.",
          },
        },
      }).instructionsBundle?.files["AGENTS.md"],
    ).toBe("Use AGENTS.md.");
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("accepts specialized issue-resolution agent roles and exposes their UI labels", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(
      createAgentSchema.parse({
        name: "Patch Reviewer",
        role: "code_reviewer",
        adapterType: "codex_local",
      }).role,
    ).toBe("code_reviewer");

    expect(
      createAgentSchema.parse({
        name: "Issue Triage",
        role: "issue_triage",
        adapterType: "codex_local",
      }).role,
    ).toBe("issue_triage");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
    expect(AGENT_ROLE_LABELS.code_reviewer).toBe("Code Reviewer");
    expect(AGENT_ROLE_LABELS.issue_triage).toBe("Issue Triage");
    expect(AGENT_ROLE_LABELS.planner).toBe("Planner");
  });
});
