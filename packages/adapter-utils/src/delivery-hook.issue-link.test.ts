import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeConfiguredDeliveryHook,
  executeDeliveryHook,
  parseGithubIssueNumberFromText,
  resolveGithubIssueNumber,
  type DeliveryHookRunProcess,
} from "./delivery-hook.js";

const envKeys = [
  "PAPERCLIP_GITHUB_ISSUE_NUMBER",
  "PAPERCLIP_ISSUE_TITLE",
  "PAPERCLIP_ISSUE_DESCRIPTION",
  "PAPERCLIP_ISSUE_BODY",
] as const;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of envKeys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of envKeys) {
    const old = saved.get(key);
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
  saved.clear();
});

const parserCases: Array<[string, string | null, number | null]> = [
  [
    "mixed references",
    "Related #12; Closes #34",
    34
  ],
  [
    "closing before reference",
    "Closes #34; Related #12",
    34
  ],
  [
    "two closing targets",
    "Closes #12; Fixes #34",
    null
  ],
  [
    "two references",
    "Related #12 and #34",
    null
  ],
  [
    "same target repeated",
    "Closes #34; Fixes #34",
    34
  ],
  [
    "closing list",
    "Closes #12, #34",
    null
  ],
  [
    "simple closing",
    "Closes #1894",
    1894
  ],
  [
    "fixes",
    "Fixes #42 after review",
    42
  ],
  [
    "resolves",
    "Resolves #7",
    7
  ],
  [
    "case and colon",
    "CLOSES: #42",
    42
  ],
  [
    "legacy title",
    "fix(api): foo #1894",
    1894
  ],
  [
    "zero ignored outside closing",
    "See #0; Closes #1894",
    1894
  ],
  [
    "invalid closing",
    "Closes #0; Related #1894",
    null
  ],
  [
    "unsafe integer closing",
    "Closes #9007199254740992; Related #12",
    null
  ],
  [
    "max safe integer",
    "Closes #9007199254740991",
    9007199254740991
  ],
  [
    "foreign repository",
    "Closes other/project#42",
    null
  ],
  [
    "foreign repo then local",
    "Closes other/project#42; Related #12",
    null
  ],
  [
    "foreign repo and local closing",
    "Closes other/project#42; Fixes #12",
    null
  ],
  [
    "qualified URL",
    "Closes https://github.com/other/project/issues/42; Related #12",
    null
  ],
  [
    "qualified bare reference",
    "other/project#42",
    null
  ],
  [
    "malformed number",
    "Closes #42abc",
    null
  ],
  [
    "fractional number",
    "Closes #42.5",
    null
  ],
  [
    "no references",
    "No GitHub reference",
    null
  ],
  [
    "empty",
    "",
    null
  ],
  [
    "null",
    null,
    null
  ]
];

const resolverCases: Array<[string, { issueIdentifier?: string | null; env?: Record<string, string> }, number | null]> = [
  [
    "explicit priority",
    {
      "issueIdentifier": "QUA-21",
      "env": {
        "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894",
        "PAPERCLIP_ISSUE_TITLE": "Related to #42"
      }
    },
    1894
  ],
  [
    "across title and description",
    {
      "issueIdentifier": "QUA-21",
      "env": {
        "PAPERCLIP_ISSUE_TITLE": "Related #12",
        "PAPERCLIP_ISSUE_DESCRIPTION": "Closes #34"
      }
    },
    34
  ],
  [
    "closing conflict across fields",
    {
      "env": {
        "PAPERCLIP_ISSUE_TITLE": "Closes #12",
        "PAPERCLIP_ISSUE_DESCRIPTION": "Fixes #34"
      }
    },
    null
  ],
  [
    "body conflict cannot be hidden",
    {
      "env": {
        "PAPERCLIP_ISSUE_DESCRIPTION": "Closes #12",
        "PAPERCLIP_ISSUE_BODY": "Fixes #34"
      }
    },
    null
  ],
  [
    "bare conflict across fields",
    {
      "env": {
        "PAPERCLIP_ISSUE_TITLE": "Related #12",
        "PAPERCLIP_ISSUE_BODY": "See #34"
      }
    },
    null
  ],
  [
    "no conversion of QUA",
    {
      "issueIdentifier": "QUA-21",
      "env": {}
    },
    null
  ],
  [
    "no conversion of CBS",
    {
      "issueIdentifier": "CBS-21",
      "env": {}
    },
    null
  ],
  [
    "legacy numeric identifier",
    {
      "issueIdentifier": "222",
      "env": {}
    },
    222
  ],
  [
    "hash identifier",
    {
      "issueIdentifier": "#88",
      "env": {}
    },
    88
  ],
  [
    "body fallback",
    {
      "env": {
        "PAPERCLIP_ISSUE_BODY": "Fixes #9"
      }
    },
    9
  ],
  [
    "no process fallback",
    {
      "env": {}
    },
    null
  ],
  [
    "repeated across fields",
    {
      "env": {
        "PAPERCLIP_ISSUE_TITLE": "Closes #34",
        "PAPERCLIP_ISSUE_DESCRIPTION": "Fixes #34"
      }
    },
    34
  ]
];

const selectionCases: Array<[string, Record<string, string>, Record<string, unknown>, string | null, string | null]> = [
  [
    "explicit survives incident reference",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Related to #42"
      }
    },
    null,
    "1894"
  ],
  [
    "explicit survives stale host with another value",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Related to #42"
      }
    },
    "9999",
    "1894"
  ],
  [
    "explicit survives description hint",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "description": "Related #42"
      }
    },
    null,
    "1894"
  ],
  [
    "closing priority in wrapper",
    {},
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Related #12; Closes #34"
      }
    },
    null,
    "34"
  ],
  [
    "ambiguity blocked in wrapper",
    {},
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Closes #12; Fixes #34"
      }
    },
    null,
    null
  ],
  [
    "copied process number cleared",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "9999"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Current issue without a GitHub reference"
      }
    },
    "9999",
    null
  ],
  [
    "explicit current closing recovers after stale number",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "9999"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Closes #1894"
      }
    },
    "9999",
    "1894"
  ],
  [
    "old passed title cleared",
    {
      "PAPERCLIP_ISSUE_TITLE": "Closes #9999"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Current issue"
      }
    },
    null,
    null
  ],
  [
    "old description and body cleared",
    {
      "PAPERCLIP_ISSUE_DESCRIPTION": "Closes #9999",
      "PAPERCLIP_ISSUE_BODY": "Fixes #8888"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Current issue"
      }
    },
    null,
    null
  ],
  [
    "empty current issue clears text",
    {
      "PAPERCLIP_ISSUE_TITLE": "Closes #9999"
    },
    {
      "paperclipIssue": {}
    },
    null,
    null
  ],
  [
    "foreign closing blocked in wrapper",
    {},
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Closes other/project#42; Related #12"
      }
    },
    null,
    null
  ],
  [
    "same host number and incidental text do not retarget",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Related to #42"
      }
    },
    "1894",
    null
  ],
  [
    "stale number cannot be replaced by a bare title reference",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "9999"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "fix(api): foo #1894"
      }
    },
    "9999",
    null
  ],
  [
    "same number can be confirmed by explicit current closing",
    {
      "PAPERCLIP_GITHUB_ISSUE_NUMBER": "1894"
    },
    {
      "paperclipIssue": {
        "id": "issue-A",
        "identifier": "QUA-21",
        "title": "Closes #1894"
      }
    },
    "1894",
    "1894"
  ]
];

describe("GitHub close-target pilot regressions", () => {
  it.each(parserCases)("parser: %s", (_name, text, expected) => {
    expect(parseGithubIssueNumberFromText(text)).toBe(expected);
  });

  it.each(resolverCases)("resolver: %s", (_name, input, expected) => {
    process.env["PAPERCLIP_GITHUB_ISSUE_NUMBER"] = "9999";
    process.env["PAPERCLIP_ISSUE_TITLE"] = "Closes #9999";
    process.env["PAPERCLIP_ISSUE_DESCRIPTION"] = "Fixes #8888";
    process.env["PAPERCLIP_ISSUE_BODY"] = "Resolves #7777";
    expect(resolveGithubIssueNumber(input)).toBe(expected);
  });

  it.each(selectionCases)("configured hook: %s", async (_name, env, context, inherited, expected) => {
    if (inherited != null) process.env["PAPERCLIP_GITHUB_ISSUE_NUMBER"] = inherited;
    const envBefore = { ...env };
    let observed: Record<string, string> | undefined;
    const runProc: DeliveryHookRunProcess = vi.fn(async (_cmd, _args, _cwd, runEnv) => {
      observed = { ...runEnv };
      // Stop at the first git status: no filesystem, remote mutation or token is needed.
      return { exitCode: 1, stdout: "", stderr: "intentional test boundary" };
    });
    const result = await executeConfiguredDeliveryHook({
      runId: "pilot-run",
      worktreeCwd: "/unused-pilot-worktree",
      branch: "fix/issue-link-pilot",
      env,
      context,
      config: { deliveryRepo: "example/project", deliveryBaseBranch: "main" },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
      log: async () => {},
    });
    expect(runProc).toHaveBeenCalledTimes(1);
    expect(result?.reason).toBe("git_status_failed");
    expect(observed?.PAPERCLIP_GITHUB_ISSUE_NUMBER ?? null).toBe(expected);
    expect(env).toEqual(envBefore);
  });
});


// These tests cross the second resolution inside executeDeliveryHook.
// Subprocess calls are allowlisted read stubs; no real Git/GitHub write runs.
function closeTargetReadStubs() {
  const calls: string[][] = [];
  const runProc: DeliveryHookRunProcess = vi.fn(async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "status") {
      return { exitCode: 0, stdout: " M src/example.ts\n", stderr: "" };
    }
    if (cmd === "git" && args[0] === "grep") {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { exitCode: 0, stdout: "src/example.ts\n", stderr: "" };
    }
    if (cmd === "git" && (args[0] === "config" || args[0] === "ls-remote")) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      return { exitCode: 0, stdout: args.includes("--jq") ? "" : "[]", stderr: "" };
    }
    throw new Error(`Unexpected subprocess in close-target regression: ${cmd} ${args.join(" ")}`);
  });
  return { runProc, calls };
}

const closeTargetBase = {
  runId: "issue-link-boundary-test",
  worktreeCwd: "/unused-issue-link-boundary",
  branch: "fix/paperclip-issue-link-boundary",
  issueIdentifier: "QUA-21",
  issueId: "issue-A",
  repo: "Beyn-SOLIDUS/quantum",
  baseBranch: "main",
  model: "qwen3-coder-30b-sovereign",
  env: {
    PAPERCLIP_AUTONOMOUS_DELIVERY: "false",
    PAPERCLIP_DELIVERY_LANE: "dev-test",
    PAPERCLIP_DELIVERY_BRANCH_CONVENTION: "quantum",
  },
  log: async () => {},
};

describe("authoritative close-target handoff", () => {
  it.each([
    ["1894", "Related to #42"],
    ["9999", "fix(api): foo #1894"],
  ])("does not recover a new target after rejecting inherited %s", async (inherited, title) => {
    process.env["PAPERCLIP_GITHUB_ISSUE_NUMBER"] = inherited;
    const { runProc, calls } = closeTargetReadStubs();
    const result = await executeConfiguredDeliveryHook({
      ...closeTargetBase,
      env: { ...closeTargetBase.env, PAPERCLIP_GITHUB_ISSUE_NUMBER: inherited },
      config: { deliveryRepo: closeTargetBase.repo, deliveryBaseBranch: "main" },
      context: { paperclipIssue: { id: "issue-A", identifier: "QUA-21", title } },
      executionTargetIsRemote: false,
      exitCode: 0,
      runProc,
    });
    expect(calls.some((call) => call[0] === "git" && call[1] === "diff")).toBe(true);
    expect(result).toEqual({
      delivered: false,
      prUrl: null,
      reason: "delivery_blocked: missing_github_issue_number_for_closes",
    });
  });

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "does not replace rejected decision %s using otherwise valid env/text",
    async (resolvedGithubIssueNumber) => {
      const { runProc } = closeTargetReadStubs();
      const result = await executeDeliveryHook({
        ...closeTargetBase,
        env: {
          ...closeTargetBase.env,
          PAPERCLIP_GITHUB_ISSUE_NUMBER: "1894",
          PAPERCLIP_ISSUE_TITLE: "Closes #1894",
        },
        resolvedGithubIssueNumber,
        runProc,
      });
      expect(result.reason).toBe("delivery_blocked: missing_github_issue_number_for_closes");
    },
  );
});
