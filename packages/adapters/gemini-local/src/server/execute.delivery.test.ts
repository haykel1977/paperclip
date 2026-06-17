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

  it("flag ON + gate vert -> bot-merge-ready", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
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
      env: { PAPERCLIP_AUTONOMOUS_DELIVERY: "1", PAPERCLIP_DELIVERY_BOT_TOKEN: "bot-token" },
      runProc,
    });
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toContain("bot-merge-ready");

    expect(createCall).not.toContain("human-gate-required");
  });
});
