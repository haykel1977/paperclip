import { describe, expect, it } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockedInboxOwnerType,
  IssueBlockedInboxReason,
} from "@paperclipai/shared";
import { summarizeBlockedInboxIssues } from "./issues.js";

function makeAttention(input: {
  reason: IssueBlockedInboxReason;
  ownerType: IssueBlockedInboxOwnerType;
  stoppedSinceAt?: string;
}): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: input.reason,
    severity: "high",
    stoppedSinceAt: input.stoppedSinceAt ?? null,
    owner: {
      type: input.ownerType,
      agentId: input.ownerType === "agent" ? "agent-1" : null,
      userId: input.ownerType === "user" ? "user-1" : null,
      label: null,
    },
    action: { label: "Inspect blocked work", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: {
      externalDetailsRedacted: false,
      secretFieldsOmitted: true,
    },
  };
}

describe("summarizeBlockedInboxIssues", () => {
  it("keeps agent-owned recovery work out of the operator queue", () => {
    const summary = summarizeBlockedInboxIssues([
      { blockedInboxAttention: makeAttention({ reason: "open_recovery_issue", ownerType: "agent" }) },
      { blockedInboxAttention: makeAttention({ reason: "open_recovery_issue", ownerType: "user" }) },
      { blockedInboxAttention: makeAttention({ reason: "blocked_by_unassigned_issue", ownerType: "unknown" }) },
      { blockedInboxAttention: makeAttention({ reason: "pending_board_decision", ownerType: "board" }) },
    ]);

    expect(summary.total).toBe(4);
    expect(summary.agentWorkflowCount).toBe(1);
    expect(summary.operatorAttentionCount).toBe(3);
    expect(summary.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "open_recovery_issue", handling: "agent", count: 1 }),
      expect.objectContaining({ reason: "open_recovery_issue", handling: "human", count: 1 }),
      expect.objectContaining({ reason: "blocked_by_unassigned_issue", handling: "triage", count: 1 }),
    ]));
  });

  it("reports median stopped time per cause and handling", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const summary = summarizeBlockedInboxIssues([
      {
        blockedInboxAttention: makeAttention({
          reason: "open_recovery_issue",
          ownerType: "agent",
          stoppedSinceAt: "2026-07-23T09:00:00.000Z",
        }),
      },
      {
        blockedInboxAttention: makeAttention({
          reason: "open_recovery_issue",
          ownerType: "agent",
          stoppedSinceAt: "2026-07-23T07:00:00.000Z",
        }),
      },
    ], now);

    expect(summary.categories).toEqual([
      expect.objectContaining({
        reason: "open_recovery_issue",
        handling: "agent",
        count: 2,
        medianStoppedHours: 4,
      }),
    ]);
  });
});
