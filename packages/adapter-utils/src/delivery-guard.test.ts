import { describe, expect, it } from "vitest";
import { executeConfiguredDeliveryHook } from "./delivery-hook.js";
import {
  applyDeliveryGuardToAdapterResult,
  applyDispositionRestore,
  classifyNoDiffPublication,
  formatNotDeliveredLogLine,
  NOT_DELIVERED_ERROR_CODE,
  readIssueStatusUpdate,
  resolveDeliveryGuard,
  statusToRestoreAfterUndeliveredRun,
  takeNotedDeliveryInvocation,
  type DeliveryGuardEnv,
  type DeliveryInvocation,
} from "./delivery-guard.js";

const autonomousEnv: DeliveryGuardEnv = { PAPERCLIP_AUTONOMOUS_DELIVERY: "1" };
const codingConfig = { deliveryRepo: "Beyn-SOLIDUS/quantum" };
const codingContext = {
  issueId: "issue-1",
  paperclipIssue: { id: "issue-1", workMode: "standard" },
};
const prUrl = "https://github.com/Beyn-SOLIDUS/quantum/pull/42";

function resolve(invocation: DeliveryInvocation, overrides: {
  env?: DeliveryGuardEnv;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  adapterWouldSucceed?: boolean;
} = {}) {
  return resolveDeliveryGuard({
    env: overrides.env ?? autonomousEnv,
    config: overrides.config ?? codingConfig,
    context: overrides.context ?? codingContext,
    invocation,
    adapterWouldSucceed: overrides.adapterWouldSucceed ?? true,
  });
}

function result(
  reason: string,
  url: string | null,
  delivered = url != null,
  publicationChecked?: boolean,
): DeliveryInvocation {
  return {
    type: "result",
    result: {
      delivered,
      prUrl: url,
      reason,
      ...(publicationChecked === undefined ? {} : { publicationChecked }),
    },
  };
}

describe("delivery guard", () => {
  it("records created with a pr_url as succeeded", () => {
    const resolution = resolve(result("created", prUrl));
    expect(resolution).toEqual({ status: "succeeded", errorCode: null, reason: "created" });
  });

  it("records pr_exists with a pr_url as succeeded", () => {
    const resolution = resolve(result("pr_exists", prUrl));
    expect(resolution).toEqual({ status: "succeeded", errorCode: null, reason: "pr_exists" });
  });

  it("records updated with a pr_url as succeeded", () => {
    expect(resolve(result("updated", prUrl)).status).toBe("succeeded");
  });

  it("records issue_already_merged with a pr_url as succeeded", () => {
    const resolution = resolve(result("issue_already_merged", prUrl, false));
    expect(resolution).toEqual({ status: "succeeded", errorCode: null, reason: "issue_already_merged" });
  });

  it("does not treat bare no_diff as proof until publication is checked", () => {
    const resolution = resolve(result("no_diff", null, false));
    expect(resolution).toEqual({
      status: "failed",
      errorCode: "not_delivered",
      reason: "unpublished_commits",
    });
  });

  it("treats no_diff as a legitimate no-op after publication is verified", () => {
    const resolution = resolve(result("no_diff", null, false, true));
    expect(resolution).toEqual({ status: "succeeded", errorCode: null, reason: "no_diff" });
  });

  it("classifies commits ahead of the base or left unpushed as unpublished", () => {
    expect(classifyNoDiffPublication({ aheadOfBase: 0, unpushed: 0 })).toBe("no_diff");
    expect(classifyNoDiffPublication({ aheadOfBase: 2, unpushed: 0 })).toBe("unpublished_commits");
    expect(classifyNoDiffPublication({ aheadOfBase: 0, unpushed: 3 })).toBe("unpublished_commits");
    expect(classifyNoDiffPublication({ aheadOfBase: null, unpushed: 0 })).toBe("unpublished_commits");
    expect(classifyNoDiffPublication({ aheadOfBase: 0, unpushed: null })).toBe("unpublished_commits");
  });

  it("fails a delivery-expected run that never invoked the hook", () => {
    const resolution = resolveDeliveryGuard({
      env: autonomousEnv,
      config: codingConfig,
      context: codingContext,
      invocation: null,
      adapterWouldSucceed: true,
    });
    expect(resolution).toEqual({
      status: "failed",
      errorCode: "not_delivered",
      reason: "delivery_missing",
    });
    expect(formatNotDeliveredLogLine(resolution.reason!)).toBe(
      "[paperclip] delivery: not_delivered reason=delivery_missing\n",
    );
  });

  it("does not invent delivery_missing when the adapter already failed or delivery is not expected", () => {
    expect(resolveDeliveryGuard({
      env: autonomousEnv,
      config: codingConfig,
      context: codingContext,
      invocation: null,
      adapterWouldSucceed: false,
    }).status).toBe("unchanged");
    expect(resolveDeliveryGuard({
      env: autonomousEnv,
      config: {},
      context: codingContext,
      invocation: null,
      adapterWouldSucceed: true,
    }).status).toBe("unchanged");
  });

  it("fails a delivery-expected run when the hook is disabled", () => {
    const resolution = resolve({ type: "skipped", reason: "delivery_hook_disabled" });
    expect(resolution).toEqual({
      status: "failed",
      errorCode: NOT_DELIVERED_ERROR_CODE,
      reason: "delivery_hook_disabled",
    });
    const applied = applyDeliveryGuardToAdapterResult({
      exitCode: 0,
      errorMessage: null,
      errorCode: null,
      resultJson: { stdout: "implementation complete" },
    }, resolution);
    expect(applied.exitCode).toBe(1);
    expect(applied.errorCode).toBe("not_delivered");
    expect(applied.errorMessage).toBe("not_delivered: delivery_hook_disabled");
    expect(formatNotDeliveredLogLine(resolution.reason!)).toBe(
      "[paperclip] delivery: not_delivered reason=delivery_hook_disabled\n",
    );
  });

  it("fails a delivery-expected run when the hook is blocked", () => {
    const resolution = resolve(result("delivery_blocked: missing bot token", null, false));
    expect(resolution.status).toBe("failed");
    expect(resolution.errorCode).toBe("not_delivered");
    expect(resolution.reason).toBe("delivery_blocked: missing bot token");
    expect(formatNotDeliveredLogLine(resolution.reason!)).toBe(
      "[paperclip] delivery: not_delivered reason=delivery_blocked: missing bot token\n",
    );
  });

  it.each([
    "delivery_blocked",
    "delivery_blocked: quantum_pr_wrapper_failed",
    "push_failed",
    "push_auth_failed",
    "pr_create_failed",
    "conflict",
    "git_status_failed",
    "git_add_failed",
    "git_commit_failed",
    "remote_delivery_not_enabled",
    "missing_branch",
    "base_branch",
    "branch_checkout_failed",
    "delivery_hook_error",
  ])("classifies %s as not_delivered", (reason) => {
    const invocation: DeliveryInvocation = reason === "delivery_hook_error" || reason.startsWith("remote_") || reason.endsWith("_branch") || reason.startsWith("missing_") || reason.startsWith("branch_")
      ? { type: "skipped", reason }
      : result(reason, null, false);
    const resolution = resolve(invocation);
    expect(resolution.status).toBe("failed");
    expect(resolution.errorCode).toBe("not_delivered");
    expect(resolution.reason).toBe(reason);
  });

  it("does not treat a created result without a pr_url as proof", () => {
    const resolution = resolve(result("created", null));
    expect(resolution).toEqual({
      status: "failed",
      errorCode: "not_delivered",
      reason: "created_missing_pr_url",
    });
  });

  it("does not change a non-delivery agent that has no deliveryRepo", () => {
    const resolution = resolve(
      { type: "skipped", reason: "delivery_hook_disabled" },
      { config: { deliveryHookEnabled: false } },
    );
    expect(resolution).toEqual({ status: "unchanged", errorCode: null, reason: null });
  });

  it("does not flag planning, review, or issue-less runs", () => {
    expect(resolve(
      { type: "skipped", reason: "delivery_hook_disabled" },
      { context: { issueId: "issue-1", paperclipIssue: { id: "issue-1", workMode: "planning" } } },
    ).status).toBe("unchanged");
    expect(resolve(
      { type: "skipped", reason: "delivery_hook_disabled" },
      { context: { issueId: "issue-1", paperclipWake: { issue: { id: "issue-1" }, executionStage: { wakeRole: "reviewer" } } } },
    ).status).toBe("unchanged");
    expect(resolve(
      { type: "skipped", reason: "delivery_hook_disabled" },
      { context: {} },
    ).status).toBe("unchanged");
  });

  it("leaves behaviour unchanged when PAPERCLIP_DELIVERY_GUARD=0", () => {
    const resolution = resolve(
      { type: "skipped", reason: "delivery_hook_disabled" },
      { env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1", PAPERCLIP_DELIVERY_GUARD: "0" } },
    );
    expect(resolution).toEqual({ status: "unchanged", errorCode: null, reason: null });
  });

  it("does not rewrite an adapter failure as not_delivered", () => {
    const resolution = resolve(result("push_failed", null, false), { adapterWouldSucceed: false });
    expect(resolution.status).toBe("unchanged");
  });

  it("records a disabled hook invocation for the harness to fail", async () => {
    const runId = "delivery-guard-disabled-run";
    const logs: string[] = [];
    await executeConfiguredDeliveryHook({
      runId,
      worktreeCwd: "/tmp/unused",
      branch: "feature",
      env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1" },
      config: { deliveryHookEnabled: false, deliveryRepo: "Beyn-SOLIDUS/quantum" },
      context: codingContext,
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc: async () => {
        throw new Error("hook should not run commands when disabled");
      },
      log: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    const noted = takeNotedDeliveryInvocation(runId);
    expect(logs).toContain("[paperclip] delivery: skipped reason=delivery_hook_disabled\n");
    expect(noted?.invocation).toEqual({ type: "skipped", reason: "delivery_hook_disabled" });
    const resolution = resolveDeliveryGuard({
      env: noted!.env,
      config: noted!.config,
      context: noted!.context,
      invocation: noted!.invocation,
      adapterWouldSucceed: true,
    });
    expect(resolution.status).toBe("failed");
    expect(resolution.reason).toBe("delivery_hook_disabled");
  });

  it("restores the status from before this run moved the issue to done or in_review", () => {
    expect(statusToRestoreAfterUndeliveredRun("done", [
      { nextStatus: "done", previousStatus: "in_progress" },
    ])).toBe("in_progress");
    expect(statusToRestoreAfterUndeliveredRun("in_review", [
      { nextStatus: "in_review", previousStatus: "todo" },
    ])).toBe("todo");
    expect(statusToRestoreAfterUndeliveredRun("done", [
      { nextStatus: "in_review", previousStatus: "in_progress" },
      { nextStatus: "done", previousStatus: "in_review" },
    ])).toBe("in_progress");
    expect(statusToRestoreAfterUndeliveredRun("in_review", [])).toBeNull();
    expect(statusToRestoreAfterUndeliveredRun("in_progress", [
      { nextStatus: "done", previousStatus: "in_progress" },
    ])).toBeNull();
  });

  it("does not restore when another actor moved the issue to done after this run", () => {
    expect(statusToRestoreAfterUndeliveredRun("done", [
      { nextStatus: "in_review", previousStatus: "in_progress" },
    ])).toBeNull();
  });

  it("reads a plugin status update from details.patch.status", () => {
    expect(readIssueStatusUpdate({
      patch: { status: "done" },
      _previous: { status: "in_progress" },
    })).toEqual({ nextStatus: "done", previousStatus: "in_progress" });
    expect(statusToRestoreAfterUndeliveredRun("done", [
      readIssueStatusUpdate({
        patch: { status: "done" },
        _previous: { status: "in_progress" },
      })!,
    ])).toBe("in_progress");
  });

  it("does not record a restore when another actor wins the status race", async () => {
    let recorded = false;
    const claimed = await applyDispositionRestore({
      expectedStatus: "in_review",
      restoreStatus: "in_progress",
      updatedAt: new Date("2026-09-25T00:00:00.000Z"),
      compareAndSet: async (expectedStatus, patch) => {
        expect(expectedStatus).toBe("in_review");
        expect(patch).toMatchObject({ status: "in_progress", completedAt: null, cancelledAt: null });
        expect(patch).not.toHaveProperty("startedAt");
        return false;
      },
      record: async () => {
        recorded = true;
      },
    });
    expect(claimed).toBe(false);
    expect(recorded).toBe(false);
  });

  it("records the restore only after the conditional update succeeds", async () => {
    let recorded = false;
    const claimed = await applyDispositionRestore({
      expectedStatus: "done",
      restoreStatus: "in_progress",
      updatedAt: new Date("2026-09-25T00:00:00.000Z"),
      compareAndSet: async (_expectedStatus, patch) => {
        expect(patch).not.toHaveProperty("startedAt");
        expect(patch.status).toBe("in_progress");
        return true;
      },
      record: async () => {
        recorded = true;
      },
    });
    expect(claimed).toBe(true);
    expect(recorded).toBe(true);
  });

  it("keeps a noted delivery result when the summary log throws", async () => {
    const runId = "delivery-guard-log-throw";
    const result = await executeConfiguredDeliveryHook({
      runId,
      worktreeCwd: "/tmp/unused",
      branch: "feature",
      env: {},
      config: { deliveryRepo: "other/repo", deliveryBaseBranch: "main" },
      context: {},
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc: async (cmd, args) => {
        if (cmd === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (cmd === "git" && args[0] === "rev-list") return { exitCode: 0, stdout: "0\n", stderr: "" };
        if (cmd === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: "origin/feature\n", stderr: "" };
        throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
      },
      log: async (_stream, chunk) => {
        if (chunk.startsWith("[paperclip] delivery:")) throw new Error("log failed");
      },
    });
    expect(result).toMatchObject({ reason: "no_diff", publicationChecked: true });
    const noted = takeNotedDeliveryInvocation(runId);
    expect(noted?.invocation).toEqual({
      type: "result",
      result: { delivered: false, prUrl: null, reason: "no_diff", publicationChecked: true },
    });
  });
});
