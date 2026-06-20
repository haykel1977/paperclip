import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findUnguardedCompanyRoutesInText,
  runCompanyRouteGuardCheck,
} from "./check-company-route-guards.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-company-route-guards-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts company routes with direct company access guard", () => {
  const text = `
    router.get("/companies/:companyId/projects", async (req, res) => {
      const companyId = req.params.companyId;
      assertCompanyAccess(req, companyId);
      res.json([]);
    });
  `;

  assert.deepEqual(findUnguardedCompanyRoutesInText(text), []);
});

test("accepts company routes guarded by transitive helpers", () => {
  const text = `
    function assertCanManageProjects(req, companyId) {
      assertCompanyAccess(req, companyId);
    }

    async function assertCanCreateProject(req, companyId) {
      assertCanManageProjects(req, companyId);
    }

    router.post("/companies/:companyId/projects", async (req, res) => {
      const companyId = req.params.companyId;
      await assertCanCreateProject(req, companyId);
      res.status(201).json({});
    });
  `;

  assert.deepEqual(findUnguardedCompanyRoutesInText(text), []);
});

test("reports company routes without company access guard", () => {
  const text = `
    router.get("/companies/:companyId/projects", async (req, res) => {
      const companyId = req.params.companyId;
      res.json(await svc.list(companyId));
    });
  `;

  assert.deepEqual(findUnguardedCompanyRoutesInText(text, "routes/projects.ts"), [
    {
      filePath: "routes/projects.ts",
      lineNumber: 2,
      method: "GET",
      route: "/companies/:companyId/projects",
    },
  ]);
});

test("does not treat unguarded helpers as company access guards", () => {
  const text = `
    function loadCompanyStuff(req, companyId) {
      return svc.list(companyId);
    }

    router.get("/companies/:companyId/stuff", async (req, res) => {
      const companyId = req.params.companyId;
      res.json(await loadCompanyStuff(req, companyId));
    });
  `;

  assert.equal(findUnguardedCompanyRoutesInText(text).length, 1);
});

test("runCompanyRouteGuardCheck scans route files", () => {
  withTempDir((dir) => {
    const routesDir = join(dir, "server", "src", "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "projects.ts"), `
      router.get("/companies/:companyId/projects", async (req, res) => {
        const companyId = req.params.companyId;
        assertCompanyAccess(req, companyId);
        res.json([]);
      });
    `);
    writeFileSync(join(routesDir, "goals.ts"), `
      router.post("/companies/:companyId/goals", async (req, res) => {
        const companyId = req.params.companyId;
        res.json(await svc.create(companyId, req.body));
      });
    `);

    assert.equal(runCompanyRouteGuardCheck({ root: dir, log() {}, error() {} }), 1);
  });
});
