import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression tests for haykel1977/paperclip#103 (observed on paperclip.kantum.dev, 2026-09-03):
//  1. OpenCode derives its project directory from the inherited PWD env var and re-instantiates
//     there when it differs from the spawn cwd. The server runs from /app, so every isolated
//     worktree run silently worked in /app. The adapter must pin PWD to the execution cwd on
//     the final env passed to runChildProcess (process.env is re-merged after the overlay).
//  2. The prompt must tell the model where its checkout is ("Workspace location" section)
//     for local non-resume runs, and omit it for resume-delta and remote execution.

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "bifrost/qwen3-coder-30b-sovereign\nopencode/gpt-5-nano\n",
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
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
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

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
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

const wakePayload = {
  reason: "issue_commented",
  issue: {
    id: "issue-1",
    identifier: "QUA-1",
    title: "workspace location",
    status: "in_progress",
    priority: "medium",
  },
  commentIds: ["comment-1"],
  latestCommentId: "comment-1",
  comments: [
    {
      id: "comment-1",
      issueId: "issue-1",
      body: "Continue in the worktree.",
      bodyTruncated: false,
      createdAt: "2026-09-03T12:00:00.000Z",
      author: { type: "user", id: "user-1" },
    },
  ],
  commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
  fallbackFetchNeeded: false,
};

describe("opencode local execution: workspace location", () => {
  const cleanupDirs: string[] = [];
  const previousPwd = process.env.PWD;
  const previousOldPwd = process.env["OLDPWD"];
  const previousInitCwd = process.env["INIT_CWD"];

  afterEach(async () => {
    vi.clearAllMocks();
    if (previousPwd === undefined) delete process.env.PWD;
    else process.env.PWD = previousPwd;
    if (previousOldPwd === undefined) delete process.env["OLDPWD"];
    else process.env["OLDPWD"] = previousOldPwd;
    if (previousInitCwd === undefined) delete process.env["INIT_CWD"];
    else process.env["INIT_CWD"] = previousInitCwd;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function prepareWorktree() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-pwd-"));
    cleanupDirs.push(rootDir);
    const worktree = path.join(rootDir, ".paperclip", "worktrees", "QUA-1-task");
    await mkdir(worktree, { recursive: true });
    // Simulate the server process running from an unrelated directory (the container's /app).
    process.env.PWD = rootDir;
    process.env["OLDPWD"] = "/app";
    process.env["INIT_CWD"] = "/app";
    return { rootDir, worktree };
  }

  async function runInWorktree(input?: {
    repoUrl?: string;
    resumeSession?: boolean;
    paperclipWake?: Record<string, unknown>;
  }) {
    const { worktree } = await prepareWorktree();
    const repoUrl = input?.repoUrl ?? "https://x-access-token:secret@github.com/acme/quantum.git";

    await execute({
      runId: "run-pwd",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Q-Impl",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: input?.resumeSession
        ? {
            sessionId: "session_pwd",
            sessionParams: { sessionId: "session_pwd", cwd: worktree },
            sessionDisplayId: "session_pwd",
            taskKey: null,
          }
        : { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "bifrost/qwen3-coder-30b-sovereign" },
      context: {
        paperclipWorkspace: {
          cwd: worktree,
          source: "task_session",
          mode: "isolated_workspace",
          branchName: "QUA-1-task",
          repoUrl,
        },
        ...(input?.paperclipWake ? { paperclipWake: input.paperclipWake } : {}),
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

  it("leaves ssh remotes untouched instead of stripping the git user", async () => {
    const { invocation } = await runInWorktree({
      repoUrl: "ssh://git@github.com/acme/quantum.git",
    });
    const prompt = invocation[3].stdin ?? "";
    expect(prompt).toContain("Workspace location:");
    expect(prompt).toContain("ssh://git@github.com/acme/quantum.git");
    expect(prompt).not.toContain("ssh://github.com/acme/quantum.git");
  });

  it("omits the workspace-location section on resume-delta prompts", async () => {
    const { invocation } = await runInWorktree({
      resumeSession: true,
      paperclipWake: wakePayload,
    });
    const prompt = invocation[3].stdin ?? "";
    expect(prompt).toContain("Paperclip Resume Delta");
    expect(prompt).not.toContain("Workspace location:");
  });

  it("omits the workspace-location section for remote execution", async () => {
    const { worktree } = await prepareWorktree();
    await execute({
      runId: "run-pwd-remote",
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
          branchName: "QUA-1-task",
          repoUrl: "https://x-access-token:secret@github.com/acme/quantum.git",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });
    const prompt = lastRunInvocation()[3].stdin ?? "";
    expect(prompt).not.toContain("Workspace location:");
  });
});
