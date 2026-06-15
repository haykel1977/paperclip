import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCodexJsonl,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import { pathExists, prepareManagedCodexHome, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

function readCodexTransientFallbackMode(context: Record<string, unknown>): CodexTransientFallbackMode | null {
  const value = asString(context.codexTransientFallbackMode, "").trim();
  switch (value) {
    case "same_session":
    case "safer_invocation":
    case "fresh_session":
    case "fresh_session_safer_invocation":
      return value;
    default:
      return null;
  }
}

function fallbackModeUsesSaferInvocation(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "safer_invocation" || mode === "fresh_session_safer_invocation";
}

function fallbackModeUsesFreshSession(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "fresh_session" || mode === "fresh_session_safer_invocation";
}

function buildCodexTransientHandoffNote(input: {
  previousSessionId: string | null;
  fallbackMode: CodexTransientFallbackMode;
  continuationSummaryBody: string | null;
}): string {
  return [
    "Paperclip session handoff:",
    input.previousSessionId ? `- Previous session: ${input.previousSessionId}` : "",
    "- Rotation reason: repeated Codex transient remote-compaction failures",
    `- Fallback mode: ${input.fallbackMode}`,
    input.continuationSummaryBody
      ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

/**
 * executeDeliveryHook — deterministic post-run delivery (commit -> push -> PR).
 *
 * Why: Paperclip had no delivery hook; delivery was fully delegated to the model
 * (qwen3-coder:30b) which edits but does not reliably run the git sequence
 * (investigation C2+C3, 2026-06-08).
 *
 * Doctrine: NO LLM here. Pure git + gh CLI. Never merges. Idempotent. Reviewer
 * requested best-effort post-create (GitHub forbids self-review).
 *
 * Lane (PAPERCLIP_DELIVERY_LANE): default "production" is fail-closed — keeps the
 * human-gate label so Quantum's auto-merge stays blocked (ADR-GOV-007, HAS-46 human
 * review by @haykel1977). "dev-test" opts eligible PRs into the no-human lane: omits
 * the human-gate label and emits the labels/body Quantum's no-human gate requires.
 * The hook never merges in either lane.
 */
export async function executeDeliveryHook(input: {
  runId: string;
  worktreeCwd: string;
  branch: string;
  env: Record<string, string>;
  issueIdentifier: string | null;
  issueId: string | null;
  repo: string;
  baseBranch: string;
  runProc: (
    cmd: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  log: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<{ delivered: boolean; prUrl: string | null; reason: string }> {
  const { worktreeCwd, branch, env, runProc, log } = input;
  const ts = () => new Date().toISOString();

  // Delivery lane. Default is "production": fail-closed, keeps the human-gate label so
  // Quantum's auto-merge stays blocked (ADR-GOV-007) and a human must merge. Operators
  // opt eligible dev/test PRs into the no-human lane with PAPERCLIP_DELIVERY_LANE=dev-test,
  // which omits the human-gate label and adds the labels/body Quantum's no-human gate
  // requires (agent-pr/automated/truth-first + ADR ref + Truthfulness Boundary). The hook
  // itself never merges in either lane — auto-merge is Quantum's decision, not Paperclip's.
  const lane = (env.PAPERCLIP_DELIVERY_LANE ?? process.env.PAPERCLIP_DELIVERY_LANE ?? "production").trim();
  const isDevTestLane = lane === "dev-test";
  const deliveryLabels = isDevTestLane
    ? ["factory-proof", "agent-pr", "automated", "truth-first"]
    : ["factory-proof", "human-gate-required"];

  const status = await runProc("git", ["status", "--porcelain"], worktreeCwd, env);
  if (status.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git status failed: ${status.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_status_failed" };
  }
  if (!status.stdout.trim()) {
    await log("stdout", `[delivery ${ts()}] no diff — nothing to deliver (ok).\n`);
    return { delivered: false, prUrl: null, reason: "no_diff" };
  }
  if (/^(UU|AA|DD) /m.test(status.stdout)) {
    await log("stderr", `[delivery ${ts()}] merge conflict markers — abort, no force.\n`);
    return { delivered: false, prUrl: null, reason: "conflict" };
  }

  const title = `${input.issueIdentifier ?? "FACTORY"}: factory delivery`;
  const bodyHeader = [
    `Paperclip issue: ${input.issueIdentifier ?? "?"} (${input.issueId ?? "?"})`,
    `Run: ${input.runId}`,
    `Model: sovereign (qwen3-coder:30b @ Bifrost CCX43)`,
    `Factory: sovereign delivery hook (deterministic, no LLM)`,
  ];
  const bodyGate = isDevTestLane
    ? [
        ``,
        `ADR: ADR-GOV-007 (dev/test no-human lane — eligible agent-pr/automated PRs may`,
        `auto-merge once functional and security checks are green; production stays gated).`,
        ``,
        `## Truthfulness Boundary`,
        `This PR is produced by a deterministic delivery hook with no LLM in the delivery`,
        `path. Claims in this body are limited to factory metadata (issue, run, lane) that`,
        `the hook can verify; it makes no assertions about correctness of the diff beyond`,
        `the configured functional and security gates.`,
      ]
    : [``, `HAS-46: human review required — never auto-merge.`];
  const body = [...bodyHeader, ...bodyGate].join("\n");

  const add = await runProc("git", ["add", "-A"], worktreeCwd, env);
  if (add.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git add failed: ${add.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_add_failed" };
  }
  const commit = await runProc("git", ["commit", "-m", title, "-m", body], worktreeCwd, env);
  if (commit.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git commit failed: ${commit.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_commit_failed" };
  }

  // Sovereign delivery hook — operator-configured deterministic commit->push->PR path
  // (no LLM, never merges; human review gated by HAS-46). See executeDeliveryHook doctrine above.
  // paperclip:allow-git-push: sovereign delivery hook is the intended operator-configured push path
  const push = await runProc("git", ["push", "-u", "origin", branch], worktreeCwd, env);
  if (push.exitCode !== 0) {
    const s = (push.stderr || "").toLowerCase();
    const reason =
      s.includes("401") || s.includes("403") || s.includes("denied") ? "push_auth_failed" : "push_failed";
    await log("stderr", `[delivery ${ts()}] push ${reason}: ${push.stderr}\n`);
    return { delivered: false, prUrl: null, reason };
  }

  // Idempotence: existing PR on this head -> reconcile labels (filtered), no duplicate.
  const existing = await runProc(
    "gh",
    ["pr", "list", "--repo", input.repo, "--head", branch, "--json", "url", "--jq", ".[0].url // empty"],
    worktreeCwd,
    env,
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    const existingUrl = existing.stdout.trim();
    const labelsRequiredReco = deliveryLabels;
    let labelsToReconcile: string[] = [];
    const labelListReco = await runProc(
      "gh",
      ["label", "list", "--repo", input.repo, "--limit", "200", "--json", "name", "--jq", "[.[].name]"],
      worktreeCwd,
      env,
    );
    if (labelListReco.exitCode === 0) {
      try {
        const existingLabels: string[] = JSON.parse(labelListReco.stdout || "[]");
        labelsToReconcile = labelsRequiredReco.filter((l) => existingLabels.includes(l));
      } catch (e) {
        await log("stderr", `[delivery ${ts()}] reco label parse failed: ${(e as Error).message}\n`);
      }
    }
    if (labelsToReconcile.length > 0) {
      const editArgs = ["pr", "edit", existingUrl];
      for (const l of labelsToReconcile) editArgs.push("--add-label", l);
      const lr = await runProc("gh", editArgs, worktreeCwd, env);
      if (lr.exitCode !== 0) {
        await log("stderr", `[delivery ${ts()}] relabel existing PR failed (non-fatal): ${lr.stderr}\n`);
      }
    } else {
      await log("stderr", `[delivery ${ts()}] reco skipped (no labels exist in repo, Phase -1 not done?)\n`);
    }
    await log("stdout", `[delivery ${ts()}] PR already exists (idempotent): ${existingUrl}\n`);
    return { delivered: true, prUrl: existingUrl, reason: "pr_exists" };
  }

  // Label pre-flight: only apply labels that exist in the repo (Phase -1).
  const labelsRequired = deliveryLabels;
  let labelsToApply: string[] = [];
  const labelList = await runProc(
    "gh",
    ["label", "list", "--repo", input.repo, "--limit", "200", "--json", "name", "--jq", "[.[].name]"],
    worktreeCwd,
    env,
  );
  if (labelList.exitCode === 0) {
    try {
      const existingNames: string[] = JSON.parse(labelList.stdout || "[]");
      labelsToApply = labelsRequired.filter((l) => existingNames.includes(l));
      const missing = labelsRequired.filter((l) => !existingNames.includes(l));
      if (missing.length) {
        await log("stderr", `[delivery ${ts()}] labels missing (Phase -1 not done?): ${missing.join(",")}\n`);
      }
    } catch (e) {
      await log("stderr", `[delivery ${ts()}] label parse failed: ${(e as Error).message}\n`);
    }
  } else {
    await log("stderr", `[delivery ${ts()}] gh label list failed, no labels: ${labelList.stderr}\n`);
  }

  const prArgs = [
    "pr",
    "create",
    "--repo",
    input.repo,
    "--head",
    branch,
    "--base",
    input.baseBranch,
    "--title",
    title,
    "--body",
    body,
  ];
  for (const l of labelsToApply) prArgs.push("--label", l);
  // NOTE: no --reviewer at create time (Adjustment C — GitHub forbids self-review).
  const pr = await runProc("gh", prArgs, worktreeCwd, env);
  if (pr.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] gh pr create failed: ${pr.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "pr_create_failed" };
  }
  const url = (pr.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [null])[0];
  if (url) {
    const rev = await runProc("gh", ["pr", "edit", url, "--add-reviewer", "haykel1977"], worktreeCwd, env);
    if (rev.exitCode !== 0) {
      await log("stderr", `[delivery ${ts()}] add-reviewer failed (non-fatal): ${rev.stderr}\n`);
    }
  }
  await log("stdout", `[delivery ${ts()}] PR created: ${url}\n`);
  return { delivered: true, prUrl: url, reason: "created" };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const deliveryHookEnabled = config.deliveryHookEnabled !== false; // delivery hook: deterministic, no LLM (default on)
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configuredOpenAiApiKey =
    typeof envConfig.OPENAI_API_KEY === "string" && envConfig.OPENAI_API_KEY.trim().length > 0
      ? envConfig.OPENAI_API_KEY.trim()
      : null;
  const preparedManagedCodexHome =
    configuredCodexHome
      ? null
      : await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
          apiKey: configuredOpenAiApiKey,
        });
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  // Inject skills into the same CODEX_HOME that Codex will actually run with
  // (managed home in the default case, or an explicit override from adapter config).
  const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
  await ensureCodexSkillsInjected(
    onLog,
    {
      skillsHome: codexSkillsDir,
      skillsEntries: codexSkillEntries,
      desiredSkillNames,
    },
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "codex",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "home",
              localDir: effectiveCodexHome,
              followSymlinks: true,
            },
          ],
        });
      })()
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  const executionTargetIsSandbox =
    runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox";
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  const remoteCodexHome = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.home ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
    : null;
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (issueWorkMode) {
    env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "codex",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const codexTransientFallbackMode = readCodexTransientFallbackMode(context);
  const forceSaferInvocation = fallbackModeUsesSaferInvocation(codexTransientFallbackMode);
  const forceFreshSession = fallbackModeUsesFreshSession(codexTransientFallbackMode);
  const sessionId = canResumeSession && !forceFreshSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  instructionsChars = promptInstructionsPrefix.length;
  const continuationSummary = parseObject(context.paperclipContinuationSummary);
  const continuationSummaryBody = asString(continuationSummary.body, "").trim() || null;
  const codexFallbackHandoffNote =
    forceFreshSession
      ? buildCodexTransientHandoffNote({
          previousSessionId: runtimeSessionId || runtime.sessionId || null,
          fallbackMode: codexTransientFallbackMode ?? "fresh_session",
          continuationSummaryBody,
        })
      : "";
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      const notes = [repoAgentsNote];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    if (instructionsPrefix.length > 0) {
      if (shouldUseResumeDeltaPrompt) {
        const notes = [
          `Loaded agent instructions from ${instructionsFilePath}`,
          "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
          repoAgentsNote,
        ];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      const notes = [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    const notes = [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      repoAgentsNote,
    ];
    if (forceSaferInvocation) {
      notes.push("Codex transient fallback requested safer invocation settings for this retry.");
    }
    if (forceFreshSession) {
      notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
    }
    return notes;
  })();
  if (executionTargetIsSandbox) {
    commandNotes.push(
      "Added --skip-git-repo-check for sandbox execution because Codex requires an explicit trust bypass in headless remote workspaces.",
    );
  }
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    codexFallbackHandoffNote,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const execArgs = buildCodexExecArgs(
      forceSaferInvocation ? { ...config, fastMode: false } : config,
      {
        resumeSessionId,
        skipGitRepoCheck: executionTargetIsSandbox,
      },
    );
    const args = execArgs.args;
    const commandNotesWithFastMode =
      execArgs.fastModeIgnoredReason == null
        ? commandNotes
        : [...commandNotes, execArgs.fastModeIgnoredReason];
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const canFallbackToRuntimeSession = !isRetry && !forceFreshSession;
    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd: effectiveExecutionCwd,
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
    const transientRetryNotBefore =
      (attempt.proc.exitCode ?? 0) !== 0
        ? extractCodexRetryNotBefore({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
    const transientUpstream =
      (attempt.proc.exitCode ?? 0) !== 0 &&
      isCodexTransientUpstreamError({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        errorMessage: fallbackErrorMessage,
      });

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode:
        transientUpstream
          ? "codex_transient_upstream"
          : null,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    if (
      deliveryHookEnabled &&
      !executionTargetIsRemote &&
      (initial.proc.exitCode ?? 1) === 0 &&
      workspaceBranch
    ) {
      try {
        const delivery = await executeDeliveryHook({
          runId,
          worktreeCwd: cwd,
          branch: workspaceBranch,
          env: runtimeEnv,
          issueIdentifier: asString(context.issueIdentifier, "") || null,
          issueId: asString(context.issueId, "") || null,
          repo: asString(config.deliveryRepo, "Beyn-SOLIDUS/quantum"),
          baseBranch: asString(config.deliveryBaseBranch, "main"),
          runProc: async (c, a, wd, e) => {
            const p = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, c, a, {
              cwd: wd,
              env: e,
              timeoutSec: 120,
              graceSec: 10,
              onLog,
            });
            return { exitCode: p.exitCode ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
          },
          log: onLog,
        });
        await onLog(
          "stdout",
          `[paperclip] delivery: ${delivery.reason}${delivery.prUrl ? " -> " + delivery.prUrl : ""}\n`,
        );
      } catch (err) {
        await onLog("stderr", `[paperclip] delivery hook error (non-fatal): ${(err as Error).message}\n`);
      }
    }
    return toResult(initial, false, false);
  } finally {
    if (paperclipBridge) {
      await paperclipBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
