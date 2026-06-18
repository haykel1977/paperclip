// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sovereign-sonnet",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },

    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sovereign-sonnet",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });

  });

  it("writes the cheap profile under runtimeConfig.modelProfiles, never on primary adapterConfig", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-sovereign-haiku" },
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
        },
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-sovereign-haiku" },
          },
        },
      },
    });

    // The primary adapterConfig is untouched.
    expect(patch.adapterConfig).toBeUndefined();
  });

  it("writes max-turn continuation policy under runtimeConfig.heartbeat", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      },
    });
  });

  it("merges cheap profile changes onto existing runtimeConfig.modelProfiles state", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: false,
          adapterConfig: { model: "old-sovereign-cheap" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(

      agent,
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
          },
        },
      }),
    );

    expect((patch.runtimeConfig as Record<string, unknown>).modelProfiles).toEqual({
      cheap: {
        enabled: true,
        adapterConfig: { model: "old-sovereign-cheap" },
      },
    });
  });

  it("clears the cheap profile when the overlay marks it cleared", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "claude-sovereign-haiku" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        modelProfiles: { cheap: { cleared: true } },
      }),
    );

    expect(patch.runtimeConfig).toEqual({
      heartbeat: { enabled: true, intervalSec: 300 },
    });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "sovereign-codex",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),

    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "sovereign-codex",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });

  });
});
