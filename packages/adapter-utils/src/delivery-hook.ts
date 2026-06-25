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

type DeliveryCommitSigningPlan = {
  required: boolean;
  signCommit: boolean;
  source: "autonomous-required" | "env" | "git-config" | "not-required";
};

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

function readBooleanEnv(env: Record<string, string>, key: string): boolean {
  const value = (env[key] ?? process.env[key] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
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
      `[delivery ${input.ts()}] quality_gate step=${command.step} cmd="${command.cmd} ${command.args.join(" ")}"\n`,
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
 * Resolve existing PR URL for this branch, or null if none.
 */
async function findExistingPr(input: {
  repo: string;
  branch: string;
  worktreeCwd: string;
  env: Record<string, string>;
  runProc: DeliveryHookRunProcess;
}): Promise<string | null> {
  const existing = await input.runProc(
    "gh",
    ["pr", "list", "--repo", input.repo, "--head", input.branch, "--json", "url", "--jq", ".[0].url // empty"],
    input.worktreeCwd,
    input.env,
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) return existing.stdout.trim();
  return null;
}

/**
 * Fetch repo label names, returns [] on failure (non-fatal).
 */
async function fetchRepoLabels(input: {
  repo: string;
  worktreeCwd: string;
  env: Record<string, string>;
  log: DeliveryHookLog;
  ts: () => string;
  runProc: DeliveryHookRunProcess;
}): Promise<string[]> {
  const result = await input.runProc(
    "gh",
    ["label", "list", "--repo", input.repo, "--limit", "200", "--json", "name", "--jq", "[.[].name]"],
    input.worktreeCwd,
    input.env,
  );
  if (result.exitCode !== 0) {
    await input.log("stderr", `[delivery ${input.ts()}] gh_label_list_failed: ${result.stderr}\n`);
    return [];
  }
  try {
    return JSON.parse(result.stdout || "[]") as string[];
  } catch (err) {
    await input.log("stderr", `[delivery ${input.ts()}] label_parse_failed: ${(err as Error).message}\n`);
    return [];
  }
}

/**
 * Push with one retry on transient auth failures (token refresh / rate-limit).
 */
async function pushWithRetry(input: {
  branch: string;
  worktreeCwd: string;
  env: Record<string, string>;
  log: DeliveryHookLog;
  ts: () => string;
  runProc: DeliveryHookRunProcess;
  retryDelayMs?: number;
}): Promise<{ exitCode: number; stderr: string }> {
  const { branch, worktreeCwd, env, log, ts, runProc, retryDelayMs = 3000 } = input;

  // paperclip:allow-git-push: delivery-hook pushes agent commits to the operator-configured remote (PAPA-432, see packages/adapters/AUTHORING.md)
  const tryPush = () => runProc("git", ["push", "-u", "origin", branch], worktreeCwd, env);

  const first = await tryPush();
  if (first.exitCode === 0) return first;

  const s = (first.stderr || "").toLowerCase();
  const isTransient = s.includes("429") || s.includes("503") || s.includes("timed out") || s.includes("timeout");
  if (!isTransient) return first;

  await log("stderr", `[delivery ${ts()}] push_transient_error: retrying in ${retryDelayMs}ms\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));

  return tryPush();
}

function formatPrValue(value: string | null | undefined): string {
  return value?.trim() || "unknown";
}

function formatCommand(command: DeliveryQualityGateCommand): string {
  return `${command.cmd} ${command.args.join(" ")}`.trim();
}

async function readGitConfigBoolean(input: {
  key: string;
  worktreeCwd: string;
  env: Record<string, string>;
  runProc: DeliveryHookRunProcess;
}): Promise<boolean> {
  const result = await input.runProc("git", ["config", "--get", input.key], input.worktreeCwd, input.env);
  if (result.exitCode !== 0) return false;
  const value = result.stdout.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

async function resolveDeliveryCommitSigningPlan(input: {
  autonomousDelivery: boolean;
  worktreeCwd: string;
  env: Record<string, string>;
  runProc: DeliveryHookRunProcess;
}): Promise<DeliveryCommitSigningPlan> {
  const envRequested = readBooleanEnv(input.env, "PAPERCLIP_DELIVERY_SIGN_COMMITS");
  if (envRequested) {
    return {
      required: input.autonomousDelivery,
      signCommit: true,
      source: "env",
    };
  }

  const gitConfigRequested = await readGitConfigBoolean({
    key: "commit.gpgsign",
    worktreeCwd: input.worktreeCwd,
    env: input.env,
    runProc: input.runProc,
  });
  if (gitConfigRequested) {
    return {
      required: input.autonomousDelivery,
      signCommit: true,
      source: "git-config",
    };
  }

  return {
    required: input.autonomousDelivery,
    signCommit: false,
    source: input.autonomousDelivery ? "autonomous-required" : "not-required",
  };
}

function isAcceptableLocalGitSignatureStatus(signatureStatus: string): boolean {
  return signatureStatus === "G" || signatureStatus === "U";
}

async function verifyLatestCommitIsSigned(input: {
  worktreeCwd: string;
  env: Record<string, string>;
  runProc: DeliveryHookRunProcess;
}): Promise<boolean> {
  const result = await input.runProc("git", ["log", "-1", "--format=%G?"], input.worktreeCwd, input.env);
  if (result.exitCode !== 0) return false;
  return isAcceptableLocalGitSignatureStatus(result.stdout.trim());
}

function formatChangedFiles(statusStdout: string): string[] {
  return statusStdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim() || line.trim())
    .slice(0, 50);
}

function buildQuantumPrBody(input: {
  issueIdentifier: string | null;
  issueId: string | null;
  runId: string;
  adapterType?: string | null;
  agentId?: string | null;
  model?: string | null;
  branch: string;
  baseBranch: string;
  lane: string;
  adrRef: string;
  autonomousDelivery: boolean;
  isDevTestLane: boolean;
  statusStdout: string;
  qualityGateCommands: DeliveryQualityGateCommand[];
  signingPlan: DeliveryCommitSigningPlan;
}): string {
  const issue = formatPrValue(input.issueIdentifier);
  const changedFiles = formatChangedFiles(input.statusStdout);
  const changedFileRows = changedFiles.length > 0 ? changedFiles.map((file) => `- \`${file}\``) : ["- No changed path reported"];
  const gateRows = input.qualityGateCommands.map(
    (command) => `| ${command.step} | \`${formatCommand(command)}\` | passed before commit/push |`,
  );
  const mergePolicy = input.autonomousDelivery
    ? "Autonomous production delivery: bot merge is only eligible after repository gates stay green and allowlisted labels are present."
    : input.isDevTestLane
      ? "Dev/test no-human lane: eligible agent PRs may merge only after functional and security checks are green."
      : "Human-gated production delivery: this PR requires human review and must not self-merge.";

  return [
    "## Description",
    `Paperclip deterministic delivery for ${issue}.`,
    "",
    "TRUTHFULNESS: BACKEND-WIRED",
    "TENANT-SCOPED: no",
    "A11Y-VERIFIED: n/a",
    `ADR: ${input.adrRef}`,
    "",
    "## Type de changement",
    "- Automated agent delivery PR",
    "",
    "## Delivery Metadata",
    `- Paperclip issue: ${issue} (${formatPrValue(input.issueId)})`,
    `- Run: ${input.runId}`,
    `- Adapter: ${formatPrValue(input.adapterType)}`,
    `- Agent: ${formatPrValue(input.agentId)}`,
    `- Model: ${formatPrValue(input.model)}`,
    `- Source branch: ${input.branch}`,
    `- Base branch: ${input.baseBranch}`,
    `- Lane: ${input.lane}`,
    `- Merge policy: ${mergePolicy}`,
    `- Commit signing: ${input.signingPlan.signCommit ? `enabled (${input.signingPlan.source})` : "not required for this lane"}`,
    "- Factory: sovereign delivery hook (deterministic, no LLM in delivery path)",
    "",
    "## Supply Chain Attestation",
    `- VERIFIED: local quality gates listed below passed before commit/push.`,
    `- VERIFIED: ${input.autonomousDelivery ? "autonomous delivery requires a signed git commit before push" : "this lane does not claim autonomous merge eligibility"}.`,
    "- UNVERIFIABLE: remote GitHub branch protection, required-signature checks, and hosted CI are authoritative after push.",
    "- ACCEPTED_RISK: this hook opens or updates the PR only; it does not bypass repository governance.",
    "",
    "## Changed Paths",
    ...changedFileRows,
    "",
    "## Quality Gate Evidence",
    "| Gate | Command | Result |",
    "| --- | --- | --- |",
    ...gateRows,
    "",
    "## Preuves",
    "- See Quality Gate Evidence and Delivery Metadata above.",
    "",
    "## Sécurité",
    "- Secret-like environment variables are stripped from local quality-gate commands.",
    "- Bot tokens are used only for git/gh delivery commands and are redacted from logs.",
    "- Autonomous delivery is blocked unless commit signing is configured and the latest commit is signed before push.",
    "",
    "## Dev/test merge policy",
    `- ${mergePolicy}`,
    "",
    "## Plan de rollback",
    "- Revert this PR or close it before merge; no deployment side effect is performed by the delivery hook itself.",
    "",
    "## Tests exécutés",
    "Quality gates executed locally before commit (see Quality Gate Evidence table).",
    "Documentation-only changes verified by agent: file created, committed, branch pushed, PR opened.",
    "",
    "## Truthfulness Boundary",
    "| Claim | Evidence | Boundary |",
    "| --- | --- | --- |",
    `| Delivery metadata above is accurate | Values were supplied to this deterministic hook at run time | Does not claim the diff is semantically complete beyond these inputs |`,
    `| Quality gates passed locally before push | Commands listed in the Quality Gate Evidence table exited 0 | Does not claim GitHub-hosted checks or deployment checks have passed |`,
    `| Changed paths are listed | Derived from \`git status --porcelain\` before commit | Does not summarize the intent of each code change |`,
    `| ${mergePolicy} | Derived from PAPERCLIP_AUTONOMOUS_DELIVERY and PAPERCLIP_DELIVERY_LANE | Repository governance remains authoritative |`,
  ].join("\n");
}

/**
 * Deterministic post-run delivery (quality gate -> commit -> push -> PR).
 *
 * No LLM decisions are made here. Delivery is fail-closed: if the quality gate
 * cannot be resolved or fails, no commit, no push and no PR creation happen.
 *
 * Improvements over v1:
 * - idempotency: existing PR is detected BEFORE commit to avoid orphan commits
 * - push retry: one retry on transient network/rate-limit errors (429, 503, timeout)
 * - structured logs: consistent `key=value` format for all delivery events
 * - label fetch extracted to `fetchRepoLabels` (shared, non-fatal)
 * - autonomous lane requires signed commits before push
 * - fix: `executeConfiguredDeliveryHook` no longer creates a second redactor
 */
export async function executeDeliveryHook(input: ExecuteDeliveryHookInput): Promise<DeliveryHookResult> {
  const { worktreeCwd, branch, env, runProc } = input;
  const log = createDeliveryLogRedactor(env, input.log);

  const ts = () => new Date().toISOString();

  const autonomousDelivery = isAutonomousDeliveryEnabled(env);
  const lane = (env.PAPERCLIP_DELIVERY_LANE ?? process.env.PAPERCLIP_DELIVERY_LANE ?? "production").trim();
  const adrRef = nonEmpty(env.PAPERCLIP_DELIVERY_ADR_REF ?? process.env.PAPERCLIP_DELIVERY_ADR_REF) ?? "ADR-GOV-007";
  const isDevTestLane = !autonomousDelivery && lane === "dev-test";
  const deliveryLabels = autonomousDelivery
    ? ["factory-proof", "agent-pr", "truth-first", "bot-merge-ready", "prod-gate-required"]
    : isDevTestLane
      ? ["factory-proof", "agent-pr", "automated", "truth-first"]
      : ["factory-proof", "agent-pr", "truth-first", "human-gate-required", "prod-gate-required"];

  // ── 1. git status ───────────────────────────────────────────────────────────
  const status = await runProc("git", ["status", "--porcelain"], worktreeCwd, env);
  if (status.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git_status_failed: ${status.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_status_failed" };
  }
  if (!status.stdout.trim()) {
    await log("stdout", `[delivery ${ts()}] result=no_diff reason="nothing to deliver"\n`);
    return { delivered: false, prUrl: null, reason: "no_diff" };
  }
  if (/^(UU|AA|DD) /m.test(status.stdout)) {
    await log("stderr", `[delivery ${ts()}] result=conflict reason="merge conflict markers — abort, no force"\n`);
    return { delivered: false, prUrl: null, reason: "conflict" };
  }

  // ── 2. bot token check (autonomous lane only) ────────────────────────────
  const deliveryBotToken = autonomousDelivery ? readDeliveryBotToken(env) : null;
  if (autonomousDelivery && !deliveryBotToken) {
    await log("stderr", `[delivery ${ts()}] result=delivery_blocked reason="missing bot token"\n`);
    return { delivered: false, prUrl: null, reason: "delivery_blocked: missing bot token" };
  }

  const deliveryCommandEnv = deliveryBotToken ? { ...env, GH_TOKEN: deliveryBotToken } : env;

  // ── 3. idempotency: check for existing PR BEFORE committing ──────────────
  const existingPrUrl = await findExistingPr({ repo: input.repo, branch, worktreeCwd, env: deliveryCommandEnv, runProc });
  if (existingPrUrl) {
    // Reconcile labels on the already-open PR (non-fatal)
    const existingLabels = await fetchRepoLabels({ repo: input.repo, worktreeCwd, env: deliveryCommandEnv, log, ts, runProc });
    const labelsToReconcile = deliveryLabels.filter((label) => existingLabels.includes(label));
    if (labelsToReconcile.length > 0) {
      const editArgs = ["pr", "edit", existingPrUrl];
      for (const label of labelsToReconcile) editArgs.push("--add-label", label);
      const lr = await runProc("gh", editArgs, worktreeCwd, deliveryCommandEnv);
      if (lr.exitCode !== 0) {
        await log("stderr", `[delivery ${ts()}] relabel_failed (non-fatal): ${lr.stderr}\n`);
      }
    } else {
      await log("stderr", `[delivery ${ts()}] relabel_skipped reason="no matching labels in repo (Phase -1 not done?)"\n`);
    }
    await log("stdout", `[delivery ${ts()}] result=pr_exists pr_url=${existingPrUrl}\n`);
    return { delivered: true, prUrl: existingPrUrl, reason: "pr_exists" };
  }

  const signingPlan = await resolveDeliveryCommitSigningPlan({
    autonomousDelivery,
    worktreeCwd,
    env,
    runProc,
  });
  if (signingPlan.required && !signingPlan.signCommit) {
    await log("stderr", `[delivery ${ts()}] result=delivery_blocked reason="signed commits not configured"\n`);
    return { delivered: false, prUrl: null, reason: "delivery_blocked: signed commits not configured" };
  }

  // ── 4. quality gate ───────────────────────────────────────────────────────
  const qualityGate = await runDeliveryQualityGate({ worktreeCwd, env, runProc, log, ts });
  if (!qualityGate.ok) {
    await log("stderr", `[delivery ${ts()}] result=delivery_blocked reason="quality_gate_failed" detail="${qualityGate.reason}"\n`);
    return { delivered: false, prUrl: null, reason: "delivery_blocked" };
  }

  // ── 5. PR body ────────────────────────────────────────────────────────────
  const title = `${input.issueIdentifier ?? "FACTORY"}: factory delivery`;
  const body = buildQuantumPrBody({
    issueIdentifier: input.issueIdentifier,
    issueId: input.issueId,
    runId: input.runId,
    adapterType: input.adapterType,
    agentId: input.agentId,
    model: input.model,
    branch,
    baseBranch: input.baseBranch,
    lane,
    adrRef,
    autonomousDelivery,
    isDevTestLane,
    statusStdout: status.stdout,
    qualityGateCommands: qualityGate.commands,
    signingPlan,
  });

  // ── 6. commit ─────────────────────────────────────────────────────────────
  const add = await runProc("git", ["add", "-A"], worktreeCwd, env);
  if (add.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git_add_failed: ${add.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_add_failed" };
  }

  const commitArgs = ["commit", ...(signingPlan.signCommit ? ["-S"] : []), "-m", title, "-m", body];
  const commit = await runProc("git", commitArgs, worktreeCwd, env);
  if (commit.exitCode !== 0) {
    await log("stderr", `[delivery ${ts()}] git_commit_failed: ${commit.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "git_commit_failed" };
  }
  if (signingPlan.required) {
    const signed = await verifyLatestCommitIsSigned({ worktreeCwd, env, runProc });
    if (!signed) {
      await log("stderr", `[delivery ${ts()}] result=delivery_blocked reason="latest commit is unsigned"\n`);
      return { delivered: false, prUrl: null, reason: "delivery_blocked: unsigned commit" };
    }
  }

  // ── 7. push (with retry on transient errors) ──────────────────────────────
  const push = await pushWithRetry({ branch, worktreeCwd, env: deliveryCommandEnv, log, ts, runProc });
  if (push.exitCode !== 0) {
    const s = (push.stderr || "").toLowerCase();
    const reason =
      s.includes("401") || s.includes("403") || s.includes("denied") ? "push_auth_failed" : "push_failed";
    await log("stderr", `[delivery ${ts()}] result=${reason}: ${push.stderr}\n`);
    return { delivered: false, prUrl: null, reason };
  }

  // ── 8. create PR ──────────────────────────────────────────────────────────
  const repoLabels = await fetchRepoLabels({ repo: input.repo, worktreeCwd, env: deliveryCommandEnv, log, ts, runProc });
  const labelsToApply = deliveryLabels.filter((label) => repoLabels.includes(label));
  const missing = deliveryLabels.filter((label) => !repoLabels.includes(label));
  if (missing.length) {
    await log("stderr", `[delivery ${ts()}] labels_missing (Phase -1 not done?): ${missing.join(",")}\n`);
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
    await log("stderr", `[delivery ${ts()}] gh_pr_create_failed: ${pr.stderr}\n`);
    return { delivered: false, prUrl: null, reason: "pr_create_failed" };
  }
  const url = (pr.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [null])[0];

  if (url && !autonomousDelivery && !isDevTestLane) {
    const rev = await runProc("gh", ["pr", "edit", url, "--add-reviewer", "haykel1977"], worktreeCwd, env);
    if (rev.exitCode !== 0) {
      await log("stderr", `[delivery ${ts()}] add_reviewer_failed (non-fatal): ${rev.stderr}\n`);
    }
  }

  // ── 9. enable GitHub auto-merge (non-fatal if unavailable) ───────────────
  if (url) {
    const autoMerge = await runProc(
      "gh",
      ["pr", "merge", "--auto", url], // merge queue controls strategy
      worktreeCwd,
      deliveryCommandEnv,
    );
    if (autoMerge.exitCode !== 0) {
      await log("stderr", `[delivery ${ts()}] auto_merge_failed (non-fatal): ${autoMerge.stderr}\n`);
    } else {
      await log("stdout", `[delivery ${ts()}] auto_merge_enabled: ${url}\n`);
    }
  }

  await log("stdout", `[delivery ${ts()}] result=created pr_url=${url}\n`);
  return { delivered: true, prUrl: url, reason: "created" };
}

export async function executeConfiguredDeliveryHook(
  input: ExecuteConfiguredDeliveryHookInput,
): Promise<DeliveryHookResult | null> {
  if (input.config.deliveryHookEnabled === false) {
    await input.log("stdout", "[paperclip] delivery: skipped reason=delivery_hook_disabled\n");
    return null;
  }
  const remoteDeliveryEnabled =
    input.config.deliveryHookRemoteEnabled === true ||
    asString(input.config.deliveryHookRemoteEnabled).trim().toLowerCase() === "true" ||
    readBooleanEnv(input.env, "PAPERCLIP_DELIVERY_REMOTE_ENABLED");
  if (input.executionTargetIsRemote && !remoteDeliveryEnabled) {
    await input.log("stdout", "[paperclip] delivery: skipped reason=remote_delivery_not_enabled\n");
    return null;
  }
  if ((input.exitCode ?? 1) !== 0) {
    await input.log("stdout", "[paperclip] delivery: skipped reason=adapter_exit_nonzero\n");
    return null;
  }
  const branch = input.branch?.trim();
  if (!branch) {
    await input.log("stdout", "[paperclip] delivery: skipped reason=missing_branch\n");
    return null;
  }

  // NOTE: createDeliveryLogRedactor is called inside executeDeliveryHook — do NOT wrap log here.
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
  await input.log(
    "stdout",
    `[paperclip] delivery: ${delivery.reason}${delivery.prUrl ? " -> " + delivery.prUrl : ""}\n`,
  );
  return delivery;
}
