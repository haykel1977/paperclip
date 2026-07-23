import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, projectWorkspaces } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { parseObject } from "../adapters/utils.js";

const ACTIVE_DELIVERY_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAPERCLIP_ISSUE_METADATA_RE = new RegExp(`^- Paperclip issue: .+ \\((${UUID_V4_PATTERN})\\)$`, "im");
const REPOSITORY_METADATA_RE = /^- Repository: ([^\s/]+\/[^\s/]+)$/im;

type RawBodyRequest = Request & { rawBody?: Buffer };

type GitHubPullRequestWebhook = {
  action?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: {
    number?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    html_url?: unknown;
    body?: unknown;
    merge_commit_sha?: unknown;
  };
};

export function verifyGitHubWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const providedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function parsePaperclipDeliveryMetadata(body: string) {
  const issueId = body.match(PAPERCLIP_ISSUE_METADATA_RE)?.[1] ?? null;
  const repository = body.match(REPOSITORY_METADATA_RE)?.[1] ?? null;
  if (!issueId || !repository) return null;
  return { issueId, repository };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function githubWebhookRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  router.post("/", async (req: RawBodyRequest, res) => {
    const secret = process.env.PAPERCLIP_GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      res.status(503).json({ error: "GitHub webhook secret is not configured" });
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody || !verifyGitHubWebhookSignature(rawBody, req.header("x-hub-signature-256"), secret)) {
      res.status(401).json({ error: "Invalid GitHub webhook signature" });
      return;
    }

    if (req.header("x-github-event") !== "pull_request") {
      res.status(202).json({ accepted: true, ignored: "unsupported_event" });
      return;
    }

    const payload = req.body && typeof req.body === "object"
      ? req.body as GitHubPullRequestWebhook
      : {};
    if (payload.action !== "closed" || payload.pull_request?.merged !== true) {
      res.status(202).json({ accepted: true, ignored: "pull_request_not_merged" });
      return;
    }

    const body = readString(payload.pull_request.body);
    const repository = readString(payload.repository?.full_name);
    const metadata = body ? parsePaperclipDeliveryMetadata(body) : null;
    if (!metadata) {
      res.status(202).json({ accepted: true, ignored: "not_a_paperclip_delivery" });
      return;
    }
    if (metadata.repository.toLowerCase() !== repository?.toLowerCase()) {
      res.status(400).json({ error: "Delivery repository metadata does not match webhook repository" });
      return;
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(metadata.issueId)) {
      res.status(400).json({ error: "Invalid issue ID format" });
      return;
    }

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, metadata.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      res.status(404).json({ error: "Paperclip issue not found" });
      return;
    }

    // Verify the webhook repository belongs to the issue's company
    const repoFullName = metadata.repository.toLowerCase();
    const repoUrlPatterns = [
      `%github.com/${repoFullName}%`,
      `%github.com/${repoFullName}.git%`,
    ];
    const authorizedWorkspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, issue.companyId),
          or(
            sql`LOWER(${projectWorkspaces.repoUrl}) LIKE ${repoUrlPatterns[0]}`,
            sql`LOWER(${projectWorkspaces.repoUrl}) LIKE ${repoUrlPatterns[1]}`,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!authorizedWorkspace) {
      res.status(403).json({ error: "Repository is not authorized for this company" });
      return;
    }

    // Always cancel active runs for this issue, even if already done/cancelled (idempotent cleanup)
    const activeRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_DELIVERY_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      );
    if (activeRuns.length > 0) {
      await Promise.all(
        activeRuns.map((run) =>
          heartbeat.cancelRun(run.id, "Cancelled because the linked GitHub pull request was merged"),
        ),
      );
    }

    if (issue.status === "done") {
      res.json({ accepted: true, issueId: issue.id, status: "done", changed: false, cancelledRuns: activeRuns.length });
      return;
    }
    if (issue.status === "cancelled") {
      res.json({ accepted: true, issueId: issue.id, status: "cancelled", changed: false, cancelledRuns: activeRuns.length });
      return;
    }

    const currentExecutionState = parseObject(issue.executionState);
    const prNumber = typeof payload.pull_request.number === "number" ? payload.pull_request.number : null;
    const prUrl = readString(payload.pull_request.html_url);
    const mergeCommitSha = readString(payload.pull_request.merge_commit_sha);
    const mergedAt = readString(payload.pull_request.merged_at);
    const deliveryId = readString(req.header("x-github-delivery"));
    const updated = await issuesSvc.update(issue.id, {
      status: "done",
      executionState: {
        ...currentExecutionState,
        githubDelivery: {
          repository,
          prNumber,
          prUrl,
          mergeCommitSha,
          mergedAt,
          deliveryId,
        },
      },
    });

    res.json({ accepted: true, issueId: issue.id, status: updated?.status ?? "done", changed: true });
  });

  return router;
}
