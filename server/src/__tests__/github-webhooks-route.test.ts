import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
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

function createDbStub() {
  let selectCall = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCall += 1;
          if (selectCall === 1) {
            return Promise.resolve([{
              id: ISSUE_ID,
              companyId: "company-1",
              status: "in_progress",
              executionState: { previous: true },
            }]);
          }
          return Promise.resolve([{ id: "run-1" }]);
        }),
      })),
    })),
  };
}

function createApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody: Buffer }).rawBody = buffer;
    },
  }));
  app.use("/api/webhooks/github", githubWebhookRoutes(createDbStub() as any));
  return app;
}

function signedPayload(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
  return { raw, signature };
}

function mergedPullRequestPayload() {
  return {
    action: "closed",
    repository: { full_name: "Beyn-SOLIDUS/quantum" },
    pull_request: {
      number: 2776,
      merged: true,
      merged_at: "2026-07-22T10:36:52Z",
      html_url: "https://github.com/Beyn-SOLIDUS/quantum/pull/2776",
      merge_commit_sha: "63589c35",
      body: [
        "## Delivery Metadata",
        `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
        "- Repository: Beyn-SOLIDUS/quantum",
        "- Idempotency key: Beyn-SOLIDUS/quantum:QUA-38",
      ].join("\n"),
    },
  };
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

  it("validates signatures with a timing-safe HMAC comparison", () => {
    const raw = Buffer.from("{\"ok\":true}");
    const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
    expect(verifyGitHubWebhookSignature(raw, signature, WEBHOOK_SECRET)).toBe(true);
    expect(verifyGitHubWebhookSignature(raw, "sha256=deadbeef", WEBHOOK_SECRET)).toBe(false);
  });

  it("parses the repository and issue UUID from deterministic PR metadata", () => {
    expect(parsePaperclipDeliveryMetadata([
      `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
      "- Repository: Beyn-SOLIDUS/quantum",
    ].join("\n"))).toEqual({
      issueId: ISSUE_ID,
      repository: "Beyn-SOLIDUS/quantum",
    });
  });

  it("marks the linked issue done and cancels active runs after a signed merge event", async () => {
    const payload = mergedPullRequestPayload();
    const { raw, signature } = signedPayload(payload);

    const response = await request(createApp())
      .post("/api/webhooks/github")
      .set("content-type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "delivery-1")
      .set("x-hub-signature-256", signature)
      .send(raw);

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

  it("rejects an unsigned or incorrectly signed webhook", async () => {
    const response = await request(createApp())
      .post("/api/webhooks/github")
      .set("content-type", "application/json")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .send(mergedPullRequestPayload());

    expect(response.status).toBe(401);
    expect(serviceMocks.updateIssue).not.toHaveBeenCalled();
  });
});
