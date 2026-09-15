import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeliveryLogRedactor, executeDeliveryHook, type DeliveryHookRunProcess } from "./delivery-hook.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const prUrl = "https://github.com/Beyn-SOLIDUS/quantum/pull/3372";

function fixture(options: {
  wrapper?: boolean; stdout?: string; exitCode?: number; clean?: boolean;
  existing?: boolean; existingBranch?: string; issuePrUrl?: string;
  qualityFailure?: boolean; signature?: string; diff?: string; diffExitCode?: number;
  wrapperAfterCheckout?: boolean; statusAfterCheckout?: string;
  mutateWrapperDuringQuality?: boolean;
  beforeCommand?: (cmd: string, env: Record<string, string>) => void | Promise<void>;
} = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "quantum-wrapper-contract-"));
  roots.push(cwd);
  writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: {
    typecheck: "check-types", lint: "lint", test: "test", "check:tokens": "secrets",
  } }));
  const wrapper = path.join(cwd, "scripts", "agent-pr-create.sh");
  if (options.wrapper !== false) {
    mkdirSync(path.dirname(wrapper));
    writeFileSync(wrapper, "#!/bin/sh\n");
    chmodSync(wrapper, 0o755);
  }
  const calls: string[][] = [];
  const commandEnvs: { cmd: string; env: Record<string, string> }[] = [];
  let checkedOut = false;
  let wrapperModified = false;
  const runProc: DeliveryHookRunProcess = vi.fn(async (cmd, args, _cwd, env) => {
    await options.beforeCommand?.(cmd, env);
    calls.push([cmd, ...args]);
    commandEnvs.push({ cmd, env });
    if (cmd === "git" && args[0] === "checkout") {
      checkedOut = true;
      if (options.wrapperAfterCheckout === true) {
        mkdirSync(path.dirname(wrapper), { recursive: true });
        writeFileSync(wrapper, "#!/bin/sh\n");
        chmodSync(wrapper, 0o755);
      } else if (options.wrapperAfterCheckout === false) {
        rmSync(wrapper, { force: true });
      }
    }
    if (cmd === wrapper) return {
      exitCode: options.exitCode ?? 0,
      stdout: options.stdout ?? `result=created pr_url=${prUrl}\n`,
      stderr: options.exitCode ? "ERROR (CF-014 pr_too_large): split this PR" : "",
    };
    if (cmd === "pnpm" && options.mutateWrapperDuringQuality) {
      writeFileSync(wrapper, "#!/bin/sh\necho forged\n");
      wrapperModified = true;
    }
    if (cmd === "pnpm" && options.qualityFailure) return { exitCode: 1, stdout: "", stderr: "test failed" };
    let stdout = "";
    if (cmd === "git" && args[0] === "log") stdout = options.signature ?? "N\n";
    if (cmd === "git" && args[0] === "status") stdout = checkedOut && options.statusAfterCheckout !== undefined
      ? options.statusAfterCheckout : options.clean ? "" : " M src/fix.ts\n";
    if (cmd === "git" && args[0] === "diff") return {
      exitCode: wrapperModified && args[1] === "--quiet" ? 1 : options.diffExitCode ?? 0,
      stdout: options.diff ?? "src/fix.ts\n", stderr: "",
    };
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      stdout = args.includes("--head")
        ? (options.existing && (!options.existingBranch || args[args.indexOf("--head") + 1] === options.existingBranch) ? prUrl : "")
        : (options.issuePrUrl ? JSON.stringify([{ url: options.issuePrUrl, state: "OPEN", title: "fix: QUA-99" }]) : "[]");
    }
    if (cmd === "gh" && args[0] === "label") stdout = "[]";
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") stdout = prUrl;
    return { exitCode: 0, stdout, stderr: "" };
  });
  return {
    wrapper, calls, commandEnvs,
    input: {
      runId: "run-1", worktreeCwd: cwd, branch: "feat/agent-Quantum-CTO-ticket-qua-99-delivery",
      env: { PAPERCLIP_GITHUB_ISSUE_NUMBER: "3135" }, issueIdentifier: "QUA-99", issueId: "issue-1",
      repo: "Beyn-SOLIDUS/quantum", baseBranch: "main", agentId: "Quantum-CTO",
      model: "qwen3-coder-30b-sovereign", runProc, log: vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {}),
    },
  };
}

function expectNoExternalDelivery(calls: string[][]) {
  expect(calls.some(([cmd, sub]) => cmd === "git" && sub === "push")).toBe(false);
  expect(calls.some(([cmd, sub, action]) => cmd === "gh" && sub === "pr" && ["create", "merge", "edit"].includes(action))).toBe(false);
}

describe("rotating autonomous delivery credentials", () => {
  const tokenA = `ghs_${"fixture_A".repeat(4)}`;
  const tokenB = `ghs_${"fixture_B".repeat(4)}`;
  function publish(file: string, token: string, remaining = 3600_000) {
    writeFileSync(`${file}.next`, JSON.stringify({ token, repository: "Beyn-SOLIDUS/quantum",
      expires_at: new Date(Date.now() + remaining).toISOString() }), { mode: 0o640 });
    renameSync(`${file}.next`, file);
  }
  function deliveryEnv(file: string) {
    return { PAPERCLIP_AUTONOMOUS_DELIVERY: "1", PAPERCLIP_DELIVERY_SIGN_COMMITS: "1", PAPERCLIP_DELIVERY_BOT_TOKEN_FILE: file,
      PAPERCLIP_DELIVERY_BOT_TOKEN: "stale-startup-token", GH_TOKEN: "operator-pat", GITHUB_TOKEN: "operator-pat" };
  }

  it("uses the new token after quality gates, including the mandatory wrapper", async () => {
    let file: string;
    const f = fixture({ signature: "G\n", beforeCommand: (cmd) => { if (cmd === "pnpm") publish(file, tokenB); } });
    file = path.join(f.input.worktreeCwd, "delivery-token.json");
    publish(file, tokenA);
    const env = { ...f.input.env, ...deliveryEnv(file) };
    const result = await executeDeliveryHook({ ...f.input, env });
    expect(result).toMatchObject({ delivered: true, prUrl });
    expect(f.commandEnvs.find(({ cmd }) => cmd === "gh")?.env.GH_TOKEN).toBe(tokenA);
    expect(f.commandEnvs.find(({ cmd }) => cmd === f.wrapper)?.env).toMatchObject({
      GH_TOKEN: tokenB, GITHUB_TOKEN: tokenB, PAPERCLIP_DELIVERY_BOT_TOKEN: tokenB,
    });
    for (const { env: gateEnv } of f.commandEnvs.filter(({ cmd }) => cmd === "pnpm")) {
      expect(Object.keys(gateEnv).filter((key) => /TOKEN/.test(key))).toEqual([]);
    }
    expect(env.GH_TOKEN).toBe("operator-pat");
    expect(env.PAPERCLIP_DELIVERY_BOT_TOKEN).toBe("stale-startup-token");
    expectNoExternalDelivery(f.calls);
  });

  it("blocks on a configured missing file without falling back to a valid PAT", async () => {
    const f = fixture();
    const file = path.join(f.input.worktreeCwd, "missing-token.json");
    expect(await executeDeliveryHook({ ...f.input, env: { ...f.input.env, ...deliveryEnv(file) } }))
      .toMatchObject({ delivered: false, reason: "delivery_blocked: bot_token_file_unreadable" });
    expect(f.calls.some(([cmd]) => cmd === "gh" || cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("stops before the wrapper when renewal fails during quality gates", async () => {
    let file: string;
    const f = fixture({ signature: "G\n", beforeCommand: (cmd) => { if (cmd === "pnpm") publish(file, tokenA, -1000); } });
    file = path.join(f.input.worktreeCwd, "delivery-token.json");
    publish(file, tokenA);
    expect(await executeDeliveryHook({ ...f.input, env: { ...f.input.env, ...deliveryEnv(file) } }))
      .toMatchObject({ delivered: false });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("leaves manual delivery credentials alone even with an unavailable file", async () => {
    const f = fixture();
    const env = { ...f.input.env, ...deliveryEnv("/unavailable/token.json"), PAPERCLIP_AUTONOMOUS_DELIVERY: "0" };
    expect(await executeDeliveryHook({ ...f.input, env })).toMatchObject({ delivered: true });
    expect(f.commandEnvs.find(({ cmd }) => cmd === f.wrapper)?.env.GH_TOKEN).toBe("operator-pat");
  });

  it("redacts a newly loaded token in adapter streams and returned hook diagnostics", async () => {
    const f = fixture({ exitCode: 1, signature: "G\n" });
    const file = path.join(f.input.worktreeCwd, "delivery-token.json");
    publish(file, tokenB);
    const env = { ...f.input.env, ...deliveryEnv(file) };
    const chunks: string[] = [];
    const log = createDeliveryLogRedactor(env, async (_stream, chunk) => { chunks.push(chunk); });
    const runProc: DeliveryHookRunProcess = async (cmd, args, cwd, commandEnv) => {
      const result = await f.input.runProc(cmd, args, cwd, commandEnv);
      if (cmd !== f.wrapper) return result;
      // Same per-command redactor used by the local adapters.
      await createDeliveryLogRedactor(commandEnv, log)("stderr", `streamed ${commandEnv.GH_TOKEN}\n`);
      return { ...result, stderr: `ERROR (CF-000 fixture): ${commandEnv.GH_TOKEN}` };
    };
    expect(await executeDeliveryHook({ ...f.input, env, runProc, log })).toMatchObject({ delivered: false });
    expect(chunks.join("")).toContain("[REDACTED]");
    expect(chunks.join("")).not.toContain(tokenB);
    expect(chunks.join("")).toContain("CF-000");
  });
});

describe("Quantum wrapper owns remote delivery", () => {
  it("refuses a missing wrapper before commit, push or raw PR creation", async () => {
    const f = fixture({ wrapper: false });
    const result = await executeDeliveryHook(f.input);
    expect(result).toMatchObject({ delivered: false, prUrl: null, reason: "delivery_blocked: quantum_pr_wrapper_missing" });
    expectNoExternalDelivery(f.calls);
    expect(f.calls.some(([cmd, ...args]) => cmd === "git" && args.includes("commit"))).toBe(false);
  });

  it("does not push before a wrapper refusal and preserves its CF reason", async () => {
    const f = fixture({ exitCode: 14 });
    const result = await executeDeliveryHook(f.input);
    expect(result.delivered).toBe(false);
    expectNoExternalDelivery(f.calls);
    expect(f.input.log.mock.calls.map(([, text]) => text).join("")).toContain("CF-014");
  });

  it("revalidates the wrapper after quality scripts before executing it", async () => {
    const f = fixture({ mutateWrapperDuringQuality: true });
    const result = await executeDeliveryHook(f.input);
    expect(result).toMatchObject({ delivered: false, reason: "delivery_blocked: quantum_pr_wrapper_changed" });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(0);
    expectNoExternalDelivery(f.calls);
  });

  it.each(["created", "exists", "updated"])("accepts the wrapper's structured %s result without another push", async (outcome) => {
    const f = fixture({ stdout: `result=${outcome} pr_url=${prUrl}\n` });
    const result = await executeDeliveryHook(f.input);
    expect(result).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });

  it.each([
    "", prUrl, `see ${prUrl}`, "result=created pr_url=null",
    "result=created pr_url=https://github.com/other/repo/pull/1",
    `result=created pr_url=${prUrl}?untrusted=1`,
    `result=created pr_url=${prUrl}\nresult=exists pr_url=${prUrl}`,
    `result=created pr_url=${prUrl}\nresult=blocked reason=guard`,
    `result=created pr_url=${prUrl}\nresult=created pr_url=null`,
    `result=created pr_url=${prUrl}\n  result=blocked`,
  ])("refuses incomplete or ambiguous wrapper evidence: %s", async (stdout) => {
    const f = fixture({ stdout });
    const result = await executeDeliveryHook(f.input);
    expect(result.delivered).toBe(false);
    expect(result.prUrl).toBeNull();
    expectNoExternalDelivery(f.calls);
  });

  it("delivers already committed changes from a clean working tree", async () => {
    const f = fixture({ clean: true });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });

  it("returns no_diff for a clean branch with no committed change and no PR", async () => {
    const f = fixture({ clean: true, diff: "" });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: false, prUrl: null, reason: "no_diff" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("refreshes an existing PR even when the branch has no pending diff", async () => {
    const f = fixture({ clean: true, diff: "", existing: true, issuePrUrl: prUrl, stdout: `result=updated pr_url=${prUrl}\n` });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });

  it("refuses delivery when the branch diff cannot be read", async () => {
    const f = fixture({ clean: true, diff: "", diffExitCode: 128 });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: false, reason: "delivery_blocked: quantum_branch_diff_unreadable" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("looks up the selected canonical branch before accepting an issue PR", async () => {
    const oldBranch = "codex/QUA-99-work";
    const f = fixture({ existing: true, existingBranch: oldBranch, issuePrUrl: prUrl });
    expect(await executeDeliveryHook({ ...f.input, branch: oldBranch })).toMatchObject({
      delivered: false, reason: "delivery_blocked: quantum_issue_pr_on_other_branch",
    });
    const lookup = f.calls.find(([cmd, sub, action, ...args]) => cmd === "gh" && sub === "pr" && action === "list" && args.includes("--head"));
    expect(lookup).toContain("feat/agent-quantum-cto-ticket-qua-99-delivery");
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("finds a wrapper introduced by the canonical branch checkout", async () => {
    const f = fixture({ wrapper: false, wrapperAfterCheckout: true });
    expect(await executeDeliveryHook({ ...f.input, branch: "codex/QUA-99-work" })).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });

  it("refuses a wrapper removed by the canonical branch checkout", async () => {
    const f = fixture({ wrapperAfterCheckout: false });
    expect(await executeDeliveryHook({ ...f.input, branch: "codex/QUA-99-work" })).toMatchObject({
      delivered: false, reason: "delivery_blocked: quantum_pr_wrapper_missing",
    });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("checks the working tree selected by canonical branch checkout", async () => {
    const f = fixture({ clean: true, statusAfterCheckout: "UU src/fix.ts\n" });
    expect(await executeDeliveryHook({ ...f.input, branch: "codex/QUA-99-work" })).toMatchObject({ delivered: false, reason: "conflict" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("keeps the quality gate for already committed changes", async () => {
    const f = fixture({ clean: true, qualityFailure: true });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: false, reason: "delivery_blocked" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("refuses an unsigned existing commit in the autonomous lane before invoking the wrapper", async () => {
    const f = fixture({ clean: true });
    expect(await executeDeliveryHook({ ...f.input, env: {
      ...f.input.env, PAPERCLIP_AUTONOMOUS_DELIVERY: "1",
      PAPERCLIP_DELIVERY_BOT_TOKEN: "test-bot-token", PAPERCLIP_DELIVERY_SIGN_COMMITS: "1",
    } })).toMatchObject({ delivered: false, reason: "delivery_blocked: unsigned commit" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("refuses to claim another branch's open PR as this run's delivery", async () => {
    const f = fixture({ issuePrUrl: prUrl });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: false, reason: "delivery_blocked: quantum_issue_pr_on_other_branch" });
    expect(f.calls.some(([cmd]) => cmd === f.wrapper)).toBe(false);
    expectNoExternalDelivery(f.calls);
  });

  it("refreshes the current branch even when the issue lookup also finds its PR", async () => {
    const f = fixture({ existing: true, issuePrUrl: prUrl });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });

  it("refreshes an existing PR through the wrapper instead of declaring dirty work delivered", async () => {
    const f = fixture({ existing: true, stdout: `result=updated pr_url=${prUrl}\n` });
    expect(await executeDeliveryHook(f.input)).toMatchObject({ delivered: true, prUrl });
    expect(f.calls.filter(([cmd]) => cmd === f.wrapper)).toHaveLength(1);
    expectNoExternalDelivery(f.calls);
  });
});
