import { describe, expect, it } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
} from "@paperclipai/shared";
import { summarizeBlockedInboxIssues } from "./issues.js";

function attention(
  reason: IssueBlockedInboxReason,
  stoppedSinceAt: string,
  actionLabel: string,
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: reason === "pending_board_decision" ? "awaiting_decision" : "needs_attention",
    reason,
    severity: "high",
    stoppedSinceAt,
    owner: {
      type: reason === "pending_board_decision" ? "board" : "agent",
      agentId: null,
      userId: null,
      label: null,
    },
    action: { label: actionLabel, detail: null },
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
  it("groups causes and separates agent workflows from operator attention", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const summary = summarizeBlockedInboxIssues([
      {
        blockedInboxAttention: attention(
          "open_recovery_issue",
          "2026-07-23T10:00:00.000Z",
          "Resolve recovery",
        ),
      },
      {
        blockedInboxAttention: attention(
          "open_recovery_issue",
          "2026-07-23T06:00:00.000Z",
          "Resolve recovery",
        ),
      },
      {
        blockedInboxAttention: attention(
          "pending_board_decision",
          "2026-07-22T12:00:00.000Z",
          "Decide approval",
        ),
      },
      { blockedInboxAttention: null },
    ], now);

    expect(summary).toMatchObject({
      total: 3,
      operatorAttentionCount: 1,
      agentWorkflowCount: 2,
      generatedAt: now.toISOString(),
    });
    expect(summary.categories).toEqual([
      {
        reason: "open_recovery_issue",
        count: 2,
        medianStoppedHours: 4,
        handling: "agent",
        actionLabel: "Resolve recovery",
      },
      {
        reason: "pending_board_decision",
        count: 1,
        medianStoppedHours: 24,
        handling: "human",
        actionLabel: "Decide approval",
      },
    ]);
  });
});
