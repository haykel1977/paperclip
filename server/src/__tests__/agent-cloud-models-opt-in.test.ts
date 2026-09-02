import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

// Regression coverage for PAPERCLIP_ALLOW_CLOUD_MODELS opt-in flag.
//
// Contract:
//   - flag unset            -> assertSovereignAgentModel enforces sovereign-only.
//                              Any adapterConfig.model missing the "sovereign"
//                              (or "souverain") marker is rejected with 422.
//   - flag === "1"          -> the enforcement is a no-op. Cloud model ids
//                              (e.g. anthropic/claude-sonnet-4.5) are accepted.
//   - flag !== "1"          -> treated as unset (defensive).
//
// Doc: docs/agents/cloud-models.md

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => ({ config }),
  ),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ cancelActiveForAgent: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

const cloudAdapter: ServerAdapterModule = {
  type: "anthropic_cloud_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "anthropic_cloud_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          { id: "company-1", requireBoardApprovalForNewAgents: false },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

const originalFlag = process.env.PAPERCLIP_ALLOW_CLOUD_MODELS;

describe("PAPERCLIP_ALLOW_CLOUD_MODELS opt-in", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "test",
    });
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.hasPermission.mockResolvedValue(true);

    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(cloudAdapter);
  });

  afterEach(async () => {
    if (originalFlag === undefined) {
      delete process.env.PAPERCLIP_ALLOW_CLOUD_MODELS;
    } else {
      process.env.PAPERCLIP_ALLOW_CLOUD_MODELS = originalFlag;
    }
    const { unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter(cloudAdapter.type);
  });

  it("rejects a cloud model when the flag is unset", async () => {
    delete process.env.PAPERCLIP_ALLOW_CLOUD_MODELS;
    const app = await createApp();
    const resp = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: cloudAdapter.type,
        adapterConfig: { model: "anthropic/claude-sonnet-4.5" },
      });
    expect(resp.status).toBe(422);
    expect(resp.body.error).toMatch(/must be a sovereign model/i);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects a cloud model when the flag is set to something other than '1'", async () => {
    process.env.PAPERCLIP_ALLOW_CLOUD_MODELS = "true";
    const app = await createApp();
    const resp = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: cloudAdapter.type,
        adapterConfig: { model: "anthropic/claude-sonnet-4.5" },
      });
    expect(resp.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("accepts a cloud model when the flag is set to '1'", async () => {
    process.env.PAPERCLIP_ALLOW_CLOUD_MODELS = "1";
    mockAgentService.create.mockImplementation(async (input: any) => ({
      id: "agent-1",
      companyId: input.companyId,
      name: input.name,
      role: input.role,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      status: "idle",
    }));
    const app = await createApp();
    const resp = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: cloudAdapter.type,
        adapterConfig: { model: "anthropic/claude-sonnet-4.5" },
      });
    // Sovereign guard must be silent.
    expect(resp.status).not.toBe(422);
    if (resp.status >= 400) {
      expect(String(resp.body.error ?? "")).not.toMatch(/must be a sovereign model/i);
    }
    // And the create path must actually be reached with the cloud model still
    // attached (proves the flag routed the request all the way through instead
    // of stopping at some other guard, and that no downstream normaliser
    // stripped the model). agentService.create is invoked as
    // create(companyId, agentInput) - agentInput is the second call arg.
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
    const [, createInput] = mockAgentService.create.mock.calls[0] ?? [];
    expect((createInput as any)?.adapterConfig?.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("still accepts sovereign model ids when the flag is unset", async () => {
    delete process.env.PAPERCLIP_ALLOW_CLOUD_MODELS;
    mockAgentService.create.mockImplementation(async (input: any) => ({
      id: "agent-2",
      companyId: input.companyId,
      name: input.name,
      role: input.role,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      status: "idle",
    }));
    const app = await createApp();
    const resp = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: cloudAdapter.type,
        adapterConfig: { model: "bifrost/qwen3-coder-30b-sovereign" },
      });
    expect(resp.status).not.toBe(422);
    if (resp.status >= 400) {
      expect(String(resp.body.error ?? "")).not.toMatch(/must be a sovereign model/i);
    }
  });
});
