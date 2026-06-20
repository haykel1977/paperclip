import { describe, expect, it, vi } from "vitest";

import {
  executeDeliveryHook,
  parseChangedPathsFromPorcelain,
  SACRED_PATH_PREFIXES,
} from "./execute.js";

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

  // ── No-human lane (dev-test) invariants ─────────────────────────────────────

  // Records every gh/git invocation so lane behavior can be asserted. By default
  // a clean (non-sacred) modification with no pre-existing PR and all lane labels
  // present in the repo.
  function laneRunProc(opts: {
    status?: string;
    existingPrUrl?: string;
    repoLabels?: string[];
    createUrl?: string;
  } = {}) {
    const {
      status = " M docs/readme.md\n",
      existingPrUrl = "",
      repoLabels = [
        "factory-proof",
        "human-gate-required",
        "prod-gate-required",
        "agent-pr",
        "automated",
        "truth-first",
      ],
      createUrl = "https://github.com/Beyn-SOLIDUS/quantum/pull/100\n",
    } = opts;
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: status, stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "diff --git a/f b/f\n+x\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: existingPrUrl, stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: JSON.stringify(repoLabels), stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: createUrl, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    return { runProc, calls };
  }

  const findCreate = (calls: string[][]) =>
    calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  const bodyOf = (createCall: string[] | undefined) => {
    if (!createCall) return "";
    const i = createCall.indexOf("--body");
    return i >= 0 ? createCall[i + 1] : "";
  };

  it("T10: dev-test lane (non-sacred) -> agent labels, no human-gate, no prod-gate, no reviewer, auto-merge requested", async () => {
    const { runProc, calls } = laneRunProc();
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc } as any);
    expect(r.reason).toBe("created");
    const create = findCreate(calls)!;
    expect(create).toContain("factory-proof");
    expect(create).toContain("agent-pr");
    expect(create).toContain("automated");
    expect(create).toContain("truth-first");
    // Baseline no-human lane invariants:
    expect(create).not.toContain("human-gate-required");
    expect(create).not.toContain("prod-gate-required");
    // Non-draft: the hook never creates a draft PR.
    expect(create).not.toContain("--draft");
    // No reviewer request in the no-human lane.
    expect(calls.find((c) => c.includes("--add-reviewer"))).toBeUndefined();
    // Native auto-merge requested (never a direct merge).
    const am = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge");
    expect(am).toContain("--auto");
    expect(bodyOf(create)).toContain("dev-test");
  });

  it("T11: production lane (default) -> human-gate + prod-gate labels, reviewer requested, no auto-merge", async () => {
    const { runProc, calls } = laneRunProc();
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("created");
    const create = findCreate(calls)!;
    expect(create).toContain("human-gate-required");
    expect(create).toContain("prod-gate-required");
    expect(create).not.toContain("agent-pr");
    expect(calls.find((c) => c.includes("--add-reviewer"))).toContain("haykel1977");
    expect(calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBeUndefined();
    expect(bodyOf(create)).toContain("HAS-46");
  });

  it("T12: dev-test lane but diff touches a sacred path -> forced human gate (labels + reviewer, no auto-merge)", async () => {
    const { runProc, calls } = laneRunProc({
      status: " M server/src/routes/agents.ts\n",
    });
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc } as any);
    expect(r.reason).toBe("created");
    const create = findCreate(calls)!;
    expect(create).toContain("human-gate-required");
    expect(create).toContain("prod-gate-required");
    expect(create).not.toContain("agent-pr");
    expect(calls.find((c) => c.includes("--add-reviewer"))).toContain("haykel1977");
    expect(calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBeUndefined();
    expect(bodyOf(create)).toContain("sacred path");
  });

  it("T13: dev-test reconcile of an existing PR strips stale human-gate labels, removes reviewer, requests auto-merge", async () => {
    const { runProc, calls } = laneRunProc({
      existingPrUrl: "https://github.com/Beyn-SOLIDUS/quantum/pull/55\n",
    });
    const r = await executeDeliveryHook({ ...base, env: { PAPERCLIP_DELIVERY_LANE: "dev-test" }, runProc } as any);
    expect(r.reason).toBe("pr_exists");
    const edit = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit" && c.includes("--add-label"));
    expect(edit).toBeDefined();
    // Stale production labels removed, current lane labels added.
    expect(edit).toContain("--remove-label");
    const removeIdxs = edit!.reduce<string[]>((acc, v, i) => (v === "--remove-label" ? [...acc, edit![i + 1]] : acc), []);
    expect(removeIdxs).toContain("human-gate-required");
    expect(removeIdxs).toContain("prod-gate-required");
    const addIdxs = edit!.reduce<string[]>((acc, v, i) => (v === "--add-label" ? [...acc, edit![i + 1]] : acc), []);
    expect(addIdxs).toContain("agent-pr");
    // Human reviewer removed on downgrade.
    expect(calls.find((c) => c.includes("--remove-reviewer"))).toContain("haykel1977");
    // Auto-merge (re)requested.
    expect(calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toContain("--auto");
  });

  it("T14: production reconcile of an existing PR strips stale dev-test labels and ensures reviewer", async () => {
    const { runProc, calls } = laneRunProc({
      existingPrUrl: "https://github.com/Beyn-SOLIDUS/quantum/pull/56\n",
    });
    const r = await executeDeliveryHook({ ...base, runProc } as any);
    expect(r.reason).toBe("pr_exists");
    const edit = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit" && c.includes("--add-label"));
    const removeIdxs = edit!.reduce<string[]>((acc, v, i) => (v === "--remove-label" ? [...acc, edit![i + 1]] : acc), []);
    expect(removeIdxs).toContain("agent-pr");
    expect(removeIdxs).toContain("automated");
    const addIdxs = edit!.reduce<string[]>((acc, v, i) => (v === "--add-label" ? [...acc, edit![i + 1]] : acc), []);
    expect(addIdxs).toContain("human-gate-required");
    expect(calls.find((c) => c.includes("--add-reviewer"))).toContain("haykel1977");
    expect(calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBeUndefined();
  });

  it("T15: parseChangedPathsFromPorcelain handles modifications, untracked, and renames", () => {
    const porcelain = [
      " M docs/readme.md",
      "?? src/new.ts",
      "R  old/path.ts -> server/src/routes/agents.ts",
      'A  "ui/src/components/Md Body.tsx"',
      "",
    ].join("\n");
    const paths = parseChangedPathsFromPorcelain(porcelain);
    expect(paths).toContain("docs/readme.md");
    expect(paths).toContain("src/new.ts");
    expect(paths).toContain("server/src/routes/agents.ts");
    expect(paths).toContain("ui/src/components/Md Body.tsx");
    // Sacred prefixes pick up the renamed-to sensitive route.
    expect(SACRED_PATH_PREFIXES.some((p) => "server/src/routes/agents.ts".startsWith(p))).toBe(true);
  });
});
