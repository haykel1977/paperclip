import { describe, expect, it } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
} from "@paperclipai/shared";
import { summarizeBlockedInboxIssues } from "../services/issues.js";

function attention(
  reason: IssueBlockedInboxReason,
  stoppedSinceAt: string,
  actionLabel: string,
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason,
    severity: "high",
    stoppedSinceAt,
    owner: { type: "unknown", agentId: null, userId: null, label: null },
    action: { label: actionLabel, detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
  };
}

describe("summarizeBlockedInboxIssues", () => {
  it("groups causes, calculates median age, and separates operator work from agent workflows", () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const summary = summarizeBlockedInboxIssues([
      { blockedInboxAttention: attention("blocked_chain_stalled", "2026-05-10T08:00:00.000Z", "Inspect chain") },
      { blockedInboxAttention: attention("blocked_chain_stalled", "2026-05-10T04:00:00.000Z", "Inspect chain") },
      { blockedInboxAttention: attention("open_recovery_issue", "2026-05-10T10:00:00.000Z", "Resolve recovery") },
      { blockedInboxAttention: attention("pending_board_decision", "2026-05-10T11:00:00.000Z", "Decide approval") },
      { blockedInboxAttention: null },
    ], now);

    expect(summary).toMatchObject({
      total: 4,
      operatorAttentionCount: 3,
      agentWorkflowCount: 1,
      generatedAt: now.toISOString(),
    });
    expect(summary.categories).toEqual([
      {
        reason: "blocked_chain_stalled",
        count: 2,
        medianStoppedHours: 6,
        handling: "triage",
        actionLabel: "Inspect chain",
      },
      {
        reason: "open_recovery_issue",
        count: 1,
        medianStoppedHours: 2,
        handling: "agent",
        actionLabel: "Resolve recovery",
      },
      {
        reason: "pending_board_decision",
        count: 1,
        medianStoppedHours: 1,
        handling: "human",
        actionLabel: "Decide approval",
      },
    ]);
  });

  it("returns an empty, stable summary when no blocked attention is present", () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    expect(summarizeBlockedInboxIssues([], now)).toEqual({
      total: 0,
      operatorAttentionCount: 0,
      agentWorkflowCount: 0,
      categories: [],
      generatedAt: now.toISOString(),
    });
  });
});
