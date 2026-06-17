import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  log: vi.fn(async () => {}),
};

describe("executeDeliveryHook", () => {
  const savedLane = process.env.PAPERCLIP_DELIVERY_LANE;
  const savedAutonomous = process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
  const savedBotToken = process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;

  beforeEach(() => {
    delete process.env.PAPERCLIP_DELIVERY_LANE;
    delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
    delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedLane === undefined) delete process.env.PAPERCLIP_DELIVERY_LANE;
    else process.env.PAPERCLIP_DELIVERY_LANE = savedLane;
    if (savedAutonomous === undefined) delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
    else process.env.PAPERCLIP_AUTONOMOUS_DELIVERY = savedAutonomous;
    if (savedBotToken === undefined) delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
    else process.env.PAPERCLIP_DELIVERY_BOT_TOKEN = savedBotToken;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("diff present -> commit + gate + push + PR", async () => {
    const worktreeCwd = mkWorktree();
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M HEARTBEAT.md\n" },
      "git push -u": { exitCode: 0 },
      "gh pr list": { exitCode: 0, stdout: "" },
      "gh label list": { exitCode: 0, stdout: "[]" },
      "gh pr create": { exitCode: 0, stdout: "" },
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("created");
    expect(runProc).toHaveBeenCalledWith("pnpm", ["run", "typecheck"], worktreeCwd, expect.objectContaining({ CI: "true" }));
    expect(runProc).toHaveBeenCalledWith("git", ["push", "-u", "origin", base.branch], worktreeCwd, expect.any(Object));
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
      if (key === "pnpm run lint") return { exitCode: 1, stdout: "", stderr: "lint failed" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("delivery_blocked");
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
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
    expect(calls.some((call) => call[0] === "git" && call[1] === "add")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
    expect(calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("flag ON + gate vert -> bot-merge-ready sans reviewer humain", async () => {

    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const envCalls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const runProc = vi.fn(async (cmd: string, args: string[], _cwd: string, callEnv: Record<string, string>) => {
      calls.push([cmd, ...args]);
      envCalls.push({ cmd, args, env: callEnv });
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(["factory-proof", "human-gate-required", "bot-merge-ready"]), stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/45\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await executeDeliveryHook({
      ...base,
      worktreeCwd,
      env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1", PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token", GH_TOKEN: "personal-token" },
      runProc,
    });
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toContain("bot-merge-ready");
    expect(createCall).not.toContain("human-gate-required");
    expect(calls.some((call) => call.includes("--add-reviewer"))).toBe(false);
    const pushEnv = envCalls.find((call) => call.cmd === "git" && call.args[0] === "push")?.env;
    expect(pushEnv?.GH_TOKEN).toBe("bot-token");
    const ghEnvs = envCalls.filter((call) => call.cmd === "gh").map((call) => call.env.GH_TOKEN);
    expect(ghEnvs.length).toBeGreaterThan(0);
    expect(ghEnvs.every((token) => token === "bot-token")).toBe(true);
    const gateEnv = envCalls.find((call) => call.cmd === "pnpm" && call.args[1] === "typecheck")?.env;
    expect(gateEnv?.GH_TOKEN).toBe("personal-token");
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
  });
});
