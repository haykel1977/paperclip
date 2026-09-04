import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildQuantumAgentBranch,
  buildQuantumPrBody,
  classifyDeliveryTitleKind,
  deriveQuantumDeliveryTitle,
  deriveQuantumMakerToken,
  executeConfiguredDeliveryHook,
  executeDeliveryHook,
  isAdrGov007CompliantBranch,
  isDocDeliveryPath,
  isQuantumDeliveryTarget,
  isQuantumJunkPath,
  parseChangedPathsFromPorcelain,
  resolveGithubIssueNumber,
  type DeliveryHookRunProcess,
} from "./delivery-hook.js";

const QUANTUM_MAKER_CI_RE = /Qwen3-[0-9]+[A-Z]*/;
const tmpDirs: string[] = [];

function mkWorktree(extraFiles: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-delivery-hook-"));
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
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const full = path.join(dir, relative);
    writeFileSync(full, contents, { mode: relative.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return dir;
}

function mkRunProc(seq: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}): DeliveryHookRunProcess {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const m = seq[key] ?? seq[`${cmd} ${args[0] ?? ""}`] ?? { exitCode: 0, stdout: "" };
    return { exitCode: m.exitCode, stdout: m.stdout ?? "", stderr: m.stderr ?? "" };
  });
}

const quantumBase = {
  runId: "r1",
  branch: "codex/QUA-99-x",
  env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "3135" },
  issueIdentifier: "QUA-99",
  issueId: "issue-uuid",
  repo: "Beyn-SOLIDUS/quantum",
  baseBranch: "main",
  adapterType: "codex_local",
  agentId: "agent-1",
  model: "qwen3-coder-30b-sovereign",
  log: vi.fn(async () => {}),
};

const ISSUE_ENV_KEYS = [
  "PAPERCLIP_GITHUB_ISSUE_NUMBER",
  "PAPERCLIP_ISSUE_TITLE",
  "PAPERCLIP_ISSUE_DESCRIPTION",
  "PAPERCLIP_ISSUE_BODY",
] as const;
const savedIssueEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ISSUE_ENV_KEYS) {
    if (!savedIssueEnv.has(key)) continue;
    const previous = savedIssueEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    savedIssueEnv.delete(key);
  }
});

function isolateIssueEnv() {
  for (const key of ISSUE_ENV_KEYS) {
    if (!savedIssueEnv.has(key)) savedIssueEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

describe("Quantum delivery helpers", () => {
  it("detects Quantum by repo or convention env", () => {
    expect(isQuantumDeliveryTarget("Beyn-SOLIDUS/quantum", {})).toBe(true);
    expect(isQuantumDeliveryTarget("paperclipai/paperclip", {})).toBe(false);
    expect(isQuantumDeliveryTarget("paperclipai/paperclip", { PAPERCLIP_DELIVERY_BRANCH_CONVENTION: "quantum" })).toBe(true);
  });

  it("rewrites agent-chosen branches into ADR-GOV-007 form and rejects codex/QUA-*", () => {
    expect(isAdrGov007CompliantBranch("codex/QUA-99-x")).toBe(false);
    expect(isAdrGov007CompliantBranch("paperclip/issue-uuid-delivery")).toBe(false);
    expect(isAdrGov007CompliantBranch("feat/agent-agent-1-ticket-qua-99-delivery")).toBe(true);
    expect(isAdrGov007CompliantBranch("fix/paperclip-scope-guard")).toBe(true);
    expect(isAdrGov007CompliantBranch("pr-learning/loop-1")).toBe(true);
    expect(buildQuantumAgentBranch({
      agentId: "Agent 1",
      issueIdentifier: "QUA-99",
      shortSlug: "delivery",
    })).toBe("feat/agent-agent-1-ticket-qua-99-delivery");
  });

  it("derives a CI-matching maker token and never invents one", () => {
    expect(deriveQuantumMakerToken("qwen3-coder-30b-sovereign")).toBe("Qwen3-30B");
    expect(deriveQuantumMakerToken("Qwen3-30B")).toBe("Qwen3-30B");
    expect(deriveQuantumMakerToken("qwen3-8b")).toBe("Qwen3-8B");
    expect(deriveQuantumMakerToken("sovereign-gpt-5")).toBeNull();
    expect(deriveQuantumMakerToken(null)).toBeNull();
    expect(QUANTUM_MAKER_CI_RE.test(deriveQuantumMakerToken("qwen3-coder-30b-sovereign") ?? "")).toBe(true);
  });

  it("resolves Closes numbers without inventing them from QUA-* ids", () => {
    isolateIssueEnv();
    expect(resolveGithubIssueNumber({ issueIdentifier: "QUA-99", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({ issueIdentifier: "CBS-21", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({ issueIdentifier: "QUA-99", env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "3135" } })).toBe(3135);
    expect(resolveGithubIssueNumber({ issueIdentifier: "222", env: {} })).toBe(222);
    expect(resolveGithubIssueNumber({ issueIdentifier: "#88", env: {} })).toBe(88);
  });

  it("parses a GitHub number from PAPERCLIP_ISSUE_TITLE / Closes / Fixes / Resolves", () => {
    isolateIssueEnv();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "fix(api): foo #1894" },
    })).toBe(1894);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "Closes #1894" },
    })).toBe(1894);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "Fixes #42 after review" },
    })).toBe(42);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "Resolves #7" },
    })).toBe(7);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "no github ref here" },
    })).toBeNull();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "see #0 then Closes #1894" },
    })).toBe(1894);
  });

  it("rejects #0 / 0 and non-safe integers instead of emitting Closes #0", () => {
    isolateIssueEnv();
    expect(resolveGithubIssueNumber({ issueIdentifier: "0", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({ issueIdentifier: "#0", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({ issueIdentifier: "QUA-21", env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "0" } })).toBeNull();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "broken ref #0" },
    })).toBeNull();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "9007199254740992" },
    })).toBeNull();
  });

  it("does not recover a leftover process.env title/description from a previous issue", () => {
    isolateIssueEnv();
    process.env["PAPERCLIP_ISSUE_TITLE"] = "stale leftover Closes #9999";
    process.env["PAPERCLIP_ISSUE_DESCRIPTION"] = "Fixes #8888";
    process.env["PAPERCLIP_ISSUE_BODY"] = "Resolves #7777";
    expect(resolveGithubIssueNumber({ issueIdentifier: "QUA-21", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_TITLE: "fix(api): foo #1894" },
    })).toBe(1894);
    process.env["PAPERCLIP_GITHUB_ISSUE_NUMBER"] = "9999";
    expect(resolveGithubIssueNumber({ issueIdentifier: "QUA-21", env: {} })).toBeNull();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "1894" },
    })).toBe(1894);
  });

  it("falls back to description/body env and never overwrites an explicit GitHub number", () => {
    isolateIssueEnv();
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_DESCRIPTION: "See Closes #2210 for the parent." },
    })).toBe(2210);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: { PAPERCLIP_ISSUE_BODY: "Fixes #9" },
    })).toBe(9);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: {
        PAPERCLIP_GITHUB_ISSUE_NUMBER: "3135",
        PAPERCLIP_ISSUE_TITLE: "fix(api): foo #1894",
      },
    })).toBe(3135);
    expect(resolveGithubIssueNumber({
      issueIdentifier: "QUA-21",
      env: {
        PAPERCLIP_ISSUE_TITLE: "fix(api): foo #1894",
        PAPERCLIP_ISSUE_DESCRIPTION: "Closes #9",
      },
    })).toBe(1894);
  });

  it("classifies docs vs non-doc and never titles docs: when code changed", () => {
    expect(isDocDeliveryPath("docs/adr.md")).toBe(true);
    expect(isDocDeliveryPath("README.md")).toBe(true);
    expect(isDocDeliveryPath("src/hook.ts")).toBe(false);
    expect(classifyDeliveryTitleKind(["docs/a.md", "README.md"])).toBe("docs");
    expect(classifyDeliveryTitleKind(["docs/a.md", "src/hook.ts"])).toBe("feat");
    expect(deriveQuantumDeliveryTitle({
      issueIdentifier: "QUA-99",
      changedPaths: ["docs/a.md", "src/hook.ts"],
      makerToken: "Qwen3-30B",
    })).toMatch(/^feat:/);
    expect(deriveQuantumDeliveryTitle({
      issueIdentifier: "QUA-99",
      changedPaths: ["docs/a.md", "src/hook.ts"],
      makerToken: "Qwen3-30B",
    })).not.toMatch(/^docs:/);
  });

  it("flags RULE-DRIFT-004 junk paths", () => {
    expect(isQuantumJunkPath("run_status.txt")).toBe(true);
    expect(isQuantumJunkPath("pr_body.md")).toBe(true);
    expect(isQuantumJunkPath("FINAL_STATUS.md")).toBe(true);
    expect(isQuantumJunkPath(".agents/memory/notes.md")).toBe(true);
    expect(isQuantumJunkPath("docs/theater-notes.md")).toBe(true);
    expect(isQuantumJunkPath("src/delivery-hook.ts")).toBe(false);
  });

  it("lists only git-derived paths in the Quantum PR body", () => {
    const body = buildQuantumPrBody({
      issueIdentifier: "QUA-99",
      issueId: "issue-uuid",
      runId: "r1",
      repo: "Beyn-SOLIDUS/quantum",
      adapterType: "codex_local",
      agentId: "agent-1",
      model: "qwen3-coder-30b-sovereign",
      makerToken: "Qwen3-30B",
      githubIssueNumber: 3135,
      branch: "feat/agent-agent-1-ticket-qua-99-delivery",
      baseBranch: "main",
      lane: "production",
      adrRef: "ADR-GOV-007",
      autonomousDelivery: false,
      isDevTestLane: false,
      statusStdout: " M planned-not-in-diff.ts\n",
      changedPaths: ["packages/adapter-utils/src/delivery-hook.ts"],
      qualityGateCommands: [],
      signingPlan: { required: false, signCommit: false, source: "not-required" },
    });
    expect(body).toContain("- `packages/adapter-utils/src/delivery-hook.ts`");
    expect(body).not.toContain("planned-not-in-diff.ts");
    expect(body).toMatch(/^Closes #3135$/m);
    expect(body).toContain("Maker model: Qwen3-30B");
    expect(body).toContain("## Truthfulness Boundary");
    expect(QUANTUM_MAKER_CI_RE.test(body)).toBe(true);
  });

  it("parses porcelain including renames", () => {
    expect(parseChangedPathsFromPorcelain(" M src/a.ts\nR  old.ts -> new.ts\n")).toEqual([
      "src/a.ts",
      "new.ts",
    ]);
  });
});

describe("executeDeliveryHook Quantum fail-closed contract", () => {
  it("rewrites a codex/QUA-* head to feat/agent-*-ticket-* before push/PR", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/1\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({ ...quantumBase, worktreeCwd, runProc });
    expect(result.reason).toBe("created");
    expect(calls).toContainEqual(["git", "checkout", "-b", "feat/agent-agent-1-ticket-qua-99-delivery"]);
    expect(calls).toContainEqual(["git", "push", "-u", "origin", "feat/agent-agent-1-ticket-qua-99-delivery"]);
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    expect(createCall).toContain("feat/agent-agent-1-ticket-qua-99-delivery");
    expect(createCall).not.toContain("codex/QUA-99-x");
    const title = createCall?.[createCall.indexOf("--title") + 1] ?? "";
    const body = createCall?.[createCall.indexOf("--body") + 1] ?? "";
    expect(title).toMatch(QUANTUM_MAKER_CI_RE);
    expect(title).not.toMatch(/^docs:/);
    expect(body).toMatch(/^Closes #3135$/m);
    expect(body).toContain("Maker model: Qwen3-30B");
    expect(body).toContain("- `src/hook.ts`");
  });

  it("blocks more than 3 non-doc files before commit", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: " M a.ts\n M b.ts\n M c.ts\n M d.ts\n M e.ts\n", stderr: "" };
      }
      if (cmd === "gh") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({ ...quantumBase, worktreeCwd, runProc });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/quantum_scope_exceeded/);
    expect(result.reason).toContain("Split the change");
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
    expect(calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create")).toBe(false);
  });

  it("blocks RULE-DRIFT-004 junk files before commit", async () => {
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: "?? run_status.txt\n M src/hook.ts\n", stderr: "" };
      }
      if (cmd === "gh") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({ ...quantumBase, worktreeCwd, runProc });
    expect(result.reason).toMatch(/quantum_junk_files/);
    expect(result.reason).toContain("run_status.txt");
    expect(calls.some((call) => call[0] === "git" && call[1] === "commit")).toBe(false);
  });

  it("fail-closes when the maker model cannot produce Qwen3-<digits>", async () => {
    const worktreeCwd = mkWorktree();
    const result = await executeDeliveryHook({
      ...quantumBase,
      model: "sovereign-gpt-5",
      worktreeCwd,
      runProc: mkRunProc({ "git status --porcelain": { exitCode: 0, stdout: " M src/hook.ts\n" } }),
    });
    expect(result.reason).toBe("delivery_blocked: missing_quantum_maker_model");
  });

  it("fail-closes when only a Paperclip QUA-* id exists (no GitHub number)", async () => {
    isolateIssueEnv();
    const worktreeCwd = mkWorktree();
    const result = await executeDeliveryHook({
      ...quantumBase,
      env: {},
      worktreeCwd,
      runProc: mkRunProc({ "git status --porcelain": { exitCode: 0, stdout: " M src/hook.ts\n" } }),
    });
    expect(result.reason).toBe("delivery_blocked: missing_github_issue_number_for_closes");
  });

  it("recovers Closes #n from PAPERCLIP_ISSUE_TITLE instead of inventing a QUA-* number", async () => {
    isolateIssueEnv();
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/2\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({
      ...quantumBase,
      env: { PAPERCLIP_ISSUE_TITLE: "fix(api): foo #1894" },
      worktreeCwd,
      runProc,
    });
    expect(result.reason).toBe("created");
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    const body = createCall?.[createCall.indexOf("--body") + 1] ?? "";
    expect(body).toMatch(/^Closes #1894$/m);
    expect(body).not.toMatch(/Closes #21\b/);
  });

  it("uses the current issue title instead of a leftover env Closes number", async () => {
    isolateIssueEnv();
    process.env["PAPERCLIP_ISSUE_TITLE"] = "stale leftover Closes #9999";
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/3\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const staleClosed = await executeConfiguredDeliveryHook({
      ...quantumBase,
      worktreeCwd,
      branch: "feat/agent-agent-1-ticket-qua-99-delivery",
      env: { PAPERCLIP_ISSUE_TITLE: "stale leftover Closes #9999" },
      config: { deliveryRepo: "Beyn-SOLIDUS/quantum", deliveryBaseBranch: "main" },
      context: {
        identifier: "QUA-99",
        issueId: "issue-uuid",
        paperclipIssue: {
          id: "issue-uuid",
          identifier: "QUA-99",
          title: "current issue with no github number",
          description: "",
        },
      },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
    });
    expect(staleClosed?.reason).toBe("delivery_blocked: missing_github_issue_number_for_closes");

    const recovered = await executeConfiguredDeliveryHook({
      ...quantumBase,
      worktreeCwd,
      branch: "feat/agent-agent-1-ticket-qua-99-delivery",
      env: { PAPERCLIP_ISSUE_TITLE: "stale leftover Closes #9999" },
      config: { deliveryRepo: "Beyn-SOLIDUS/quantum", deliveryBaseBranch: "main" },
      context: {
        identifier: "QUA-99",
        issueId: "issue-uuid",
        paperclipIssue: {
          id: "issue-uuid",
          identifier: "QUA-99",
          title: "fix(api): foo #1894",
        },
      },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
    });
    expect(recovered?.reason).toBe("created");
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    const body = createCall?.[createCall.indexOf("--body") + 1] ?? "";
    expect(body).toMatch(/^Closes #1894$/m);
    expect(body).not.toMatch(/Closes #9999\b/);
  });

  it("does not close a leftover process.env GitHub number copied into the run env", async () => {
    isolateIssueEnv();
    process.env["PAPERCLIP_GITHUB_ISSUE_NUMBER"] = "9999";
    const worktreeCwd = mkWorktree();
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (key === "gh pr create") return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/4\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const leftoverCopied = await executeConfiguredDeliveryHook({
      ...quantumBase,
      worktreeCwd,
      branch: "feat/agent-agent-1-ticket-qua-99-delivery",
      env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "9999" },
      config: { deliveryRepo: "Beyn-SOLIDUS/quantum", deliveryBaseBranch: "main" },
      context: {
        identifier: "QUA-99",
        issueId: "issue-uuid",
        paperclipIssue: {
          id: "issue-uuid",
          identifier: "QUA-99",
          title: "current issue with no github number",
          description: "",
        },
      },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
    });
    expect(leftoverCopied?.reason).toBe("delivery_blocked: missing_github_issue_number_for_closes");

    const recovered = await executeConfiguredDeliveryHook({
      ...quantumBase,
      worktreeCwd,
      branch: "feat/agent-agent-1-ticket-qua-99-delivery",
      env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "9999" },
      config: { deliveryRepo: "Beyn-SOLIDUS/quantum", deliveryBaseBranch: "main" },
      context: {
        identifier: "QUA-99",
        issueId: "issue-uuid",
        paperclipIssue: {
          id: "issue-uuid",
          identifier: "QUA-99",
          title: "fix(api): foo #1894",
        },
      },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
    });
    expect(recovered?.reason).toBe("created");
    const createCall = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    const body = createCall?.[createCall.indexOf("--body") + 1] ?? "";
    expect(body).toMatch(/^Closes #1894$/m);
    expect(body).not.toMatch(/Closes #9999\b/);
  });

  it("blocks a docs: title when non-doc files are in the diff", async () => {
    const title = deriveQuantumDeliveryTitle({
      issueIdentifier: "QUA-99",
      changedPaths: ["README.md", "src/a.ts", "src/b.ts"],
      makerToken: "Qwen3-30B",
    });
    expect(title.startsWith("docs:")).toBe(false);
    expect(title.startsWith("feat:")).toBe(true);
  });

  it("prefers scripts/agent-pr-create.sh and does not fall back to gh pr create", async () => {
    const worktreeCwd = mkWorktree();
    const wrapper = path.join(worktreeCwd, "scripts", "agent-pr-create.sh");
    mkdirSync(path.join(worktreeCwd, "scripts"), { recursive: true });
    writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(wrapper, 0o755);
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === wrapper) return { exitCode: 0, stdout: "https://github.com/Beyn-SOLIDUS/quantum/pull/9\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({ ...quantumBase, worktreeCwd, runProc });
    expect(result).toEqual({
      delivered: true,
      prUrl: "https://github.com/Beyn-SOLIDUS/quantum/pull/9",
      reason: "created",
    });
    expect(calls.some((call) => call[0] === wrapper && call.includes("--title"))).toBe(true);
    expect(calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create")).toBe(false);
  });

  it("fail-closes when the Quantum wrapper fails instead of using raw gh pr create", async () => {
    const worktreeCwd = mkWorktree();
    const wrapper = path.join(worktreeCwd, "scripts", "agent-pr-create.sh");
    mkdirSync(path.join(worktreeCwd, "scripts"), { recursive: true });
    writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(wrapper, 0o755);
    const calls: string[][] = [];
    const runProc = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (key === "git status --porcelain") return { exitCode: 0, stdout: " M src/hook.ts\n", stderr: "" };
      if (key === "gh pr list") return { exitCode: 0, stdout: "", stderr: "" };
      if (key === "gh label list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === wrapper) return { exitCode: 2, stdout: "", stderr: "wrapper rejected" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await executeDeliveryHook({ ...quantumBase, worktreeCwd, runProc });
    expect(result.reason).toBe("delivery_blocked: quantum_pr_wrapper_failed");
    expect(calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create")).toBe(false);
  });

  it("does not apply Quantum fail-closed gates to other repos", async () => {
    const worktreeCwd = mkWorktree();
    const runProc = mkRunProc({
      "git status --porcelain": { exitCode: 0, stdout: " M a.ts\n M b.ts\n M c.ts\n M d.ts\n M e.ts\n" },
      "gh pr create": { exitCode: 0, stdout: "https://github.com/paperclipai/paperclip/pull/1\n" },
    });
    const result = await executeDeliveryHook({
      ...quantumBase,
      repo: "paperclipai/paperclip",
      branch: "paperclip/HAS-222-r1",
      model: "sovereign-gpt-5",
      env: {},
      worktreeCwd,
      runProc,
    });
    expect(result.reason).toBe("created");
  });
});
