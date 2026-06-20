import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findHeartbeatRunRoutesMissingBoundaryGuardInText,
  runHeartbeatRunRouteGuardCheck,
} from "./check-heartbeat-run-route-guards.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-heartbeat-run-route-guards-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts heartbeat run detail routes with direct run read guard", () => {
  const text = `
    router.get("/heartbeat-runs/:runId", async (req, res) => {
      const run = await heartbeat.getRun(req.params.runId);
      assertCompanyAccess(req, run.companyId);
      if (!(await assertRunReadAllowed(req, res, run))) return;
      res.json(run);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("accepts heartbeat run event/log child routes with direct run read guard", () => {
  const text = `
    router.get("/heartbeat-runs/:runId/events", async (req, res) => {
      const run = await heartbeat.getRun(req.params.runId);
      assertCompanyAccess(req, run.companyId);
      if (!(await assertRunReadAllowed(req, res, run))) return;
      res.json(await heartbeat.listEvents(run.id));
    });

    router.get("/heartbeat-runs/:runId/log", async (req, res) => {
      const run = await heartbeat.getRunLogAccess(req.params.runId);
      assertCompanyAccess(req, run.companyId);
      if (!(await assertRunReadAllowed(req, res, run))) return;
      res.json(await heartbeat.readLog(run));
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("accepts heartbeat run routes guarded by transitive helpers", () => {
  const text = `
    async function assertCanReadRun(req, res, run) {
      return assertRunReadAllowed(req, res, run);
    }

    router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
      const run = await heartbeat.getRun(req.params.runId);
      assertCompanyAccess(req, run.companyId);
      if (!(await assertCanReadRun(req, res, run))) return;
      res.json([]);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("reports heartbeat run detail routes with only company access", () => {
  const text = `
    router.get("/heartbeat-runs/:runId", async (req, res) => {
      const run = await heartbeat.getRun(req.params.runId);
      assertCompanyAccess(req, run.companyId);
      res.json(run);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text, "routes/agents.ts"), [
    {
      filePath: "routes/agents.ts",
      lineNumber: 2,
      method: "GET",
      route: "/heartbeat-runs/:runId",
    },
  ]);
});

test("accepts company-wide heartbeat run routes with company run guard", () => {
  const text = `
    router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      if (!(await assertCompanyRunReadAllowed(req, res, companyId))) return;
      res.json(await heartbeat.list(companyId));
    });

    router.get("/companies/:companyId/live-runs", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      if (!(await assertCompanyRunReadAllowed(req, res, companyId))) return;
      res.json([]);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("accepts company-wide heartbeat run routes with direct company scope decision", () => {
  const text = `
    router.get("/companies/:companyId/live-runs", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      const decision = await access.decide({
        actor: req.actor,
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });
      if (!decision.allowed) return res.status(403).json({ error: "Forbidden" });
      res.json([]);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("reports company-wide heartbeat run routes with only company access", () => {
  const text = `
    router.get("/companies/:companyId/live-runs", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      res.json([]);
    });
  `;

  assert.equal(findHeartbeatRunRoutesMissingBoundaryGuardInText(text).length, 1);
});

test("does not report heartbeat run mutations", () => {
  const text = `
    router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
      assertBoard(req);
      const run = await heartbeat.cancelRun(req.params.runId);
      res.json(run);
    });
  `;

  assert.deepEqual(findHeartbeatRunRoutesMissingBoundaryGuardInText(text), []);
});

test("runHeartbeatRunRouteGuardCheck scans route files", () => {
  withTempDir((dir) => {
    const routesDir = join(dir, "server", "src", "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "agents.ts"), `
      router.get("/heartbeat-runs/:runId", async (req, res) => {
        const run = await heartbeat.getRun(req.params.runId);
        assertCompanyAccess(req, run.companyId);
        if (!(await assertRunReadAllowed(req, res, run))) return;
        res.json(run);
      });

      router.get("/companies/:companyId/live-runs", async (req, res) => {
        const companyId = req.params.companyId;
        assertCompanyAccess(req, companyId);
        res.json([]);
      });
    `);

    assert.equal(runHeartbeatRunRouteGuardCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
