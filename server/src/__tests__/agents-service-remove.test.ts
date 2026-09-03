import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { costEvents, companies, createDb, agents, issues } from "@paperclipai/db";
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
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes an agent that has cost_events and clears ghost issue assignees", async () => {
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
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "openrouter",
      biller: "openrouter",
      billingType: "token",
      model: "qwen3-coder-sovereign",
      costCents: 12,
      occurredAt: new Date(),
    });

    await svc.terminate(agentId);
    const removed = await svc.remove(agentId);
    expect(removed?.id).toBe(agentId);

    const leftoverCosts = await db.select({ id: costEvents.id }).from(costEvents);
    expect(leftoverCosts).toEqual([]);

    const leftoverAgents = await db.select({ id: agents.id }).from(agents);
    expect(leftoverAgents).toEqual([]);

    const persistedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persistedIssue?.assigneeAgentId).toBeNull();
  });
});
