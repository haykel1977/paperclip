import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnsureWorkspace = vi.hoisted(() => vi.fn());
const mockStartServices = vi.hoisted(() => vi.fn(async () => []));
const mockRunJob = vi.hoisted(() => vi.fn(async () => ({ id: "job-operation" })));

vi.mock("../services/workspace-runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/workspace-runtime.js")>(),
  ensurePersistedExecutionWorkspaceAvailable: mockEnsureWorkspace,
  startRuntimeServicesForWorkspaceControl: mockStartServices,
  stopRuntimeServicesForExecutionWorkspace: vi.fn(),
  runWorkspaceJobForControl: mockRunJob,
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createApp(companyIds = ["company-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it.each([
    ["run", true], ["start", true], ["restart", true],
    ["run", false], ["start", false], ["restart", false],
  ] as const)("persists recovery base for manual %s with created=%s", async (action, created) => {
    const oldSnapshot = { baseRef: "main", resolvedSha: "old-base" };
    let persisted: Record<string, any> = {
      id: "workspace-1", companyId: "company-1", projectId: null, projectWorkspaceId: null,
      sourceIssueId: null, name: "Workspace", mode: "isolated_workspace", strategyType: "git_worktree",
      cwd: "/tmp/workspace", repoUrl: null, baseRef: "main", branchName: "feature/test",
      metadata: { baseRefSnapshot: oldSnapshot, custom: "keep" }, runtimeServices: [],
      config: { workspaceRuntime: { commands: [
        { id: "check", name: "check", kind: "job", command: "pnpm test" },
        { id: "web", name: "web", kind: "service", command: "pnpm dev" },
      ] } },
    };
    mockExecutionWorkspaceService.getById.mockImplementation(async () => persisted);
    mockExecutionWorkspaceService.update.mockImplementation(async (_id, patch) => {
      persisted = { ...persisted, ...patch };
      return persisted;
    });
    mockEnsureWorkspace.mockResolvedValue({
      cwd: persisted.cwd, repoRef: "origin/main", baseRefSha: "fresh-base", created,
    });
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      recordOperation: async ({ run }: { run: () => Promise<unknown> }) => run(),
    });
    const router = executionWorkspaceRoutes({} as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === "/execution-workspaces/:id/runtime-commands/:action");
    const handler = layer!.route.stack.at(-1)!.handle;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({
      params: { id: "workspace-1", action },
      body: { workspaceCommandId: action === "run" ? "check" : "web" },
      actor: { type: "board", userId: "local-board", companyIds: ["company-1"], source: "session", isInstanceAdmin: false },
    } as any, res as any, vi.fn());
    expect(res.status).not.toHaveBeenCalled();
    expect(persisted.baseRef).toBe("origin/main");
    expect(persisted.metadata.baseRefSnapshot).toEqual(created
      ? { baseRef: "origin/main", resolvedSha: "fresh-base" }
      : oldSnapshot);
    expect(persisted.metadata.custom).toBe("keep");
    if (action !== "run") expect(persisted.metadata.config.desiredState).toBe("running");
  });

});
