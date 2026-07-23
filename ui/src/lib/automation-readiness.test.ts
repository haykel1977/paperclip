// @vitest-environment node

import { describe, expect, it } from "vitest";
import { computeAutomationReadiness, type AutomationReadinessSummary } from "./automation-readiness";

function makeSummary(overrides: Partial<AutomationReadinessSummary> = {}): AutomationReadinessSummary {
  return {
    agents: {
      running: 0,
      paused: 0,
      error: 0,
      ...overrides.agents,
    },
    tasks: {
      open: 0,
      inProgress: 0,
      blocked: 0,
      ...overrides.tasks,
    },
    pendingApprovals: overrides.pendingApprovals ?? 0,
    budgets: {
      pendingApprovals: 0,
      activeIncidents: 0,
      ...overrides.budgets,
    },
  };
}

describe("computeAutomationReadiness", () => {
  it("marks autopilot operational when agents exist and no human queue is pending", () => {
    const readiness = computeAutomationReadiness({
      summary: makeSummary({
        agents: { running: 2 },
        tasks: { open: 3, inProgress: 1 },
      }),
      agentCount: 3,
      liveRunCount: 1,
      pendingApprovalCount: 0,
    });

    expect(readiness.score).toBe(100);
    expect(readiness.mode).toBe("Autopilot operational");
    expect(readiness.totalHumanQueue).toBe(0);
    expect(readiness.interventionItems).toEqual([]);
    expect(readiness.openTaskCount).toBe(3);
  });

  it("requires setup when no agent is available", () => {
    const readiness = computeAutomationReadiness({
      summary: makeSummary(),
      agentCount: 0,
      liveRunCount: 0,
    });

    expect(readiness.mode).toBe("Setup required");
    expect(readiness.score).toBe(25);
    expect(readiness.totalHumanQueue).toBe(1);
    expect(readiness.interventionItems).toEqual([
      {
        kind: "agent_setup",
        label: "Agent setup",
        count: 1,
        href: "/agents/new",
      },
    ]);
  });

  it("surfaces all human intervention categories with direct destinations", () => {
    const readiness = computeAutomationReadiness({
      summary: makeSummary({
        agents: { error: 2 },
        tasks: { blocked: 3 },
        budgets: { pendingApprovals: 4, activeIncidents: 1 },
      }),
      agentCount: 2,
      pendingApprovalCount: 5,
    });

    expect(readiness.mode).toBe("Autopilot with visible human review");
    expect(readiness.score).toBe(50);
    expect(readiness.totalHumanQueue).toBe(15);
    expect(readiness.interventionItems).toEqual([
      {
        kind: "approval_decisions",
        label: "Approval decisions",
        count: 5,
        href: "/approvals",
      },
      {
        kind: "budget_incidents",
        label: "Budget incidents",
        count: 5,
        href: "/costs",
      },
      {
        kind: "blocked_tasks",
        label: "Blocked tasks requiring review",
        count: 3,
        href: "/inbox/blocked",
      },
      {
        kind: "agent_errors",
        label: "Agent errors",
        count: 2,
        href: "/agents/error",
      },
    ]);
  });

  it("separates agent-managed blockers from the human queue", () => {
    const readiness = computeAutomationReadiness({
      summary: makeSummary({ tasks: { open: 20, inProgress: 4, blocked: 12 } }),
      agentCount: 3,
      blockedOperatorAttentionCount: 3,
      blockedAgentWorkflowCount: 7,
    });

    expect(readiness.openTaskCount).toBe(20);
    expect(readiness.blockedTaskCount).toBe(12);
    expect(readiness.blockedOperatorAttentionCount).toBe(3);
    expect(readiness.blockedAgentWorkflowCount).toBe(7);
    expect(readiness.totalHumanQueue).toBe(3);
    expect(readiness.interventionItems).toContainEqual({
      kind: "blocked_tasks",
      label: "Blocked tasks requiring review",
      count: 3,
      href: "/inbox/blocked",
    });
    expect(readiness.checks.find((check) => check.title === "Human intervention queue")?.href)
      .toBe("/inbox/blocked");
  });

  it("uses dashboard pending approvals when the dedicated approval count is unavailable", () => {
    const readiness = computeAutomationReadiness({
      summary: makeSummary({ pendingApprovals: 2 }),
      agentCount: 1,
    });

    expect(readiness.totalHumanQueue).toBe(2);
    expect(readiness.interventionItems[0]).toMatchObject({
      kind: "approval_decisions",
      count: 2,
    });
  });
});
