import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  githubWebhookRoutes,
  normalizeGitHubRepository,
  parsePaperclipDeliveryMetadata,
  verifyGitHubWebhookSignature,
  type GitHubDeliveryIssue,
  type GitHubWebhookDependencies,
} from "../routes/github-webhooks.js";

const SECRET = "test-webhook-secret";
const ISSUE_ID = "123e4567-e89b-12d3-a456-426614174000";

function createIssue(status = "in_progress"): GitHubDeliveryIssue {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    status,
    executionState: null,
  };
}

function createDependencies(overrides: Partial<GitHubWebhookDependencies> = {}): GitHubWebhookDependencies {
  return {
    findIssue: vi.fn(async () => createIssue()),
    listTrustedRepositoryUrls: vi.fn(async () => ["https://github.com/Beyn-SOLIDUS/quantum.git"]),
    listActiveRuns: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]),
    cancelRun: vi.fn(async () => undefined),
    markIssueDone: vi.fn(async () => "done"),
    markIssueBlocked: vi.fn(async () => "blocked"),
    logDelivery: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createApp(dependencies: GitHubWebhookDependencies) {

  const app = express();
  app.use(express.json({
    verify(req, _res, buffer) {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
    },
  }));
  app.use("/api/webhooks/github", githubWebhookRoutes({} as Db, dependencies));
  return app;
}

function payload(repository = "Beyn-SOLIDUS/quantum") {
  return {
    action: "closed",
    repository: { full_name: repository },
    pull_request: {
      number: 42,
      merged: true,
      merged_at: "2026-07-23T10:00:00.000Z",
      html_url: "https://github.com/Beyn-SOLIDUS/quantum/pull/42",
      merge_commit_sha: "abc123",
      head: { repo: { full_name: repository } },
      body: [
        "## Delivery Metadata",
        `- Paperclip issue: QUA-38 (${ISSUE_ID})`,
        `- Repository: ${repository}`,
      ].join("\n"),

    },
  };
}

function signature(body: unknown) {
  return `sha256=${createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex")}`;
}

async function postWebhook(app: express.Express, body: unknown, event = "pull_request") {
  return request(app)
    .post("/api/webhooks/github")
    .set("x-github-event", event)
    .set("x-github-delivery", "delivery-1")
    .set("x-hub-signature-256", signature(body))
    .send(body);
}

describe("GitHub delivery webhook", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET;
  });

  it("normalizes trusted GitHub repository URLs and validates deterministic metadata", () => {
    expect(normalizeGitHubRepository("git@github.com:Beyn-SOLIDUS/quantum.git")).toBe("beyn-solidus/quantum");
    expect(normalizeGitHubRepository("https://github.com/Beyn-SOLIDUS/quantum.git")).toBe("beyn-solidus/quantum");
    expect(normalizeGitHubRepository("https://gitlab.com/Beyn-SOLIDUS/quantum")).toBeNull();
    expect(parsePaperclipDeliveryMetadata(payload().pull_request.body)).toEqual({
      issueId: ISSUE_ID,
      repository: "Beyn-SOLIDUS/quantum",
    });
    expect(parsePaperclipDeliveryMetadata(`- Paperclip issue: QUA-38 (${ISSUE_ID})`)).toBeNull();
    expect(verifyGitHubWebhookSignature(Buffer.from("body"), undefined, SECRET)).toBe(false);
  });

  it("marks a trusted issue done, cancels all active runs, and records the merge", async () => {
    const dependencies = createDependencies();
    const body = payload();
    const response = await postWebhook(createApp(dependencies), body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      issueId: ISSUE_ID,
      status: "done",
      changed: true,
      outcome: "merged",
    });
    expect(dependencies.cancelRun).toHaveBeenCalledTimes(2);
    expect(dependencies.markIssueDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: ISSUE_ID }),
      expect.objectContaining({ status: "merged", repository: "beyn-solidus/quantum", deliveryId: "delivery-1" }),
    );
    expect(dependencies.logDelivery).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "merged",
      cancelledRunIds: ["run-1", "run-2"],
      changed: true,
    }));
  });

  it("blocks the issue and cancels active runs when its delivery PR is closed without merge", async () => {
    const dependencies = createDependencies();
    const body = payload();
    body.pull_request.merged = false;

    const response = await postWebhook(createApp(dependencies), body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      issueId: ISSUE_ID,
      status: "blocked",
      changed: true,
      outcome: "closed_without_merge",
    });
    expect(dependencies.cancelRun).toHaveBeenCalledTimes(2);
    expect(dependencies.markIssueDone).not.toHaveBeenCalled();
    expect(dependencies.markIssueBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: ISSUE_ID }),
      expect.objectContaining({
        status: "closed_without_merge",
        repository: "beyn-solidus/quantum",
        pullRequestUrl: "https://github.com/Beyn-SOLIDUS/quantum/pull/42",
      }),
    );
    expect(dependencies.logDelivery).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "closed_without_merge",
      cancelledRunIds: ["run-1", "run-2"],
      changed: true,
    }));
  });

  it("ignores an unmerged closure from a fork before reading or mutating the issue", async () => {
    const dependencies = createDependencies();
    const body = payload();
    body.pull_request.merged = false;
    body.pull_request.head.repo.full_name = "external/fork";

    const response = await postWebhook(createApp(dependencies), body);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true, ignored: "untrusted_closed_delivery_source" });
    expect(dependencies.findIssue).not.toHaveBeenCalled();
    expect(dependencies.cancelRun).not.toHaveBeenCalled();
    expect(dependencies.markIssueBlocked).not.toHaveBeenCalled();
  });

  it("remains idempotent while still cancelling stale runs for an issue already done", async () => {

    const dependencies = createDependencies({ findIssue: vi.fn(async () => createIssue("done")) });
    const response = await postWebhook(createApp(dependencies), payload());

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(dependencies.cancelRun).toHaveBeenCalledTimes(2);
    expect(dependencies.markIssueDone).not.toHaveBeenCalled();
    expect(dependencies.logDelivery).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "merged",
      changed: false,
    }));
  });

  it("rejects a repository that is not bound to the issue company and project", async () => {

    const dependencies = createDependencies({
      listTrustedRepositoryUrls: vi.fn(async () => ["https://github.com/Beyn-SOLIDUS/other-repo"]),
    });
    const response = await postWebhook(createApp(dependencies), payload());

    expect(response.status).toBe(403);
    expect(dependencies.listActiveRuns).not.toHaveBeenCalled();
    expect(dependencies.cancelRun).not.toHaveBeenCalled();
    expect(dependencies.markIssueDone).not.toHaveBeenCalled();
  });

  it("fails closed when the issue has no trusted repository binding", async () => {
    const dependencies = createDependencies({ listTrustedRepositoryUrls: vi.fn(async () => []) });
    const response = await postWebhook(createApp(dependencies), payload());

    expect(response.status).toBe(409);
    expect(dependencies.cancelRun).not.toHaveBeenCalled();
    expect(dependencies.markIssueDone).not.toHaveBeenCalled();
  });

  it("rejects mismatched repository metadata before reading the issue", async () => {
    const dependencies = createDependencies();
    const body = payload();
    body.pull_request.body = body.pull_request.body.replace(
      "- Repository: Beyn-SOLIDUS/quantum",
      "- Repository: attacker/repository",
    );
    const response = await postWebhook(createApp(dependencies), body);

    expect(response.status).toBe(400);
    expect(dependencies.findIssue).not.toHaveBeenCalled();
  });

  it("handles unsupported events, missing issues, invalid signatures, and missing configuration without mutation", async () => {
    const dependencies = createDependencies({ findIssue: vi.fn(async () => null) });
    const app = createApp(dependencies);
    const body = payload();

    expect((await postWebhook(app, body, "push")).status).toBe(202);
    expect((await postWebhook(app, body)).status).toBe(404);
    expect((await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", "sha256=invalid")
      .send(body)).status).toBe(401);

    delete process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET;
    expect((await request(app).post("/api/webhooks/github").send(body)).status).toBe(503);
    expect(dependencies.cancelRun).not.toHaveBeenCalled();
    expect(dependencies.markIssueDone).not.toHaveBeenCalled();
  });
});
