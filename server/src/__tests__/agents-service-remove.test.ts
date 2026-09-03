import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { costEvents, companies, createDb, agents, issues, financeEvents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent remove tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.remove FK cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("nulls cost and finance agent ids instead of deleting spend history", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Remove FK Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SpendyCoder",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: { model: "qwen3-coder-sovereign" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned to soon-deleted agent",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const [costRow] = await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "openrouter",
      biller: "openrouter",
      billingType: "token",
      model: "qwen3-coder-sovereign",
      costCents: 12,
      occurredAt: new Date(),
    }).returning({ id: costEvents.id });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      issueId,
      costEventId: costRow.id,
      eventKind: "usage",
      biller: "openrouter",
      amountCents: 12,
      occurredAt: new Date(),
    });

    await svc.terminate(agentId);
    const removed = await svc.remove(agentId);
    expect(removed?.id).toBe(agentId);

    const leftoverCosts = await db
      .select({
        id: costEvents.id,
        agentId: costEvents.agentId,
        costCents: costEvents.costCents,
      })
      .from(costEvents);
    expect(leftoverCosts).toEqual([
      { id: costRow.id, agentId: null, costCents: 12 },
    ]);

    const leftoverFinance = await db
      .select({
        agentId: financeEvents.agentId,
        amountCents: financeEvents.amountCents,
        costEventId: financeEvents.costEventId,
      })
      .from(financeEvents);
    expect(leftoverFinance).toEqual([
      { agentId: null, amountCents: 12, costEventId: costRow.id },
    ]);

    const leftoverAgents = await db.select({ id: agents.id }).from(agents);
    expect(leftoverAgents).toEqual([]);

    const persistedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persistedIssue?.assigneeAgentId).toBeNull();
  });

  it("clears only the matching issue FK when deleting an assignee that did not create the issue", async () => {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const creatorId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Split FK Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorId,
        companyId,
        name: "CreatorCoder",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_local",
        adapterConfig: { model: "qwen3-coder-sovereign" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeId,
        companyId,
        name: "AssigneeCoder",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_local",
        adapterConfig: { model: "qwen3-coder-sovereign" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Created by one agent, assigned to another",
      status: "todo",
      priority: "medium",
      assigneeAgentId: assigneeId,
      createdByAgentId: creatorId,
    });

    await svc.terminate(assigneeId);
    const removed = await svc.remove(assigneeId);
    expect(removed?.id).toBe(assigneeId);

    const persistedIssue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persistedIssue?.assigneeAgentId).toBeNull();
    expect(persistedIssue?.createdByAgentId).toBe(creatorId);
  });
});
