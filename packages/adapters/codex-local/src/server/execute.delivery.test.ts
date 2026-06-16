import { describe, expect, it, vi } from "vitest";

import { executeDeliveryHook } from "./execute.js";

function mkRunProc(seq: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  // Default `git diff HEAD` to a substantive patch so the placeholder-diff gate
  // is satisfied unless a test explicitly overrides it. Tests that exercise the
  // gate supply their own empty `git diff` entry.
  const withDefaults: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {
    "git diff": { exitCode: 0, stdout: "diff --git a/f b/f\n+real change\n" },
    ...seq,
  };
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const m =
      withDefaults[key] ?? withDefaults[`${cmd} ${args[0] ?? ""}`] ?? { exitCode: 0, stdout: "" };
    return { exitCode: m.exitCode, stdout: m.stdout ?? "", stderr: m.stderr ?? "" };
  });
}

const base = {
  runId: "r1",
  worktreeCwd: "/wt",
  branch: "codex/HAS-222-x",
  env: {},
  issueIdentifier: "HAS-222",
  issueId: "uuid",
  repo: "Beyn-SOLIDUS/quantum",
  baseBranch: "main",
  log: vi.fn(async () => {}),
};

describe("executeDeliveryHook", () => {
  it("T1: diff present -> commit + push + PR", async () => {
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M HEARTBEAT.md\n" },
      "git add -A": { exitCode: 0 },
      "git commit -m": { exitCode: 0 },
      // paperclip:allow-git-push: mock key for sovereign delivery hook push path under test (not a real invocation)
      "git push -u": { exitCode: 0 },
      "gh pr list": { exitCode: 0, stdout: "" },
      "gh label list": { exitCode: 0, stdout: "[]" },
      "gh pr create": { exitCode: 0, stdout: "" },
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(["created", "pr_exists"]).toContain(r.reason);
  });

  it("T2: no diff -> silent skip, no commit", async () => {
    const runProc = mkRunProc({ "git status --porcelain": { exitCode: 0, stdout: "" } });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("no_diff");
    expect(runProc).toHaveBeenCalledTimes(1);
  });

  it("T3: push 401 -> auth error, no retry loop", async () => {
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M f\n" },
      "git add -A": { exitCode: 0 },
      "git commit -m": { exitCode: 0 },
      // paperclip:allow-git-push: mock key for sovereign delivery hook push path under test (not a real invocation)
      "git push -u": { exitCode: 1, stderr: "remote: 401 Unauthorized" },
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("push_auth_failed");
  });

  it("T4: PR already exists -> idempotent, no duplicate", async () => {
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M f\n" },
      "git add -A": { exitCode: 0 },
      "git commit -m": { exitCode: 0 },
      // paperclip:allow-git-push: mock key for sovereign delivery hook push path under test (not a real invocation)
      "git push -u": { exitCode: 0 },
      "gh pr list": { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/9\n" },
      "gh label list": { exitCode: 0, stdout: "[]" },
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("pr_exists");
  });

  it("T5: conflict markers -> explicit error, no push mutation", async () => {
    const runProc = mkRunProc({ "git status --porcelain": { exitCode: 0, stdout: "UU HEARTBEAT.md\n" } });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("conflict");
  });

  it("T6: labels present in repo -> applied to created PR; label list uses --limit", async () => {
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M HEARTBEAT.md\n", stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "diff --git a/f b/f\n+x\n", stderr: "" };
      if (key === "gh label list")
        return { exitCode: 0, stdout: JSON.stringify(["bug", "factory-proof", "human-gate-required"]), stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/2\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("created");
    const labelCall = calls.find((c) => c[0] === "gh" && c[1] === "label" && c[2] === "list");
    expect(labelCall).toContain("--limit");
    expect(labelCall).toContain("200");
    const createCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
    expect(createCall).toContain("factory-proof");
    expect(createCall).toContain("human-gate-required");
  });

  it("T7: placeholder diff (whitespace-only, no patch) -> rejected, no commit/push", async () => {
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M src/f.ts\n" },
      // `git diff --ignore-all-space HEAD` returns no patch -> only whitespace/no-op.
      "git diff": { exitCode: 0, stdout: "" },
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("placeholder_diff");
    expect(r.delivered).toBe(false);
    const calls = runProc.mock.calls.map((c) => `${c[0]} ${c[1][0] ?? ""}`);
    expect(calls).not.toContain("git commit");
    // paperclip:allow-git-push: assertion string in a placeholder-diff test (not a real invocation)
    expect(calls).not.toContain("git push");
  });

  it("T7b: untracked file present -> placeholder gate skipped (new file is real content)", async () => {
    const runProc = mkRunProc({
      // A brand-new file shows as "??"; tracked diff against HEAD is empty, but the
      // new file is genuine content, so delivery must proceed rather than reject.
      "git status --porcelain": { exitCode: 0, stdout: "?? src/new.ts\n" },
      "git diff": { exitCode: 0, stdout: "" },
      "git add -A": { exitCode: 0 },
      "git commit -m": { exitCode: 0 },
      // paperclip:allow-git-push: mock key for sovereign delivery hook push path under test (not a real invocation)
      "git push -u": { exitCode: 0 },
      "gh pr list": { exitCode: 0, stdout: "" },
      "gh label list": { exitCode: 0, stdout: "[]" },
      "gh pr create": { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/3\n" },
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("created");
  });

  it("T8: dedup checks all PR states (closed-but-unmerged is not duplicated)", async () => {
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "diff --git a/f b/f\n+x\n", stderr: "" };
      // A previously closed (not merged) PR on the same head is returned because
      // the lookup now queries --state all; the hook must treat it as existing.
      if (key === "gh pr list") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/9\n", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("pr_exists");
    const listCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "list");
    expect(listCall).toContain("--state");
    expect(listCall).toContain("all");
    expect(calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBeUndefined();
  });

  it("T9: production PR body carries a Truthfulness Boundary", async () => {
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M f\n", stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "diff --git a/f b/f\n+x\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/4\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("created");
    const createCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
    const bodyIdx = (createCall ?? []).indexOf("--body");
    const body = bodyIdx >= 0 ? createCall![bodyIdx + 1] : "";
    expect(body).toContain("Truthfulness Boundary");
    expect(body).toContain("HAS-46");
  });
});
