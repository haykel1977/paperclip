import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // Lane defaults to "production" only when PAPERCLIP_DELIVERY_LANE is unset in both the
  // passed env and process.env. Clear it so tests relying on the default are not affected
  // by a lane set in the surrounding environment.
  const savedLane = process.env.PAPERCLIP_DELIVERY_LANE;
  beforeEach(() => {
    delete process.env.PAPERCLIP_DELIVERY_LANE;
  });
  afterEach(() => {
    if (savedLane === undefined) delete process.env.PAPERCLIP_DELIVERY_LANE;
    else process.env.PAPERCLIP_DELIVERY_LANE = savedLane;
  });

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

  // mkLabelCapture: records gh argv so a test can inspect label flags + PR body.
  function mkLabelCapture(repoLabels: string[]) {
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M HEARTBEAT.md\n", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(repoLabels), stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/3\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    return { calls, runProc };
  }

  function labelArgs(calls: string[][]): string[] {
    const create = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
    if (!create) return [];
    const out: string[] = [];
    for (let i = 0; i < create.length - 1; i++) if (create[i] === "--label") out.push(create[i + 1]);
    return out;
  }

  function bodyArg(calls: string[][]): string {
    const create = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
    if (!create) return "";
    const i = create.indexOf("--body");
    return i >= 0 ? create[i + 1] : "";
  }

  it("T7: production lane (default) keeps human-gate label, no agent-pr, body has HAS-46", async () => {
    const { calls, runProc } = mkLabelCapture([
      "factory-proof",
      "human-gate-required",
      "agent-pr",
      "automated",
      "truth-first",
    ]);
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "production" }, runProc } as any);
    expect(r.reason).toBe("created");
    const labels = labelArgs(calls);
    expect(labels).toContain("human-gate-required");
    expect(labels).toContain("factory-proof");
    expect(labels).not.toContain("agent-pr");
    expect(bodyArg(calls)).toContain("HAS-46");
  });

  it("T8: unset lane env defaults to production (fail-closed human gate)", async () => {
    const { calls, runProc } = mkLabelCapture(["factory-proof", "human-gate-required", "agent-pr"]);
    const r = await executeDeliveryHook({ ...base, env: {}, runProc } as any);
    expect(r.reason).toBe("created");
    expect(labelArgs(calls)).toContain("human-gate-required");
    expect(labelArgs(calls)).not.toContain("agent-pr");
  });

  it("T9: dev-test lane omits human-gate, adds Quantum gate labels + ADR/Truthfulness body", async () => {
    const { calls, runProc } = mkLabelCapture([
      "factory-proof",
      "human-gate-required",
      "agent-pr",
      "automated",
      "truth-first",
    ]);
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc } as any);
    expect(r.reason).toBe("created");
    const labels = labelArgs(calls);
    expect(labels).not.toContain("human-gate-required");
    expect(labels).toContain("agent-pr");
    expect(labels).toContain("automated");
    expect(labels).toContain("truth-first");
    expect(labels).toContain("factory-proof");
    const body = bodyArg(calls);
    expect(body).toContain("ADR-GOV-007");
    expect(body).toContain("Truthfulness Boundary");
    expect(body).not.toContain("HAS-46");
  });

  it("T10: dev-test lane only applies gate labels that exist in the repo (pre-flight filter)", async () => {
    // Repo has not yet created agent-pr/automated; only factory-proof + truth-first exist.
    const { calls, runProc } = mkLabelCapture(["factory-proof", "truth-first"]);
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc } as any);
    expect(r.reason).toBe("created");
    const labels = labelArgs(calls);
    expect(labels).toContain("factory-proof");
    expect(labels).toContain("truth-first");
    expect(labels).not.toContain("agent-pr");
    expect(labels).not.toContain("human-gate-required");
  });
});
