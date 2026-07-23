import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import http from "node:http";

/**
 * E2E: Delivery hook → PR creation flow.
 *
 * ## Architectural context (why most tests are skipped)
 *
 * The Paperclip delivery hook (`executeConfiguredDeliveryHook`) is invoked
 * **inside the adapter process** at the end of a successful agent execution run
 * (see `packages/adapters/codex-local/src/server/execute.ts:852`).
 *
 * The hook performs four sequential operations:
 *   1. `git status --porcelain` — detect changes
 *   2. Quality gate (pnpm typecheck/lint/test/secret-scan)
 *   3. `git push -u origin <branch>`
 *   4. `gh pr create` — open a GitHub PR
 *
 * There is **no Paperclip HTTP endpoint** that triggers the delivery hook.
 * The hook runs as part of adapter execution, which requires:
 *   - A live adapter process (codex-local, claude-local, etc.)
 *   - A real or stubbed git worktree
 *   - A real or mocked `gh` / `git` binary reachable from the adapter process
 *
 * Intercepting GitHub API calls via Playwright `page.route()` would only
 * intercept calls made from the **browser** — not from the Node.js adapter
 * process running server-side.
 *
 * ## What this suite validates
 *
 * The tests that CAN run without a live adapter:
 *   - Paperclip API lifecycle: create company → create agent → create issue →
 *     checkout → mark done (status: "done")
 *   - Issue state after done: verifies the API returns `status: "done"`
 *   - Delivery env flag semantics: PAPERCLIP_DELIVERY_LANE=disabled is an
 *     env var consumed by the adapter hook, not by the server API. This
 *     suite confirms the server API is unaffected by that flag.
 *
 * The tests that require a live adapter + mock git/gh (skipped with explanation):
 *   - Full delivery lifecycle: branch push → PR creation → prUrl in issue
 *   - Mock GitHub HTTP server: intercept gh CLI calls via http_proxy
 *
 * ## Future work to make the skipped tests runnable
 *
 * To activate the skipped tests, the adapter needs a `runProc` override
 * injected via the Paperclip server's agent config (adapterConfig.deliveryEnv
 * or a test-only hook). Alternatively, a thin "delivery API" endpoint on the
 * server could accept delivery results and persist prUrl, making E2E possible.
 * Track in: https://github.com/haykel1977/paperclip/issues (TODO: open issue)
 *
 * Requires local_trusted deployment mode (set in playwright-delivery.config.ts).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3205);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SUITE_NAME = `E2E-Delivery-${Date.now()}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface DeliveryTestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function invokeHeartbeat(board: APIRequestContext, agentId: string): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`);
  expect(res.ok(), `heartbeat/invoke failed: ${res.status()}`).toBe(true);
  const run = await res.json() as { id: string };
  return run.id;
}

async function setupDeliveryCompany(boardRequest: APIRequestContext): Promise<DeliveryTestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json() as { deploymentMode: string };
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Delivery e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use playwright-delivery.config.ts.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: SUITE_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json() as { id: string; issuePrefix?: string; prefix?: string; urlKey?: string };
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Create executor agent
  const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
    data: {
      name: "DeliveryExecutor",
      role: "engineer",
      title: "Software Engineer",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('done\\n')"],
      },
    },
  });
  expect(agentRes.ok(), `agent-hires failed: ${agentRes.status()}`).toBe(true);
  const hire = await agentRes.json() as { agent: { id: string }; approval?: { id: string } };
  const agent = hire.agent;

  if (hire.approval) {
    const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
      data: { decisionNote: "Approved for delivery e2e setup." },
    });
    expect(approvalRes.ok()).toBe(true);
  }

  const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
    data: { name: "e2e-delivery-executor" },
  });
  expect(keyRes.ok()).toBe(true);
  const keyData = await keyRes.json() as { token: string; id: string };

  const executor: AgentAuth = {
    agentId: agent.id,
    token: keyData.token,
    keyId: keyData.id,
    request: await createAgentRequest(keyData.token),
  };

  return { companyId, companyPrefix, executor, boardRequest, issueIds: [] };
}

async function createIssue(ctx: DeliveryTestContext, title: string): Promise<{ id: string; identifier: string }> {
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
    },
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json() as { id: string; identifier: string };
  ctx.issueIds.push(issue.id);
  return issue;
}

/**
 * Checkout an issue as an agent and return the run ID to use for subsequent PATCHes.
 *
 * If checkout returns 409 (conflict), the issue already has a locked executionRunId
 * (e.g. auto-set when the issue was created as in_progress). In that case we read
 * the existing run lock from the issue and use it directly — same pattern as
 * agentCheckoutAndPatch in signoff-policy.spec.ts.
 */
async function checkoutIssue(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
): Promise<string> {
  const runId = await invokeHeartbeat(board, agent.agentId);
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses: ["in_progress"] },
  });
  if (checkoutRes.ok()) {
    return runId;
  }
  if (checkoutRes.status() === 409) {
    // Issue is already locked by a prior run (e.g. auto-set on creation).
    // Read the existing lock and reuse that run ID.
    const lockRes = await board.get(`${BASE_URL}/api/issues/${issueId}`);
    expect(lockRes.ok(), `GET issue failed: ${lockRes.status()}`).toBe(true);
    const lock = await lockRes.json() as {
      assigneeAgentId: string | null;
      checkoutRunId: string | null;
      executionRunId: string | null;
    };
    const lockedRunId = lock.checkoutRunId ?? lock.executionRunId;
    if (lockedRunId && lock.assigneeAgentId === agent.agentId) {
      return lockedRunId;
    }
  }
  // Fall back: board checkout (permissive — local_trusted mode)
  const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    data: { agentId: agent.agentId, expectedStatuses: ["in_progress"] },
  });
  if (!boardCheckout.ok()) {
    // If the issue is already locked to our agent, read and reuse the locked run ID
    const lockRes = await board.get(`${BASE_URL}/api/issues/${issueId}`);
    if (lockRes.ok()) {
      const lock = await lockRes.json() as {
        assigneeAgentId: string | null;
        checkoutRunId: string | null;
        executionRunId: string | null;
      };
      const lockedRunId = lock.checkoutRunId ?? lock.executionRunId;
      if (lockedRunId && lock.assigneeAgentId === agent.agentId) {
        return lockedRunId;
      }
    }
    throw new Error(`checkout failed: ${await boardCheckout.text()}`);
  }
  return runId;
}

// ---------------------------------------------------------------------------
// Mock GitHub HTTP server (for adapter-side use via http_proxy — not used in
// current Playwright intercept approach, but ready as a utility if the adapter
// ever supports an http_proxy override for its runProc calls).
// ---------------------------------------------------------------------------

interface MockGitHubServer {
  baseUrl: string;
  calls: Array<{ method: string; path: string; body: string }>;
  close: () => Promise<void>;
}

function startMockGitHubServer(): Promise<MockGitHubServer> {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      calls.push({ method: req.method ?? "GET", path: req.url ?? "/", body });
      // Simulate GitHub API responses for routes the delivery hook calls
      const url = req.url ?? "/";
      if (url.includes("/pulls") && req.method === "POST") {
        // gh pr create → respond with PR URL
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          html_url: "https://github.com/test-org/test-repo/pull/1",
          number: 1,
        }));
      } else if (url.includes("/pulls") && req.method === "GET") {
        // gh pr list → empty list
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      } else if (url.includes("/labels")) {
        // gh label list → empty
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((r, e) => server.close((err?: Error) => (err ? e(err) : r()))),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Delivery hook → PR creation", () => {
  let ctx: DeliveryTestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupDeliveryCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    await ctx.executor.request.dispose();

    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E delivery test cleanup." },
      }).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/agents/${ctx.executor.agentId}/keys/${ctx.executor.keyId}`).catch(() => {});
    await board.delete(`${BASE_URL}/api/agents/${ctx.executor.agentId}`).catch(() => {});
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  // ── Runnable: Paperclip API lifecycle ──────────────────────────────────

  test("API lifecycle: create issue → checkout → mark done", async () => {
    const issue = await createIssue(ctx, "Delivery lifecycle: mark done");
    const issueId = issue.id;

    // Step 1: Checkout
    const runId = await checkoutIssue(ctx.boardRequest, ctx.executor, issueId);

    // Step 2: Mark done as executor
    const patchRes = await ctx.executor.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: { status: "done", comment: "Implementation complete." },
    });
    expect(patchRes.ok(), `PATCH issue failed: ${patchRes.status()}`).toBe(true);
    const doneIssue = await patchRes.json() as { status: string };
    expect(doneIssue.status).toBe("done");
  });

  test("API lifecycle: issue details available after done", async () => {
    const issue = await createIssue(ctx, "Delivery lifecycle: verify details");
    const issueId = issue.id;

    const runId = await checkoutIssue(ctx.boardRequest, ctx.executor, issueId);
    const patchRes = await ctx.executor.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: { status: "done", comment: "Done. Ready for delivery." },
    });
    expect(patchRes.ok()).toBe(true);

    // Verify via GET that the issue is retrievable and has expected shape
    const getRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    expect(getRes.ok()).toBe(true);
    const fetched = await getRes.json() as { id: string; status: string };
    expect(fetched.id).toBe(issueId);
    expect(fetched.status).toBe("done");
  });

  test("PAPERCLIP_DELIVERY_LANE=disabled has no effect on server API", async () => {
    /**
     * PAPERCLIP_DELIVERY_LANE is consumed by the adapter-side delivery hook,
     * not by the server API. Marking an issue done with the server API must
     * succeed regardless of this env variable. This test confirms the server
     * API is decoupled from the delivery lane flag.
     */
    const issue = await createIssue(ctx, "Delivery lane flag: server API isolation");
    const issueId = issue.id;

    const runId = await checkoutIssue(ctx.boardRequest, ctx.executor, issueId);
    const patchRes = await ctx.executor.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: { status: "done", comment: "Done. Lane flag does not affect server API." },
    });
    expect(patchRes.ok()).toBe(true);
    const doneIssue = await patchRes.json() as { status: string };
    expect(doneIssue.status).toBe("done");
  });

  test("mock GitHub HTTP server starts and responds correctly", async () => {
    /**
     * Validates that the mock GitHub HTTP server utility works correctly.
     * This server is the foundation for intercepting `gh` CLI calls via
     * HTTPS_PROXY / GH_HOST once the adapter supports a proxy override.
     */
    const mockServer = await startMockGitHubServer();
    try {
      // Simulate a call that `gh pr list` would make
      const listRes = await fetch(`${mockServer.baseUrl}/repos/test-org/test-repo/pulls?head=branch&state=open`);
      expect(listRes.ok).toBe(true);
      const listData = await listRes.json() as unknown[];
      expect(Array.isArray(listData)).toBe(true);

      // Simulate a call that `gh pr create` would make
      const createRes = await fetch(`${mockServer.baseUrl}/repos/test-org/test-repo/pulls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test PR", body: "Body", head: "branch", base: "main" }),
      });
      expect(createRes.ok).toBe(true);
      const pr = await createRes.json() as { html_url: string; number: number };
      expect(pr.html_url).toBe("https://github.com/test-org/test-repo/pull/1");
      expect(pr.number).toBe(1);

      expect(mockServer.calls).toHaveLength(2);
      expect(mockServer.calls[0]?.method).toBe("GET");
      expect(mockServer.calls[1]?.method).toBe("POST");
    } finally {
      await mockServer.close();
    }
  });

  // ── Skipped: adapter-side delivery hook ────────────────────────────────

  test.skip("full delivery: adapter runs → branch pushed → PR created → prUrl in issue", async () => {
    /**
     * SKIP REASON: The delivery hook runs inside the adapter process, not via
     * a server HTTP endpoint. To test this end-to-end, the test would need to:
     *
     *   1. Spawn a real adapter execution (codex-local, claude-local, etc.)
     *   2. Have the adapter process create a git commit in its worktree
     *   3. Intercept the adapter's `git push` and `gh pr create` calls
     *      (these are shell commands — Playwright page.route() cannot intercept them)
     *   4. Verify the prUrl is persisted back to the Paperclip issue
     *
     * Constraints:
     *   - Playwright `page.route()` only intercepts browser (fetch/XHR) calls.
     *   - The adapter spawns `git` and `gh` as child processes from Node.js.
     *   - Intercepting those requires either:
     *     a) A fake `git`/`gh` binary on PATH (complex, fragile)
     *     b) A HTTPS_PROXY pointing to the mock server (gh honors this)
     *     c) A server-side "delivery result" endpoint that adapters PATCH
     *        after delivery completes (architectural change needed)
     *
     * Current unit test coverage: packages/adapters/<adapter>/src/server/execute.delivery.test.ts
     * covers the delivery hook logic exhaustively with vi.fn() mocks for runProc.
     *
     * Activation path:
     *   - Add PATCH /api/runs/{runId}/delivery endpoint to persist prUrl
     *   - OR: inject a fake gh binary via PATH in webServer env
     *   - Then this test can be un-skipped and the mock server used
     *
     * Reference: packages/adapter-utils/src/delivery-hook.ts
     */

    // Harness is ready — implementation is blocked on the above
    const mockServer = await startMockGitHubServer();
    try {
      const issue = await createIssue(ctx, "Delivery: full adapter lifecycle");
      const issueId = issue.id;
      const runId = await checkoutIssue(ctx.boardRequest, ctx.executor, issueId);

      // This PATCH triggers the Paperclip issue status change — the adapter
      // delivery hook would then fire asynchronously after the run completes.
      const patchRes = await ctx.executor.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
        headers: { "X-Paperclip-Run-Id": runId },
        data: { status: "done", comment: "Delivery complete." },
      });
      expect(patchRes.ok()).toBe(true);

      // In a fully wired test, we would poll here until prUrl is populated:
      // const issueWithPr = await pollUntil(() => boardRequest.get(…), (i) => i.prUrl != null);
      // expect(issueWithPr.prUrl).toMatch(/github\.com\/.*\/pull\/\d+/);

      // Verify mock server received the expected GitHub API calls from adapter
      // expect(mockServer.calls.some((c) => c.path.includes("/pulls") && c.method === "POST")).toBe(true);
    } finally {
      await mockServer.close();
    }
  });

  test.skip("delivery blocked: PAPERCLIP_DELIVERY_LANE=disabled → no PR created, issue still done", async () => {
    /**
     * SKIP REASON: PAPERCLIP_DELIVERY_LANE=disabled is enforced by the adapter-side
     * executeConfiguredDeliveryHook and covered by its unit tests. This browser test
     * still cannot observe the adapter process or its outbound GitHub calls through
     * the Paperclip server API harness.
     *
     * Activation path: wire an adapter process to the mock GitHub server used above,
     * then assert that the issue completes without any pull-request request.
     */
  });
});
