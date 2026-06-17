import fs from "node:fs/promises";
import path from "node:path";

export type DeliveryHookRunProcess = (
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type DeliveryHookLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export type DeliveryHookResult = {
  delivered: boolean;
  prUrl: string | null;
  reason: string;
};

export type ExecuteDeliveryHookInput = {
  runId: string;
  worktreeCwd: string;
  branch: string;
  env: Record<string, string>;
  issueIdentifier: string | null;
  issueId: string | null;
  repo: string;
  baseBranch: string;
  adapterType?: string | null;
  agentId?: string | null;
  model?: string | null;
  runProc: DeliveryHookRunProcess;
  log: DeliveryHookLog;
};

export type ExecuteConfiguredDeliveryHookInput = {
  runId: string;
  worktreeCwd: string;
  branch: string | null;
  env: Record<string, string>;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  executionTargetIsRemote: boolean;
  exitCode: number | null;
  adapterType?: string | null;
  agentId?: string | null;
  model?: string | null;
  runProc: DeliveryHookRunProcess;
  log: DeliveryHookLog;
};

type DeliveryQualityGateStep = "typecheck" | "lint" | "test" | "secret-scan";

type DeliveryQualityGateCommand = {
  step: DeliveryQualityGateStep;
  scriptName: string;
  cmd: string;
  args: string[];
};

type DeliveryQualityGateResult =
  | { ok: true; commands: DeliveryQualityGateCommand[] }
  | { ok: false; reason: string };

const DELIVERY_QUALITY_GATE_SCRIPTS: Record<DeliveryQualityGateStep, string[]> = {
  typecheck: ["typecheck", "check:types", "types"],
  lint: ["lint"],
  test: ["test", "test:run"],
  "secret-scan": ["secret-scan", "secrets:scan", "scan:secrets", "check:secrets", "check:tokens"],
};

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isAutonomousDeliveryEnabled(env: Record<string, string>): boolean {
  return (env.PAPERCLIP_AUTONOMOUS_DELIVERY ?? process.env.PAPERCLIP_AUTONOMOUS_DELIVERY ?? "0") === "1";
}

function readDeliveryBotToken(env: Record<string, string>): string | null {
  return nonEmpty(env.PAPERCLIP_DELIVERY_BOT_TOKEN ?? process.env.PAPERCLIP_DELIVERY_BOT_TOKEN);
}

const SECRET_ENV_KEY_RE = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH)(?:_|$)/i;
const QUALITY_GATE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
] as const;

function collectSecretValues(env: Record<string, string>): string[] {
  return Array.from(
    new Set(
      Object.entries(env)
        .filter(([key, value]) => SECRET_ENV_KEY_RE.test(key) && value.trim().length >= 4)
        .map(([, value]) => value.trim()),
    ),
  ).sort((a, b) => b.length - a.length);
}

function redactSecretValues(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

function readProcessEnvStrings(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function createDeliveryLogRedactor(env: Record<string, string>, log: DeliveryHookLog): DeliveryHookLog {
  const secrets = collectSecretValues({ ...readProcessEnvStrings(), ...env });
  if (secrets.length === 0) return log;
  return async (stream, chunk) => log(stream, redactSecretValues(chunk, secrets));
}

function readAllowedEnvValue(env: Record<string, string>, key: string): string | null {

  const value = env[key] ?? process.env[key];
  return typeof value === "string" ? value : null;
}

function buildQualityGateEnv(env: Record<string, string>): Record<string, string> {
  const gateEnv: Record<string, string> = {};
  for (const key of QUALITY_GATE_ENV_ALLOWLIST) {
    if (SECRET_ENV_KEY_RE.test(key)) continue;
    const value = key === "CI" ? env.CI ?? "true" : readAllowedEnvValue(env, key);
    if (value !== null) gateEnv[key] = value;
  }
  gateEnv.CI = gateEnv.CI ?? "true";
  return gateEnv;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function resolvePackageManager(worktreeCwd: string): Promise<string> {

  const [hasPnpmLock, hasYarnLock] = await Promise.all([
    pathExists(path.join(worktreeCwd, "pnpm-lock.yaml")),
    pathExists(path.join(worktreeCwd, "yarn.lock")),
  ]);
  if (hasPnpmLock) return "pnpm";
  if (hasYarnLock) return "yarn";
  return "npm";
}

async function readPackageScripts(worktreeCwd: string): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(worktreeCwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return null;
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === "string" && command.trim().length > 0) scripts[name] = command;
    }
    return scripts;
  } catch {
    return null;
  }
}

async function resolveDeliveryQualityGateCommands(worktreeCwd: string): Promise<DeliveryQualityGateResult> {
  const scripts = await readPackageScripts(worktreeCwd);
  if (!scripts) return { ok: false, reason: "missing_package_scripts" };

  const packageManager = await resolvePackageManager(worktreeCwd);
  const commands: DeliveryQualityGateCommand[] = [];
  for (const [step, candidates] of Object.entries(DELIVERY_QUALITY_GATE_SCRIPTS) as Array<[
    DeliveryQualityGateStep,
    string[],
  ]>) {
    const scriptName = candidates.find((candidate) => scripts[candidate]);
    if (!scriptName) return { ok: false, reason: `missing_${step}_script` };
    commands.push({ step, scriptName, cmd: packageManager, args: ["run", scriptName] });
  }

  return { ok: true, commands };
}

async function runDeliveryQualityGate(input: {
  worktreeCwd: string;
  env: Record<string, string>;
  runProc: DeliveryHookRunProcess;
  log: DeliveryHookLog;
  ts: () => string;
}): Promise<DeliveryQualityGateResult> {
  const resolved = await resolveDeliveryQualityGateCommands(input.worktreeCwd);
  if (!resolved.ok) return resolved;

  const gateEnv = buildQualityGateEnv(input.env);
  for (const command of resolved.commands) {
    await input.log(
      "stdout",
      `[delivery ${input.ts()}] quality gate ${command.step}: ${command.cmd} ${command.args.join(" ")}\n`,
    );
    const result = await input.runProc(command.cmd, command.args, input.worktreeCwd, gateEnv);
    if (result.exitCode !== 0) {
      const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `exit ${result.exitCode}`;
      return { ok: false, reason: `${command.step}_failed: ${detail}` };
    }
  }

  return resolved;
}

/**
 * Deterministic post-run delivery (quality gate -> commit -> push -> PR).
 *
 * No LLM decisions are made here. Delivery is fail-closed: if the quality gate
 * cannot be resolved or fails, no commit, no push and no PR creation happen.
 */
export async function executeDeliveryHook(input: ExecuteDeliveryHookInput): Promise<DeliveryHookResult> {
  const { worktreeCwd, branch, env, runProc } = input;
  const log = createDeliveryLogRedactor(env, input.log);

  const ts = () => new Date().toISOString();
  const autonomousDelivery = isAutonomousDeliveryEnabled(env);
  const lane = (env.PAPERCLIP_DELIVERY_LANE ?? process.env.PAPERCLIP_DELIVERY_LANE ?? "production").trim();
  const isDevTestLane = !autonomousDelivery && lane === "dev-test";
  const deliveryLabels = autonomousDelivery
    ? ["factory-proof", "bot-merge-ready"]
    : isDevTestLane
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

  const deliveryBotToken = autonomousDelivery ? readDeliveryBotToken(env) : null;
  if (autonomousDelivery && !deliveryBotToken) {
    await log("stderr", `[delivery ${ts()}] delivery_blocked: missing bot token\n`);
    return { delivered: false, prUrl: null, reason: "delivery_blocked: missing bot token" };
  }
  const deliveryCommandEnv = deliveryBotToken ? { ...env, GH_TOKEN: deliveryBotToken } : env;

  const title = `${input.issueIdentifier ?? "FACTORY"}: factory delivery`;
  const bodyHeader = [
    `Paperclip issue: ${input.issueIdentifier ?? "?"} (${input.issueId ?? "?"})`,
    `Run: ${input.runId}`,
    `Adapter: ${input.adapterType ?? "unknown"}`,
    `Agent: ${input.agentId ?? "unknown"}`,
    `Model: ${input.model ?? "unknown"}`,
    `Factory: sovereign delivery hook (deterministic, no LLM)`,
  ];
  const bodyGate = autonomousDelivery

    ? [
        ``,
        `Autonomous delivery enabled: quality gate passed before push; bot merge may proceed via allowlisted label.`,
      ]
    : isDevTestLane
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

  const qualityGate = await runDeliveryQualityGate({ worktreeCwd, env, runProc, log, ts });
  if (!qualityGate.ok) {
    await log("stderr", `[delivery ${ts()}] delivery_blocked: quality gate failed (${qualityGate.reason})\n`);
    return { delivered: false, prUrl: null, reason: "delivery_blocked" };
  }

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

  const push = await runProc("git", ["push", "-u", "origin", branch], worktreeCwd, deliveryCommandEnv);

  if (push.exitCode !== 0) {
    const s = (push.stderr || "").toLowerCase();
    const reason =
      s.includes("401") || s.includes("403") || s.includes("denied") ? "push_auth_failed" : "push_failed";

    await log("stderr", `[delivery ${ts()}] push ${reason}: ${push.stderr}\n`);
    return { delivered: false, prUrl: null, reason };
  }

  const existing = await runProc(
    "gh",
    ["pr", "list", "--repo", input.repo, "--head", branch, "--json", "url", "--jq", ".[0].url // empty"],
    worktreeCwd,
    deliveryCommandEnv,
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) {

    const existingUrl = existing.stdout.trim();
    let labelsToReconcile: string[] = [];
    const labelListReco = await runProc(
      "gh",
      ["label", "list", "--repo", input.repo, "--limit", "200", "--json", "name", "--jq", "[.[].name]"],
      worktreeCwd,
      deliveryCommandEnv,
    );
    if (labelListReco.exitCode === 0) {

      try {
        const existingLabels: string[] = JSON.parse(labelListReco.stdout || "[]");
        labelsToReconcile = deliveryLabels.filter((label) => existingLabels.includes(label));
      } catch (err) {
        await log("stderr", `[delivery ${ts()}] reco label parse failed: ${(err as Error).message}\n`);
      }
    }
    if (labelsToReconcile.length > 0) {
      const editArgs = ["pr", "edit", existingUrl];
      for (const label of labelsToReconcile) editArgs.push("--add-label", label);
      const lr = await runProc("gh", editArgs, worktreeCwd, deliveryCommandEnv);
      if (lr.exitCode !== 0) {
        await log("stderr", `[delivery ${ts()}] relabel existing PR failed (non-fatal): ${lr.stderr}\n`);

      }
    } else {
      await log("stderr", `[delivery ${ts()}] reco skipped (no labels exist in repo, Phase -1 not done?)\n`);
    }
    await log("stdout", `[delivery ${ts()}] PR already exists (idempotent): ${existingUrl}\n`);
    return { delivered: true, prUrl: existingUrl, reason: "pr_exists" };
  }

  let labelsToApply: string[] = [];
  const labelList = await runProc(
    "gh",
    ["label", "list", "--repo", input.repo, "--limit", "200", "--json", "name", "--jq", "[.[].name]"],
    worktreeCwd,
    deliveryCommandEnv,
  );
  if (labelList.exitCode === 0) {

    try {
      const existingNames: string[] = JSON.parse(labelList.stdout || "[]");
      labelsToApply = deliveryLabels.filter((label) => existingNames.includes(label));
      const missing = deliveryLabels.filter((label) => !existingNames.includes(label));
      if (missing.length) {
        await log("stderr", `[delivery ${ts()}] labels missing (Phase -1 not done?): ${missing.join(",")}\n`);
      }
    } catch (err) {
      await log("stderr", `[delivery ${ts()}] label parse failed: ${(err as Error).message}\n`);
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
  for (const label of labelsToApply) prArgs.push("--label", label);

  const pr = await runProc("gh", prArgs, worktreeCwd, deliveryCommandEnv);
  if (pr.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] gh pr create failed: ${pr.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "pr_create_failed" };
  }
  const url = (pr.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [null])[0];

  if (url && !autonomousDelivery) {
    const rev = await runProc("gh", ["pr", "edit", url, "--add-reviewer", "haykel1977"], worktreeCwd, env);
    if (rev.exitCode !== 0) {
      await log("stderr", `[delivery ${ts()}] add-reviewer failed (non-fatal): ${rev.stderr}\n`);
    }
  }
  await log("stdout", `[delivery ${ts()}] PR created: ${url}\n`);
  return { delivered: true, prUrl: url, reason: "created" };
}

export async function executeConfiguredDeliveryHook(
  input: ExecuteConfiguredDeliveryHookInput,
): Promise<DeliveryHookResult | null> {
  if (input.config.deliveryHookEnabled === false) return null;
  if (input.executionTargetIsRemote) return null;
  if ((input.exitCode ?? 1) !== 0) return null;
  const branch = input.branch?.trim();
  if (!branch) return null;

  const delivery = await executeDeliveryHook({
    runId: input.runId,
    worktreeCwd: input.worktreeCwd,
    branch,
    env: input.env,
    issueIdentifier: nonEmpty(input.context.issueIdentifier),
    issueId: nonEmpty(input.context.issueId),
    repo: asString(input.config.deliveryRepo, "Beyn-SOLIDUS/quantum"),
    baseBranch: asString(input.config.deliveryBaseBranch, "main"),
    adapterType: nonEmpty(input.adapterType) ?? nonEmpty(input.context.adapterType),
    agentId: nonEmpty(input.agentId) ?? nonEmpty(input.context.agentId),
    model: nonEmpty(input.model) ?? nonEmpty(input.context.model) ?? nonEmpty(input.config.model),
    runProc: input.runProc,
    log: input.log,
  });
  const log = createDeliveryLogRedactor(input.env, input.log);
  await log(
    "stdout",
    `[paperclip] delivery: ${delivery.reason}${delivery.prUrl ? " -> " + delivery.prUrl : ""}\n`,
  );
  return delivery;
}
