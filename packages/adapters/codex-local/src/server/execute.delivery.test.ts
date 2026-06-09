import { describe, expect, it, vi } from "vitest";

import { executeDeliveryHook } from "./execute.js";

function mkRunProc(seq: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const m = seq[key] ?? seq[`${cmd} ${args[0] ?? ""}`] ?? { exitCode: 0, stdout: "" };
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
});
