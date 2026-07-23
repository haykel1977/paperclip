import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  updateIssue: vi.fn(),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ cancelRun: serviceMocks.cancelRun }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ update: serviceMocks.updateIssue }),
}));

import {
  githubWebhookRoutes,
  parsePaperclipDeliveryMetadata,
  verifyGitHubWebhookSignature,
} from "../routes/github-webhooks.js";

const WEBHOOK_SECRET = "test-webhook-secret";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";

type DbScenario = {
  issue?: { id: string; companyId: string; status: string; executionState?: unknown } | null;
  activeRuns?: { id: string }[];
  authorizedWorkspace?: { id: string } | null;
  inspectWorkspaceCondition?: (condition: unknown) => void;
};

function createDbStub(scenario: DbScenario = {}) {
  const {
    issue = { id: ISSUE_ID, companyId: COMPANY_ID, status: "in_progress", executionState: { previous: true } },
    activeRuns = [{ id: "run-1" }],
    authorizedWorkspace = { id: "workspace-1" },
  } = scenario;

  let selectCall = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          selectCall += 1;
          if (selectCall === 1) {
            // issues lookup
            return Promise.resolve(issue ? [issue] : []);
          }
          if (selectCall === 2) {
            // projectWorkspaces lookup (company-repo trust)
            scenario.inspectWorkspaceCondition?.(condition);
            return {
              limit: vi.fn(() => Promise.resolve(authorizedWorkspace ? [authorizedWorkspace] : [])),
            };
          }
          // heartbeatRuns lookup
          return Promise.resolve(activeRuns);
        }),
      })),
    })),
  };
}

function createApp(scenario?: DbScenario) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody: Buffer }).rawBody = buffer;
    },
  }));
  app.use("/api/webhooks/github", githubWebhookRoutes(createDbStub(scenario) as any));
  return app;
}

function signedPayload(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
  return { raw, signature };
}

function mergedPullRequestPayload(overrides?: {
  repository?: string;
  body?: string;
  action?: string;
  merged?: boolean;
}) {
  return {
    action: overrides?.action ?? "closed",
    repository: { full_name: overrides?.repository ?? "Beyn-SOLIDUS/quantum" },
    pull_request: {
      number: 2776,
      merged: overrides?.merged ?? true,
      merged_at: "2026-07-22T10:36:52Z",
      html_url: "https://github.com/Beyn-SOLIDUS/quantum/pull/2776",
      merge_commit_sha: "63589c35",
      body: overrides?.body ?? [
        "## Delivery Metadata",
        `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
        "- Repository: Beyn-SOLIDUS/quantum",
        "- Idempotency key: Beyn-SOLIDUS/quantum:QUA-38",
      ].join("\n"),
    },
  };
}

function sendWebhook(app: ReturnType<typeof createApp>, payload: unknown, headers?: Record<string, string>) {
  const { raw, signature } = signedPayload(payload);
  let req = request(app)
    .post("/api/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", headers?.["x-github-event"] ?? "pull_request")
    .set("x-github-delivery", headers?.["x-github-delivery"] ?? "delivery-1")
    .set("x-hub-signature-256", headers?.["x-hub-signature-256"] ?? signature);
  return req.send(raw);
}

describe("GitHub delivery webhook", () => {
  const originalSecret = process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    serviceMocks.cancelRun.mockReset().mockResolvedValue(undefined);
    serviceMocks.updateIssue.mockReset().mockResolvedValue({ id: ISSUE_ID, status: "done" });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET;
    else process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET = originalSecret;
  });

  // ── signature ──────────────────────────────────────────────────────────────

  it("validates signatures with a timing-safe HMAC comparison", () => {
    const raw = Buffer.from("{\"ok\":true}");
    const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
    expect(verifyGitHubWebhookSignature(raw, signature, WEBHOOK_SECRET)).toBe(true);
    expect(verifyGitHubWebhookSignature(raw, "sha256=deadbeef", WEBHOOK_SECRET)).toBe(false);
  });

  it("rejects an unsigned or incorrectly signed webhook", async () => {
    const response = await sendWebhook(createApp(), mergedPullRequestPayload(), {
      "x-hub-signature-256": "sha256=deadbeef",
    });
    expect(response.status).toBe(401);
    expect(serviceMocks.updateIssue).not.toHaveBeenCalled();
  });

  it("returns 503 when secret is not configured", async () => {
    delete process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET;
    const response = await sendWebhook(createApp(), mergedPullRequestPayload());
    expect(response.status).toBe(503);
  });

  // ── metadata parsing ───────────────────────────────────────────────────────

  it("parses the repository and issue UUID from deterministic PR metadata", () => {
    expect(parsePaperclipDeliveryMetadata([
      `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
      "- Repository: Beyn-SOLIDUS/quantum",
    ].join("\n"))).toEqual({
      issueId: ISSUE_ID,
      repository: "Beyn-SOLIDUS/quantum",
    });
  });

  it("returns null when issue ID is missing", () => {
    expect(parsePaperclipDeliveryMetadata("- Repository: owner/repo")).toBeNull();
  });

  it("returns null when repository metadata is missing", () => {
    expect(parsePaperclipDeliveryMetadata(
      `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
    )).toBeNull();
  });

  it("rejects a malformed UUID in metadata", () => {
    expect(parsePaperclipDeliveryMetadata([
      "- Paperclip issue: QUA-38 (not-a-uuid-at-all)",
      "- Repository: owner/repo",
    ].join("\n"))).toBeNull();
  });

  // ── event filtering ────────────────────────────────────────────────────────

  it("ignores non-pull_request events", async () => {
    const response = await sendWebhook(createApp(), mergedPullRequestPayload(), {
      "x-github-event": "push",
    });
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe("unsupported_event");
  });

  it("ignores pull_request close without merge", async () => {
    const response = await sendWebhook(
      createApp(),
      mergedPullRequestPayload({ merged: false }),
    );
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe("pull_request_not_merged");
  });

  it("ignores PRs without Paperclip metadata", async () => {
    const response = await sendWebhook(
      createApp(),
      mergedPullRequestPayload({ body: "Regular PR without metadata" }),
    );
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe("not_a_paperclip_delivery");
  });

  // ── repository mismatch ────────────────────────────────────────────────────

  it("rejects when webhook repository does not match PR metadata", async () => {
    const response = await sendWebhook(
      createApp(),
      mergedPullRequestPayload({ repository: "attacker/different-repo" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/does not match/i);
  });

  // ── issue not found ────────────────────────────────────────────────────────

  it("returns 404 when the Paperclip issue does not exist", async () => {
    const response = await sendWebhook(
      createApp({ issue: null }),
      mergedPullRequestPayload(),
    );
    expect(response.status).toBe(404);
  });

  // ── company-repo trust ─────────────────────────────────────────────────────

  it("returns 403 when repository is not authorized for the issue company", async () => {
    const response = await sendWebhook(
      createApp({ authorizedWorkspace: null }),
      mergedPullRequestPayload(),
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/not authorized/i);
    expect(serviceMocks.updateIssue).not.toHaveBeenCalled();
  });

  it("matches workspace repository URLs exactly", async () => {
    let workspaceCondition: unknown;
    const response = await sendWebhook(
      createApp({
        inspectWorkspaceCondition: (condition) => {
          workspaceCondition = condition;
        },
      }),
      mergedPullRequestPayload(),
    );

    expect(response.status).toBe(200);
    const query = new PgDialect().sqlToQuery(workspaceCondition as SQL);
    expect(query.sql.toLowerCase()).not.toContain(" like ");
    expect(query.params).toEqual([
      COMPANY_ID,
      "https://github.com/beyn-solidus/quantum",
      "https://github.com/beyn-solidus/quantum.git",
    ]);
  });

  // ── happy path ─────────────────────────────────────────────────────────────

  it("marks the linked issue done and cancels active runs after a signed merge event", async () => {
    const response = await sendWebhook(createApp(), mergedPullRequestPayload());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, issueId: ISSUE_ID, status: "done", changed: true });
    expect(serviceMocks.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "Cancelled because the linked GitHub pull request was merged",
    );
    expect(serviceMocks.updateIssue).toHaveBeenCalledWith(ISSUE_ID, {
      status: "done",
      executionState: {
        previous: true,
        githubDelivery: {
          repository: "Beyn-SOLIDUS/quantum",
          prNumber: 2776,
          prUrl: "https://github.com/Beyn-SOLIDUS/quantum/pull/2776",
          mergeCommitSha: "63589c35",
          mergedAt: "2026-07-22T10:36:52Z",
          deliveryId: "delivery-1",
        },
      },
    });
  });

  // ── idempotent cleanup (issue already done with active runs) ───────────────

  it("cancels active runs even when the issue is already done", async () => {
    const response = await sendWebhook(
      createApp({
        issue: { id: ISSUE_ID, companyId: COMPANY_ID, status: "done", executionState: {} },
        activeRuns: [{ id: "run-orphan-1" }, { id: "run-orphan-2" }],
      }),
      mergedPullRequestPayload(),
    );

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(response.body.cancelledRuns).toBe(2);
    expect(serviceMocks.cancelRun).toHaveBeenCalledTimes(2);
    expect(serviceMocks.updateIssue).not.toHaveBeenCalled();
  });

  it("cancels active runs even when the issue is cancelled", async () => {
    const response = await sendWebhook(
      createApp({
        issue: { id: ISSUE_ID, companyId: COMPANY_ID, status: "cancelled", executionState: {} },
        activeRuns: [{ id: "run-zombie" }],
      }),
      mergedPullRequestPayload(),
    );

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(response.body.cancelledRuns).toBe(1);
    expect(serviceMocks.cancelRun).toHaveBeenCalledWith(
      "run-zombie",
      "Cancelled because the linked GitHub pull request was merged",
    );
  });
});
