import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeDeliveryHook } from "@paperclipai/adapter-utils/delivery-hook";

const tmpDirs: string[] = [];

function mkWorktree() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-gemini-delivery-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", "check:tokens": "secret scan" } }), "utf8");
  return dir;
}

const base = {
  runId: "r1",
  branch: "gemini/HAS-222-x",

  env: {},
  issueIdentifier: "HAS-222",
  issueId: "uuid",
  repo: "Beyn-SOLIDUS/quantum",
  baseBranch: "main",
  log: vi.fn(async () => {}),
};

const savedAutonomous = process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
const savedBotToken = process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;

beforeEach(() => {
  delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
  delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
});

afterEach(() => {
  if (savedAutonomous === undefined) delete process.env.PAPERCLIP_AUTONOMOUS_DELIVERY;
  else process.env.PAPERCLIP_AUTONOMOUS_DELIVERY = savedAutonomous;
  if (savedBotToken === undefined) delete process.env.PAPERCLIP_DELIVERY_BOT_TOKEN;
  else process.env.PAPERCLIP_DELIVERY_BOT_TOKEN = savedBotToken;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gemini-local delivery hook", () => {

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
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
  });

  it("flag OFF -> human-gate-required", async () => {
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

  it("flag ON + gate vert -> bot-merge-ready avec token bot", async () => {
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
    expect(gateEnv?.GH_TOKEN).toBeUndefined();
    expect(gateEnv?.PAPERCLIP_DELIVERY_BOT_TOKEN).toBeUndefined();
  });

  it("idempotency: PR existante detectee avant commit -> aucun commit, aucun push", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/99\n", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(["factory-proof", "human-gate-required"]), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("pr_exists");
    expect(result.prUrl).toBe("https://github.com/Beyn-SOLIDUS/quantum/pull/99");
    expect(result.delivered).toBe(true);
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "git" && call[1] === "push")).toBe(false);
    expect(calls.some((call) => call[0] === "pnpm")).toBe(false);
  });

  it("push retry: transient 503 -> retries once, succeeds", async () => {
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
        if (pushAttempts === 1) return { exitCode: 1, stdout: "", stderr: "fatal: 503 Service Unavailable — timed out" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await executeDeliveryHook({ ...base, worktreeCwd, runProc });
    expect(result.reason).toBe("created");
    expect(pushAttempts).toBe(2);
  }, 10000);
});
