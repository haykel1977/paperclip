import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, projectWorkspaces } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";

const ACTIVE_DELIVERY_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAPERCLIP_ISSUE_METADATA_RE = new RegExp(`^- Paperclip issue: .+ \\((${UUID_PATTERN})\\)$`, "im");
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

export type GitHubDeliveryIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  status: string;
  executionState: unknown;
};

type GitHubDeliveryMetadata = {
  issueId: string;
  repository: string;
};

export type GitHubWebhookDependencies = {
  findIssue(issueId: string): Promise<GitHubDeliveryIssue | null>;
  listTrustedRepositoryUrls(issue: GitHubDeliveryIssue): Promise<string[]>;
  listActiveRuns(issue: GitHubDeliveryIssue): Promise<Array<{ id: string }>>;
  cancelRun(runId: string): Promise<unknown>;
  markIssueDone(issue: GitHubDeliveryIssue, delivery: Record<string, unknown>): Promise<string>;
  logMerge(input: {
    issue: GitHubDeliveryIssue;
    repository: string;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;

    mergeCommitSha: string | null;
    deliveryId: string | null;
    cancelledRunIds: string[];
    changed: boolean;
  }): Promise<void>;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeGitHubRepository(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  let path = raw;
  const scpMatch = raw.match(/^git@github\.com:([^\s]+)$/i);
  if (scpMatch) {
    path = scpMatch[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }

  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) return null;
  return normalized.toLowerCase();
}

export function verifyGitHubWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const providedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function parsePaperclipDeliveryMetadata(body: string): GitHubDeliveryMetadata | null {
  const issueId = body.match(PAPERCLIP_ISSUE_METADATA_RE)?.[1] ?? null;
  const repository = body.match(REPOSITORY_METADATA_RE)?.[1] ?? null;
  if (!issueId || !repository || !normalizeGitHubRepository(repository)) return null;
  return { issueId, repository };
}

function createDefaultDependencies(db: Db): GitHubWebhookDependencies {
  const heartbeat = heartbeatService(db);
  const issuesSvc = issueService(db);

  return {
    async findIssue(issueId) {
      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          status: issues.status,
          executionState: issues.executionState,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
    },

    async listTrustedRepositoryUrls(issue) {
      if (issue.projectWorkspaceId) {
        return db
          .select({ repoUrl: projectWorkspaces.repoUrl })
          .from(projectWorkspaces)
          .where(and(
            eq(projectWorkspaces.id, issue.projectWorkspaceId),
            eq(projectWorkspaces.companyId, issue.companyId),
            ...(issue.projectId ? [eq(projectWorkspaces.projectId, issue.projectId)] : []),
          ))
          .then((rows) => rows.flatMap((row) => row.repoUrl ? [row.repoUrl] : []));
      }
      if (!issue.projectId) return [];
      return db
        .select({ repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.companyId, issue.companyId),
          eq(projectWorkspaces.projectId, issue.projectId),
        ))
        .then((rows) => rows.flatMap((row) => row.repoUrl ? [row.repoUrl] : []));
    },

    async listActiveRuns(issue) {
      return db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_DELIVERY_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ));
    },

    cancelRun(runId) {
      return heartbeat.cancelRun(runId, "Cancelled because the linked GitHub pull request was merged");
    },

    async markIssueDone(issue, delivery) {
      const updated = await issuesSvc.update(issue.id, {
        status: "done",
        executionState: {
          ...parseObject(issue.executionState),
          githubDelivery: delivery,
        },
      });
      return updated?.status ?? "done";
    },

    logMerge(input) {
      return logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "github-webhook",
        action: "issue.github_delivery_merged",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          pullRequestUrl: input.pullRequestUrl,
          mergeCommitSha: input.mergeCommitSha,
          deliveryId: input.deliveryId,
          cancelledRunIds: input.cancelledRunIds,
          changed: input.changed,
        },
      });
    },
  };
}

export function githubWebhookRoutes(db: Db, dependencyOverrides?: GitHubWebhookDependencies) {
  const router = Router();
  const dependencies = dependencyOverrides ?? createDefaultDependencies(db);

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
    const payloadRepository = normalizeGitHubRepository(readString(payload.repository?.full_name));
    const metadata = body ? parsePaperclipDeliveryMetadata(body) : null;
    if (!metadata) {
      res.status(202).json({ accepted: true, ignored: "not_a_paperclip_delivery" });
      return;
    }
    if (!payloadRepository) {
      res.status(400).json({ error: "Webhook repository is missing or invalid" });
      return;
    }

    const metadataRepository = normalizeGitHubRepository(metadata.repository);
    if (metadataRepository !== payloadRepository) {
      res.status(400).json({ error: "Delivery repository metadata does not match webhook repository" });
      return;
    }

    const issue = await dependencies.findIssue(metadata.issueId);
    if (!issue) {
      res.status(404).json({ error: "Paperclip issue not found" });
      return;
    }

    const trustedRepositories = new Set(
      (await dependencies.listTrustedRepositoryUrls(issue))
        .map((repoUrl) => normalizeGitHubRepository(repoUrl))
        .filter((repo): repo is string => Boolean(repo)),
    );
    if (trustedRepositories.size === 0) {
      res.status(409).json({ error: "Paperclip issue has no trusted GitHub repository binding" });
      return;
    }
    if (!trustedRepositories.has(payloadRepository)) {
      res.status(403).json({ error: "Webhook repository is not authorized for this Paperclip issue" });
      return;
    }

    const activeRuns = await dependencies.listActiveRuns(issue);
    await Promise.all(activeRuns.map((run) => dependencies.cancelRun(run.id)));

    const pullRequestNumber = typeof payload.pull_request.number === "number" ? payload.pull_request.number : null;
    const pullRequestUrl = readString(payload.pull_request.html_url);
    const mergeCommitSha = readString(payload.pull_request.merge_commit_sha);
    const mergedAt = readString(payload.pull_request.merged_at);
    const deliveryId = readString(req.header("x-github-delivery"));
    const changed = issue.status !== "done" && issue.status !== "cancelled";
    const status = changed
      ? await dependencies.markIssueDone(issue, {
          repository: payloadRepository,
          pullRequestNumber,
          pullRequestUrl,
          mergeCommitSha,
          mergedAt,
          deliveryId,
        })
      : issue.status;

    await dependencies.logMerge({
      issue,
      repository: payloadRepository,
      pullRequestNumber,
      pullRequestUrl,
      mergeCommitSha,
      deliveryId,
      cancelledRunIds: activeRuns.map((run) => run.id),
      changed,
    });

    res.json({ accepted: true, issueId: issue.id, status, changed });
  });

  return router;
}
