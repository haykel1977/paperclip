import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression tests for haykel1977/paperclip#103 (observed on paperclip.kantum.dev, 2026-09-03):
//  1. OpenCode derives its project directory from the inherited PWD env var and re-instantiates
//     there when it differs from the spawn cwd. The server runs from /app, so every isolated
//     worktree run silently worked in /app. The adapter must pin PWD to the execution cwd.
//  2. The prompt must tell the model where its checkout is ("Workspace location" section).

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "bifrost/qwen3-coder-30b-sovereign\n",
        stderr: "",
        pid: 122,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session_pwd" }),
        JSON.stringify({ type: "text", sessionID: "session_pwd", part: { text: "done" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session_pwd",
          part: { cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/local/bin/opencode"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

type RunCall = [string, string, string[], { cwd: string; env: Record<string, string>; stdin?: string }];

function lastRunInvocation(): RunCall {
  const calls = runChildProcess.mock.calls as unknown as RunCall[];
  const run = [...calls].reverse().find((call) => call[2]?.[0] === "run");
  if (!run) throw new Error("no `opencode run` invocation captured");
  return run;
}

describe("opencode local execution: workspace location", () => {
  const cleanupDirs: string[] = [];
  const previousPwd = process.env.PWD;

  afterEach(async () => {
    vi.clearAllMocks();
    if (previousPwd === undefined) delete process.env.PWD;
    else process.env.PWD = previousPwd;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runInWorktree() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-pwd-"));
    cleanupDirs.push(rootDir);
    const worktree = path.join(rootDir, ".paperclip", "worktrees", "QUA-1-task");
    await mkdir(worktree, { recursive: true });
    // Simulate the server process running from an unrelated directory (the container's /app).
    process.env.PWD = rootDir;

    await execute({
      runId: "run-pwd",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Q-Impl",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "bifrost/qwen3-coder-30b-sovereign" },
      context: {
        paperclipWorkspace: {
          cwd: worktree,
          source: "task_session",
          mode: "isolated_workspace",
          branch: "QUA-1-task",
          repoUrl: "https://x-access-token:secret@github.com/acme/quantum.git",
        },
      },
      onLog: async () => {},
    });
    return { worktree, invocation: lastRunInvocation() };
  }

  it("spawns opencode with cwd=worktree and PWD pinned to it (not the server's PWD)", async () => {
    const { worktree, invocation } = await runInWorktree();
    const [, , , options] = invocation;
    expect(options.cwd).toBe(worktree);
    expect(options.env.PWD).toBe(worktree);
    expect(options.env.OLDPWD).toBeUndefined();
    expect(options.env.INIT_CWD).toBeUndefined();
  });

  it("tells the model where its checkout is, with the task branch and a credential-free remote", async () => {
    const { worktree, invocation } = await runInWorktree();
    const prompt = invocation[3].stdin ?? "";
    expect(prompt).toContain("Workspace location:");
    expect(prompt).toContain(`\`${worktree}\``);
    expect(prompt).toContain("Task branch: `QUA-1-task`");
    expect(prompt).toContain("https://github.com/acme/quantum.git");
    expect(prompt).not.toContain("x-access-token");
    expect(prompt).not.toContain("secret@");
  });
});
