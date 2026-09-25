import {
  normalizePaperclipWakePayload,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
} from "./server-utils.js";

/**
 * Harness guard for autonomous delivery.
 *
 * A delivery-expected run may be recorded as succeeded only when the delivery
 * hook proved publication or an explicit nothing-to-deliver outcome. Narrative
 * text such as "implementation complete" is not proof.
 *
 * Classification of hook outcomes (see `classifyDeliveryInvocation`):
 *
 * | Hook outcome                         | Run status when delivery is expected |
 * | ------------------------------------ | ------------------------------------ |
 * | `created` with pr_url                | succeeded                            |
 * | `updated` with pr_url                | succeeded (wrapper refreshed a PR)   |
 * | `pr_exists` with pr_url              | succeeded                            |
 * | `issue_already_merged` with pr_url   | succeeded (already on the base)      |
 * | `no_diff`                            | succeeded (legitimate no-op)         |
 * | `created` / `updated` / `pr_exists` / `issue_already_merged` without pr_url | failed `not_delivered` |
 * | `delivery_hook_disabled`             | failed `not_delivered`               |
 * | `delivery_blocked` and `delivery_blocked:*` | failed `not_delivered`          |
 * | `push_failed`, `push_auth_failed`, `pr_create_failed` | failed `not_delivered` |
 * | `conflict`, `git_status_failed`, `git_add_failed`, `git_commit_failed` | failed `not_delivered` |
 * | other skips (`remote_delivery_not_enabled`, `missing_branch`, `base_branch`, `branch_checkout_failed`, hook throw) | failed `not_delivered` |
 * | `adapter_exit_nonzero` while the adapter result is already a failure | unchanged |
 *
 * `no_diff` stays succeeded: the hook logged `result=no_diff reason="nothing to deliver"`.
 * That is an explicit empty-tree outcome, not a skipped hook.
 *
 * Delivery-expected means all of:
 * - `PAPERCLIP_AUTONOMOUS_DELIVERY=1`
 * - the agent config has a non-empty `deliveryRepo` (roles without one are ignored)
 * - the run is for an issue that expects code (`workMode` is not `planning`,
 *   and the wake is not review/approval or a comment-triage hold)
 *
 * `PAPERCLIP_DELIVERY_GUARD=0` disables the guard. When unset, the guard follows
 * `PAPERCLIP_AUTONOMOUS_DELIVERY`.
 */

export const NOT_DELIVERED_ERROR_CODE = "not_delivered";
export const DELIVERY_GUARD_ENV = "PAPERCLIP_DELIVERY_GUARD";
export const AUTONOMOUS_DELIVERY_ENV = "PAPERCLIP_AUTONOMOUS_DELIVERY";

const PROOF_REASONS_REQUIRING_URL = new Set([
  "created",
  "updated",
  "pr_exists",
  "issue_already_merged",
]);

const LEGITIMATE_NOOP_REASONS = new Set(["no_diff"]);

const RESTORABLE_ISSUE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "cancelled",
  "in_review",
]);

export type DeliveryGuardHookResult = {
  delivered: boolean;
  prUrl: string | null;
  reason: string;
};

export type DeliveryInvocation =
  | { type: "result"; result: DeliveryGuardHookResult }
  | { type: "skipped"; reason: string }
  | { type: "error"; reason: string };

export type DeliveryGuardStatus = "succeeded" | "failed" | "unchanged";

export type DeliveryGuardResolution = {
  status: DeliveryGuardStatus;
  errorCode: typeof NOT_DELIVERED_ERROR_CODE | null;
  reason: string | null;
};

export type DeliveryGuardEnv = Record<string, string | undefined>;

type NotedDeliveryInvocation = {
  env: DeliveryGuardEnv;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  invocation: DeliveryInvocation;
};

const notedByRunId = new Map<string, NotedDeliveryInvocation>();

function readEnv(env: DeliveryGuardEnv, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isAutonomousDeliveryEnabled(env: DeliveryGuardEnv): boolean {
  return readEnv(env, AUTONOMOUS_DELIVERY_ENV) === "1";
}

export function isDeliveryGuardEnabled(env: DeliveryGuardEnv): boolean {
  const raw = readEnv(env, DELIVERY_GUARD_ENV).toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return isAutonomousDeliveryEnabled(env);
}

export function hasConfiguredDeliveryRepo(config: Record<string, unknown>): boolean {
  return readNonEmptyString(config.deliveryRepo) != null;
}

function wakeForbidsCode(context: Record<string, unknown>): boolean {
  const wakeRaw = parseObject(context.paperclipWake);
  if (context.dependencyBlockedInteraction === true || wakeRaw.dependencyBlockedInteraction === true) return true;
  if (context.treeHoldInteraction === true || wakeRaw.treeHoldInteraction === true) return true;
  const wake = normalizePaperclipWakePayload(wakeRaw);
  const stage = parseObject(wakeRaw.executionStage);
  const role = wake?.executionStage?.wakeRole ?? readNonEmptyString(stage.wakeRole);
  return role === "reviewer" || role === "approver";
}

export function issueExpectsCodeDelivery(context: Record<string, unknown>): boolean {
  const issue = parseObject(context.paperclipIssue);
  const wake = normalizePaperclipWakePayload(context.paperclipWake);
  const issueId = readNonEmptyString(context.issueId)
    ?? readNonEmptyString(context.taskId)
    ?? readNonEmptyString(issue.id)
    ?? wake?.issue?.id
    ?? null;
  if (!issueId) return false;
  if (readPaperclipIssueWorkModeFromContext(context) === "planning") return false;
  if (wakeForbidsCode(context)) return false;
  return true;
}

export function isDeliveryExpected(input: {
  env: DeliveryGuardEnv;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
}): boolean {
  return isAutonomousDeliveryEnabled(input.env)
    && hasConfiguredDeliveryRepo(input.config)
    && issueExpectsCodeDelivery(input.context);
}

function proofUrl(prUrl: string | null): string | null {
  if (typeof prUrl !== "string") return null;
  const trimmed = prUrl.trim();
  return trimmed.length > 0 && trimmed !== "null" ? trimmed : null;
}

export function classifyDeliveryInvocation(invocation: DeliveryInvocation): {
  proof: boolean;
  reason: string;
} {
  if (invocation.type === "skipped" || invocation.type === "error") {
    return { proof: false, reason: invocation.reason };
  }
  const reason = invocation.result.reason.trim();
  if (LEGITIMATE_NOOP_REASONS.has(reason)) {
    return { proof: true, reason };
  }
  if (PROOF_REASONS_REQUIRING_URL.has(reason)) {
    if (!proofUrl(invocation.result.prUrl)) {
      return { proof: false, reason: `${reason}_missing_pr_url` };
    }
    return { proof: true, reason };
  }
  return { proof: false, reason: reason || "delivery_missing" };
}

export function resolveDeliveryGuard(input: {
  env: DeliveryGuardEnv;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  invocation: DeliveryInvocation;
  adapterWouldSucceed: boolean;
}): DeliveryGuardResolution {
  if (!isDeliveryGuardEnabled(input.env) || !isDeliveryExpected(input) || !input.adapterWouldSucceed) {
    return { status: "unchanged", errorCode: null, reason: null };
  }
  const classified = classifyDeliveryInvocation(input.invocation);
  if (classified.proof) {
    return { status: "succeeded", errorCode: null, reason: classified.reason };
  }
  return {
    status: "failed",
    errorCode: NOT_DELIVERED_ERROR_CODE,
    reason: classified.reason,
  };
}

export function formatNotDeliveredLogLine(reason: string): string {
  const singleLine = reason.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
  return `[paperclip] delivery: not_delivered reason=${singleLine}\n`;
}

export function applyDeliveryGuardToAdapterResult<T extends {
  exitCode: number | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
}>(result: T, resolution: DeliveryGuardResolution): T {
  if (resolution.status !== "failed" || !resolution.reason || !resolution.errorCode) return result;
  return {
    ...result,
    exitCode: 1,
    errorCode: resolution.errorCode,
    errorMessage: `not_delivered: ${resolution.reason}`,
    resultJson: {
      ...(result.resultJson ?? {}),
      deliveryGuard: {
        errorCode: resolution.errorCode,
        reason: resolution.reason,
      },
    },
  };
}

export function snapshotDeliveryGuardEnv(env: Record<string, string | undefined>): DeliveryGuardEnv {
  return {
    [AUTONOMOUS_DELIVERY_ENV]: env[AUTONOMOUS_DELIVERY_ENV] ?? process.env[AUTONOMOUS_DELIVERY_ENV],
    [DELIVERY_GUARD_ENV]: env[DELIVERY_GUARD_ENV] ?? process.env[DELIVERY_GUARD_ENV],
  };
}

export function noteConfiguredDeliveryInvocation(
  input: {
    runId: string;
    env: Record<string, string | undefined>;
    config: Record<string, unknown>;
    context: Record<string, unknown>;
  },
  invocation: DeliveryInvocation,
): void {
  notedByRunId.set(input.runId, {
    env: snapshotDeliveryGuardEnv(input.env),
    config: input.config,
    context: input.context,
    invocation,
  });
}

export function takeNotedDeliveryInvocation(runId: string): NotedDeliveryInvocation | null {
  const noted = notedByRunId.get(runId) ?? null;
  if (noted) notedByRunId.delete(runId);
  return noted;
}

export type IssueStatusUpdate = {
  nextStatus: string | null;
  previousStatus: string | null;
};

export function readIssueStatusUpdate(details: unknown): IssueStatusUpdate | null {
  const record = parseObject(details);
  const nextStatus = readNonEmptyString(record.status);
  const previous = parseObject(record._previous);
  const previousStatus = readNonEmptyString(previous.status);
  if (!nextStatus && !previousStatus) return null;
  return { nextStatus, previousStatus };
}

/**
 * Status to put back when this run moved an issue to done or in_review without
 * delivery proof. Returns null when this run did not make that move.
 */
export function statusToRestoreAfterUndeliveredRun(
  currentStatus: string,
  updates: IssueStatusUpdate[],
): string | null {
  if (currentStatus !== "done" && currentStatus !== "in_review") return null;
  for (const update of updates) {
    const next = update.nextStatus;
    const previous = update.previousStatus;
    if (next !== "done" && next !== "in_review") continue;
    if (!previous || previous === currentStatus || previous === "done") continue;
    if (!RESTORABLE_ISSUE_STATUSES.has(previous)) continue;
    return previous;
  }
  return null;
}
