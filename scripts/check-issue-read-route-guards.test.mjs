import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findIssueReadRoutesMissingBoundaryGuardInText,
  runIssueReadRouteGuardCheck,
} from "./check-issue-read-route-guards.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-issue-read-route-guards-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts issue read routes with direct issue read guard", () => {
  const text = `
    router.get("/issues/:id/comments", async (req, res) => {
      const issue = await svc.getById(req.params.id);
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertIssueReadAllowed(req, res, issue))) return;
      res.json(await svc.listComments(issue.id));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("accepts issue read routes guarded by transitive helpers", () => {
  const text = `
    async function assertIssueCostReadAllowed(req, res, issue) {
      const decision = await access.decide({
        actor: req.actor,
        action: "issue:read",
        resource: { type: "issue", companyId: issue.companyId, issueId: issue.id },
      });
      if (decision.allowed) return true;
      res.status(403).json({ error: "Forbidden" });
      return false;
    }

    async function assertCanReadIssueCosts(req, res, issue) {
      return assertIssueCostReadAllowed(req, res, issue);
    }

    router.get("/issues/:id/cost-summary", async (req, res) => {
      const issue = await svc.getById(req.params.id);
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertCanReadIssueCosts(req, res, issue))) return;
      res.json(await costs.summary(issue.id));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("accepts issue collection routes filtered by a guarded helper", () => {
  const text = `
    async function decideIssueRead(req, issue) {
      return access.decide({
        actor: req.actor,
        action: "issue:read",
        resource: { type: "issue", companyId: issue.companyId, issueId: issue.id },
      });
    }

    async function filterIssuesReadableByActor<T extends IssueReadSubject>(req, issues) {
      const decisions = await Promise.all(
        issues.map(async (issue) => ((await decideIssueRead(req, issue)).allowed ? issue : null)),
      );
      return decisions.filter((issue) => issue !== null);
    }

    router.get("/agents/me/inbox-lite", async (req, res) => {
      const rows = await issuesSvc.list(req.actor.companyId, { assigneeAgentId: req.actor.agentId });
      res.json(await filterIssuesReadableByActor(req, rows));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("reports agent issue collection routes without issue read filtering", () => {
  const text = `
    router.get("/agents/me/inbox/mine", async (req, res) => {
      const rows = await issuesSvc.list(req.actor.companyId, { touchedByUserId: req.query.userId });
      res.json(rows);
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text, "routes/agents.ts"), [
    {
      filePath: "routes/agents.ts",
      lineNumber: 2,
      method: "GET",
      route: "/agents/me/inbox/mine",
    },
  ]);
});

test("reports issue read routes that only validate company access", () => {
  const text = `
    router.get("/issues/:id/comments", async (req, res) => {
      const issue = await svc.getById(req.params.id);
      assertCompanyAccess(req, issue.companyId);
      res.json(await svc.listComments(issue.id));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text, "routes/issues.ts"), [
    {
      filePath: "routes/issues.ts",
      lineNumber: 2,
      method: "GET",
      route: "/issues/:id/comments",
    },
  ]);
});

test("accepts board-only issue control-plane routes", () => {
  const text = `
    router.get("/issues/:id/tree-control/state", async (req, res) => {
      assertBoard(req);
      const issue = await svc.getById(req.params.id);
      assertCompanyAccess(req, issue.companyId);
      res.json(await controls.state(issue.id));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("reports attachment content routes without issue read guard", () => {
  const text = `
    router.get("/attachments/:attachmentId/content", async (req, res) => {
      const attachment = await svc.getAttachmentById(req.params.attachmentId);
      assertCompanyAccess(req, attachment.companyId);
      res.pipe(await storage.getObject(attachment.companyId, attachment.objectKey));
    });
  `;

  assert.equal(findIssueReadRoutesMissingBoundaryGuardInText(text).length, 1);
});

test("accepts attachment content routes with issue read guard", () => {
  const text = `
    router.get("/attachments/:attachmentId/content", async (req, res) => {
      const attachment = await svc.getAttachmentById(req.params.attachmentId);
      assertCompanyAccess(req, attachment.companyId);
      const issue = await svc.getById(attachment.issueId);
      if (!(await assertIssueReadAllowed(req, res, issue))) return;
      res.pipe(await storage.getObject(attachment.companyId, attachment.objectKey));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("does not report issue mutations", () => {
  const text = `
    router.post("/issues/:id/comments", async (req, res) => {
      const issue = await svc.getById(req.params.id);
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      res.status(201).json(await svc.addComment(issue.id, req.body));
    });
  `;

  assert.deepEqual(findIssueReadRoutesMissingBoundaryGuardInText(text), []);
});

test("runIssueReadRouteGuardCheck scans route files", () => {
  withTempDir((dir) => {
    const routesDir = join(dir, "server", "src", "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "issues.ts"), `
      router.get("/issues/:id/comments", async (req, res) => {
        const issue = await svc.getById(req.params.id);
        assertCompanyAccess(req, issue.companyId);
        if (!(await assertIssueReadAllowed(req, res, issue))) return;
        res.json([]);
      });
    `);
    writeFileSync(join(routesDir, "agents.ts"), `
      router.get("/issues/:id/active-run", async (req, res) => {
        const issue = await svc.getById(req.params.id);
        assertCompanyAccess(req, issue.companyId);
        res.json(await heartbeat.activeRun(issue.id));
      });
    `);

    assert.equal(runIssueReadRouteGuardCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
