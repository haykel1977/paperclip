import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findObjectRoutesMissingCompanyBoundaryGuardInText,
  runObjectRouteCompanyGuardCheck,
} from "./check-object-route-company-guards.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-object-route-company-guards-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts object routes with direct company access guard", () => {
  const text = `
    router.get("/projects/:id", async (req, res) => {
      const project = await svc.getById(req.params.id);
      assertCompanyAccess(req, project.companyId);
      res.json(project);
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("accepts object routes guarded by transitive helpers", () => {
  const text = `
    async function requireApprovalAccess(req, id) {
      const approval = await svc.getById(id);
      assertCompanyAccess(req, approval.companyId);
      return approval;
    }

    router.post("/approvals/:id/approve", async (req, res) => {
      const approval = await requireApprovalAccess(req, req.params.id);
      res.json(await svc.approve(approval.id));
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("accepts typed helpers with object-shaped resource parameters", () => {
  const text = `
    async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
      assertCompanyAccess(req, targetAgent.companyId);
    }

    router.patch("/agents/:id", async (req, res) => {
      const agent = await svc.getById(req.params.id);
      await assertCanUpdateAgent(req, agent);
      res.json(await svc.update(agent.id, req.body));
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("accepts object routes delegated to guarded handlers", () => {
  const text = `
    async function handleExecutionWorkspaceRuntimeCommand(req, res) {
      const workspace = await svc.getById(req.params.id);
      assertCompanyAccess(req, workspace.companyId);
      res.json(await runtime.start(workspace.id));
    }

    router.post("/execution-workspaces/:id/runtime-services/:action", handleExecutionWorkspaceRuntimeCommand);
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("reports object routes without company boundary guard", () => {
  const text = `
    router.get("/agents/:id", async (req, res) => {
      const agent = await svc.getById(req.params.id);
      res.json(agent);
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text, "routes/agents.ts"), [
    {
      filePath: "routes/agents.ts",
      lineNumber: 2,
      method: "GET",
      route: "/agents/:id",
    },
  ]);
});

test("ignores object company boundary guards that only appear in comments", () => {
  const text = `
    router.get("/projects/:id", async (req, res) => {
      const project = await svc.getById(req.params.id);
      // assertCompanyAccess(req, project.companyId);
      res.json(project);
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text, "routes/projects.ts"), [
    {
      filePath: "routes/projects.ts",
      lineNumber: 2,
      method: "GET",
      route: "/projects/:id",
    },
  ]);
});

test("ignores guarded helpers that only appear in comments", () => {
  const text = `
    async function requireProjectAccess(req, id) {
      const project = await svc.getById(id);
      assertCompanyAccess(req, project.companyId);
      return project;
    }

    router.get("/projects/:id", async (req, res) => {
      const project = await svc.getById(req.params.id);
      // await requireProjectAccess(req, req.params.id);
      res.json(project);
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text, "routes/projects.ts"), [
    {
      filePath: "routes/projects.ts",
      lineNumber: 8,
      method: "GET",
      route: "/projects/:id",
    },
  ]);
});

test("ignores company-scoped collection routes", () => {
  const text = `
    router.get("/companies/:companyId/projects", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      res.json(await svc.list(companyId));
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("ignores public routine trigger fire route", () => {
  const text = `
    router.post("/routine-triggers/public/:publicId/fire", async (req, res) => {
      res.status(202).json(await svc.firePublicTrigger(req.params.publicId));
    });
  `;

  assert.deepEqual(findObjectRoutesMissingCompanyBoundaryGuardInText(text), []);
});

test("runObjectRouteCompanyGuardCheck scans route files", () => {
  withTempDir((dir) => {
    const routesDir = join(dir, "server", "src", "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "projects.ts"), `
      router.get("/projects/:id", async (req, res) => {
        const project = await svc.getById(req.params.id);
        assertCompanyAccess(req, project.companyId);
        res.json(project);
      });
    `);
    writeFileSync(join(routesDir, "goals.ts"), `
      router.delete("/goals/:id", async (req, res) => {
        const goal = await svc.getById(req.params.id);
        res.json(await svc.remove(goal.id));
      });
    `);

    assert.equal(runObjectRouteCompanyGuardCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
