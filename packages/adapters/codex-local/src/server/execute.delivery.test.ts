import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeConfiguredDeliveryHook } from "@paperclipai/adapter-utils/delivery-hook";
import { executeDeliveryHook } from "./execute.js";

const tmpDirs: string[] = [];

function mkWorktree() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-delivery-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        test: "vitest run",
        "check:tokens": "secret scan",
      },
    }),
    "utf8",
  );
  return dir;
}

function mkRunProc(seq: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const m = seq[key] ?? seq[`${cmd} ${args[0] ?? ""}`] ?? { exitCode: 0, stdout: "" };
    return { exitCode: m.exitCode, stdout: m.stdout ?? "", stderr: m.stderr ?? "" };
  });
}

const base = {
  runId: "r1",
  branch: "codex/HAS-222-x",
  env: {},
  issueIdentifier: "HAS-222",
  issueId: "uuid",
  repo: "Beyn-SOLIDUS/quantum",
  baseBranch: "main",
  adapterType: "codex_local",
  agentId: "agent-1",
  model: "sovereign-gpt-5",
  log: vi.fn(async () => {}),
};

describe("executeDeliveryHook", () => {

  const savedLane = process.env.PAPERCLIP_DELIVERY_LANE;
  const savedAutonomous = process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
  const savedBotToken = process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
  const savedRemoteDelivery = process.env.PAPERCLIP_DELIVERY_REMOTE_ENABLED;

  beforeEach(() => {
    delete process.env.PAPERCLIP_DELIVERY_LANE;
    delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
    delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
    delete process.env.PAPERCLIP_DELIVERY_REMOTE_ENABLED;
  });

  afterEach(() => {
    if (savedLane === undefined) delete process.env.PAPERCLIP_DELIVERY_LANE;
    else process.env.PAPERCLIP_DELIVERY_LANE = savedLane;
    if (savedAutonomous === undefined) delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
    else process.env.PAPERCLIP_AUTONOMOUS_DELIVERY = savedAutonomous;
    if (savedBotToken === undefined) delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
    else process.env.PAPERCLIP_DELIVERY_BOT_TOKEN = savedBotToken;
    if (savedRemoteDelivery === undefined) delete process.env.PAPERCLIP_DELIVERY_REMOTE_ENABLED;
    else process.env.PAPERCLIP_DELIVERY_REMOTE_ENABLED = savedRemoteDelivery;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("diff present -> commit + gate + push + PR", async () => {
    const worktreeCwd = mkWorktree();
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M HEARTBEAT.md\n" },
      "git push -u": { exitCode: 0 }, // paperclip:allow-git-push: test mock for delivery-hook push (PAPA-432)
      "gh pr list": { exitCode: 0, stdout: "" },
      "gh label list": { exitCode: 0, stdout: "[]" },
      "gh pr create": { exitCode: 0, stdout: "" },
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("created");
    expect(runProc).toHaveBeenCalledWith("pnpm", ["run", "typecheck"], worktreeCwd, expect.objectContaining({ CI: "true" }));
    expect(runProc).toHaveBeenCalledWith("git", ["push", "-u", "origin", base.branch], worktreeCwd, expect.any(Object)); // paperclip:allow-git-push: assertion verifying delivery-hook push call (PAPA-432)
  });

  it("no diff -> silent skip, no commit", async () => {
    const worktreeCwd = mkWorktree();
    const runProc = mkRunProc({ "git status --porcelain": { exitCode: 0, stdout: "" } });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("no_diff");
    expect(runProc).toHaveBeenCalledTimes(1);
  });

  it("gate rouge -> delivery_blocked et aucun push", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "pnpm run lint") return { exitCode: 1, stdout: "", stderr: "lint failed" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("delivery_blocked");
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
  });

  it("quality gate receives a minimal env without tokens or keys", async () => {
    const worktreeCwd = mkWorktree();
    const envCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const runProc = vi.fn(async (cmd: string, args: string[], _cwd: string, callEnv: Record<string, string>) => {
      envCalls.push({ cmd, args, env: callEnv });
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: {
        PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token",
        GH_TOKEN: "personal-token",
        OPENAI_API_KEY: "openai-token",
        PAPERCLIP_API_KEY: "paperclip-token",
      },
      runProc,
    });
    const gateEnv = envCalls.find((call) => call.cmd === "pnpm" && call.args[1] === "typecheck")?.env;
    expect(gateEnv?.CI).toBe("true");
    expect(gateEnv?.PAPERCLIP_DELIVERY_BOT_TOKEN).toBeUndefined();
    expect(gateEnv?.GH_TOKEN).toBeUndefined();
    expect(gateEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(gateEnv?.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("flag OFF -> human-gate-required et reviewer humain", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(["factory-proof", "human-gate-required", "bot-merge-ready"]), stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/44\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toContain("human-gate-required");
    expect(createCall).not.toContain("bot-merge-ready");
    const bodyIndex = createCall?.indexOf("--body") ?? -1;
    const body = bodyIndex >= 0 ? createCall?.[bodyIndex + 1] ?? "" : "";
    expect(body).toContain("Adapter: codex_local");
    expect(body).toContain("Agent: agent-1");
    expect(body).toContain("Model: sovereign-gpt-5");
    expect(body).toContain("## Supply Chain Attestation");
    expect(body).toContain("## Plan de rollback");
    expect(calls.find((call) => call.includes("--add-reviewer"))).toContain("haykel1977");
  });

  it("flag ON + bot token absent -> delivery_blocked et aucun push", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1" }, runProc });
    expect(result.reason).toBe("delivery_blocked: missing bot token");
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("flag ON + gate vert -> PR Quantum truth-first avec token bot et commit signé", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const envCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const runProc = vi.fn(async (cmd: string, args: string[], _cwd: string, callEnv: Record<string, string>) => {
      calls.push([cmd, ...args]);
      envCalls.push({ cmd, args, env: callEnv });
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "git log -1") return { exitCode: 0, stdout: "G\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(["factory-proof", "agent-pr", "truth-first", "bot-merge-ready", "prod-gate-required"]),
          stderr: "",
        };
      }
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/45\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: {
        PAPERCLIP_AUTONOMOUS_DELIVERY: "1",
        PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token",
        PAPERCLIP_DELIVERY_SIGN_COMMITS: "1",
        GH_TOKEN: "personal-token",
      },
      runProc,
    });
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toBeDefined();
    expect(createCall).toContain("agent-pr");
    expect(createCall).toContain("truth-first");
    expect(createCall).toContain("bot-merge-ready");
    expect(createCall).toContain("prod-gate-required");
    expect(createCall).not.toContain("human-gate-required");
    const bodyIndex = createCall?.indexOf("--body") ?? -1;
    const body = bodyIndex >= 0 ? createCall?.[bodyIndex + 1] ?? "" : "";
    expect(body).toContain("## Description");
    expect(body).toContain("ADR: ADR-GOV-007");
    expect(body).toContain("TRUTHFULNESS: BACKEND-WIRED");
    expect(body).toContain("## Truthfulness Boundary");
    expect(body).toContain("| Claim | Evidence | Boundary |");
    expect(body).toContain("## Quality Gate Evidence");
    expect(body).toContain("## Type de changement");
    expect(body).toContain("VERIFIED: autonomous delivery requires a signed git commit before push");
    expect(body).toContain("## Sécurité");
    expect(body).toContain("## Dev/test merge policy");
    expect(body).toContain("`pnpm run typecheck`");
    expect(body).toContain("- `f`");
    expect(calls).toContainEqual(expect.arrayContaining(["git", "commit", "-S"]));
    expect(calls).toContainEqual(["git", "log", "-1", "--format=%G?"]);
    expect(calls.some((call) => call.includes("--add-reviewer"))).toBe(false);
    const pushEnv = envCalls.find((call) => call.cmd === "git" && call.args[0] === "push")?.env;
    expect(pushEnv?.GH_TOKEN).toBe("bot-token");
    const ghEnvs = envCalls.filter((call) => call.cmd === "gh").map((call) => call.env.GH_TOKEN);
    expect(ghEnvs.length).toBeGreaterThan(0);
    expect(ghEnvs.every((token) => token === "bot-token")).toBe(true);
    const gateEnv = envCalls.find((call) => call.cmd === "pnpm" && call.args[1] === "typecheck")?.env;
    expect(gateEnv?.GH_TOKEN).toBeUndefined();
    expect(gateEnv?.PAPERCLIP_DELIVERY_BOT_TOKEN).toBeUndefined();
  });

  it("autonomous delivery blocks before commit when signing is not configured", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1", PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token" },
      runProc,
    });

    expect(result.reason).toBe("delivery_blocked: signed commits not configured");
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
  });

  it("autonomous delivery blocks after commit when the commit is unsigned", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "git log -1") return { exitCode: 0, stdout: "N\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: {
        PAPERCLIP_AUTONOMOUS_DELIVERY: "1",
        PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token",
        PAPERCLIP_DELIVERY_SIGN_COMMITS: "1",
      },
      runProc,
    });

    expect(result.reason).toBe("delivery_blocked: unsigned commit");
    expect(calls).toContainEqual(expect.arrayContaining(["git", "commit", "-S"]));
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
  });

  it("autonomous delivery blocks bad signature statuses instead of treating every non-N status as signed", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "git log -1") return { exitCode: 0, stdout: "B\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: {
        PAPERCLIP_AUTONOMOUS_DELIVERY: "1",
        PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token",
        PAPERCLIP_DELIVERY_SIGN_COMMITS: "1",
      },
      runProc,
    });

    expect(result.reason).toBe("delivery_blocked: unsigned commit");
    expect(calls).toContainEqual(expect.arrayContaining(["git", "commit", "-S"]));
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
  });

  it("configured delivery reports remote skip unless remote delivery is explicitly enabled", async () => {
    const worktreeCwd = mkWorktree();
    const log = vi.fn(async () => {});
    const runProc = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const result = await executeConfiguredDeliveryHook({
      ...base,
      worktreeCwd,
      branch: base.branch,
      config: {},
      context: {},
      executionTargetIsRemote: true,
      exitCode: 0,
      runProc,
      log,
    });

    expect(result).toBeNull();
    expect(runProc).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("stdout", "[paperclip] delivery: skipped reason=remote_delivery_not_enabled\n");
  });

  it("dev-test lane keeps existing no-human lane labels when autonomous flag is off", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(["factory-proof", "human-gate-required", "agent-pr", "automated", "truth-first"]), stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/46\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await executeDeliveryHook({ ...base, worktreeCwd, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc });
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toContain("agent-pr");
    expect(createCall).toContain("automated");
    expect(createCall).toContain("truth-first");
    expect(createCall).not.toContain("human-gate-required");
    expect(calls.some((call) => call.includes("--add-reviewer"))).toBe(false);
  });

  it("idempotency: PR existante detectee avant commit -> aucun commit, aucun push", async () => {

    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      // PR already exists — return URL on first pr list call
      if (key === "gh pr list") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/99\n", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(["factory-proof", "human-gate-required"]), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("pr_exists");
    expect(result.prUrl).toBe("https://github.com/Beyn-SOLIDUS/quantum/pull/99");
    expect(result.delivered).toBe(true);
    // Must NOT have committed or pushed
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
    // Must NOT have run quality gate
    expect(calls.some((call) => call[0] === "pnpm")).toBe(false);
  });

  it("push retry: transient 429 -> retries once, succeeds on second attempt", async () => {
    const worktreeCwd = mkWorktree();
    let pushAttempts = 0;
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "push") {
        pushAttempts++;
        if (pushAttempts === 1) return { exitCode: 1, stdout: "", stderr: "error: 429 Too Many Requests — timeout" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("created");
    expect(pushAttempts).toBe(2);
  }, 10000); // allow retry delay

  it("push auth failure (403): no retry, returns push_auth_failed", async () => {
    const worktreeCwd = mkWorktree();
    let pushAttempts = 0;
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "push") {
        pushAttempts++;
        return { exitCode: 1, stdout: "", stderr: "error: 403 Forbidden — access denied" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("push_auth_failed");
    expect(pushAttempts).toBe(1); // no retry on auth failure
  });
});
