import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Lookup-failure injection: the real issue service is kept, only `list` throws
// for the agents registered here. This exercises the fail-closed branch of the
// timer gate without a fake client standing in for the database.
const { failingLookupAgentIds } = vi.hoisted(() => ({ failingLookupAgentIds: new Set<string>() }));
vi.mock("../services/issues.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/issues.ts")>();
  return {
    ...mod,
    issueService: (...args: Parameters<typeof mod.issueService>) => {
      const real = mod.issueService(...args);
      return {
        ...real,
        list: async (companyId: string, filters?: Parameters<typeof real.list>[1]) => {
          if (filters?.assigneeAgentId && failingLookupAgentIds.has(filters.assigneeAgentId)) {
            throw new Error("injected actionable-work lookup failure");
          }
          return real.list(companyId, filters);
        },
      };
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TICK_AT = new Date("2026-09-14T12:00:00.000Z");
const TEN_MINUTES_BEFORE_TICK = new Date(TICK_AT.getTime() - 10 * 60_000);

describeEmbeddedPostgres("heartbeat timer gate (#2985)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // Runs enqueued by the positive cases execute a no-op process adapter in the
  // background; wait for their side effects to settle before deleting rows
  // (same discipline as issue-monitor-scheduler.test.ts).
  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);
    return [active, events, activity, leases, runtimeServices].map((rows) => rows[0]?.count ?? 0).join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    failingLookupAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await waitForHeartbeatSideEffectsSettled().catch(() => undefined);
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timer Gate Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  // The gate is an explicit per-agent policy; `{}` seeds an agent without it.
  async function seedAgent(companyId: string, name: string, heartbeatPolicy: { requireActionableWork?: boolean } = { requireActionableWork: true }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, ...heartbeatPolicy } },
      permissions: {},
      lastHeartbeatAt: TEN_MINUTES_BEFORE_TICK,
    });
    return agentId;
  }

  let issueCounter = 0;
  async function seedIssue(companyId: string, agentId: string, status: string) {
    issueCounter += 1;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${status}`,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: issueCounter,
      identifier: `TG-${issueCounter}`,
    });
    return issueId;
  }

  async function runsFor(agentId: string) {
    return db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  async function runContextsFor(agentId: string) {
    const rows = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return rows.map((row) => (row.contextSnapshot ?? {}) as Record<string, unknown>);
  }

  async function wakeupRequestsFor(agentId: string) {
    return db
      .select({
        source: agentWakeupRequests.source,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("timer wakes an agent holding a todo issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Todo Bot");
    const issueId = await seedIssue(companyId, agentId, "todo");

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ enqueued: 1, skipped: 0 });
    expect((await runsFor(agentId)).length).toBe(1);
    expect((await wakeupRequestsFor(agentId)).filter((row) => row.status === "skipped")).toEqual([]);
    // The card the gate found travels with the run, so adapters can export it
    // as PAPERCLIP_TASK_ID and a task-requiring launcher does not skip it.
    expect(await runContextsFor(agentId)).toEqual([expect.objectContaining({ issueId, taskId: issueId })]);
  });

  it("timer wakes an agent holding an in_progress issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Progress Bot");
    await seedIssue(companyId, agentId, "in_progress");

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ enqueued: 1, skipped: 0 });
    expect((await runsFor(agentId)).length).toBe(1);
  });

  it("timer skips an agent with no issue: no run, no adapter, one lookup per interval, one audit row per idle period", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Idle Bot");
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.tickTimers(TICK_AT);
    expect(first).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await runsFor(agentId)).toEqual([]);
    expect(await wakeupRequestsFor(agentId)).toEqual([
      { source: "timer", status: "skipped", reason: "timer.no_actionable_work", error: null },
    ]);

    // One second later the interval has not elapsed again: no lookup, nothing written.
    const second = await heartbeat.tickTimers(new Date(TICK_AT.getTime() + 1_000));
    expect(second).toMatchObject({ checked: 1, enqueued: 0, skipped: 0 });
    expect((await wakeupRequestsFor(agentId)).length).toBe(1);

    // After a full interval the agent is evaluated again, still idle: skipped
    // again, but the same idle period writes no second audit row.
    const third = await heartbeat.tickTimers(new Date(TICK_AT.getTime() + 61_000));
    expect(third).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect((await wakeupRequestsFor(agentId)).length).toBe(1);
    expect(await runsFor(agentId)).toEqual([]);

    // Work arrives: the next due tick wakes the agent (idle period over).
    await seedIssue(companyId, agentId, "todo");
    const fourth = await heartbeat.tickTimers(new Date(TICK_AT.getTime() + 122_000));
    expect(fourth).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });
    expect((await runsFor(agentId)).length).toBe(1);
  });

  it("without the requireActionableWork policy the timer keeps its documented semantics", async () => {
    const companyId = await seedCompany();
    const ceoAgentId = await seedAgent(companyId, "CEO Bot", {});

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });
    expect((await runsFor(ceoAgentId)).length).toBe(1);
    const [ceoContext] = await runContextsFor(ceoAgentId);
    expect(ceoContext?.issueId).toBeUndefined();
    expect(ceoContext?.taskId).toBeUndefined();
    expect((await wakeupRequestsFor(ceoAgentId)).filter((row) => row.status === "skipped")).toEqual([]);
  });

  it("a lookup failure is recorded once per failure period, then replaced by no_actionable_work", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Flaky Lookup Bot");
    const heartbeat = heartbeatService(db);
    failingLookupAgentIds.add(agentId);

    await heartbeat.tickTimers(TICK_AT);
    await heartbeat.tickTimers(new Date(TICK_AT.getTime() + 61_000));
    expect((await wakeupRequestsFor(agentId)).map((row) => row.reason)).toEqual(["timer.actionable_work_lookup_failed"]);

    failingLookupAgentIds.delete(agentId);
    const recovered = await heartbeat.tickTimers(new Date(TICK_AT.getTime() + 122_000));
    expect(recovered).toMatchObject({ enqueued: 0, skipped: 1 });
    expect((await wakeupRequestsFor(agentId)).map((row) => row.reason)).toEqual([
      "timer.actionable_work_lookup_failed",
      "timer.no_actionable_work",
    ]);
    expect(await runsFor(agentId)).toEqual([]);
  });

  it("timer treats blocked, in_review, backlog and done issues as no actionable work", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Blocked Bot");
    for (const status of ["blocked", "in_review", "backlog", "done"]) {
      await seedIssue(companyId, agentId, status);
    }

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(await runsFor(agentId)).toEqual([]);
    expect((await wakeupRequestsFor(agentId)).map((row) => row.reason)).toEqual(["timer.no_actionable_work"]);
  });

  it("a failed actionable-work lookup fails closed with its own reason", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Broken Lookup Bot");
    await seedIssue(companyId, agentId, "todo");
    failingLookupAgentIds.add(agentId);

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(await runsFor(agentId)).toEqual([]);
    expect(await wakeupRequestsFor(agentId)).toEqual([
      {
        source: "timer",
        status: "skipped",
        reason: "timer.actionable_work_lookup_failed",
        error: "injected actionable-work lookup failure",
      },
    ]);
  });

  it("a manual wakeup is not gated by the timer's actionable-work rule", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Manual Bot");

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "manual",
      requestedByActorType: "user",
      requestedByActorId: randomUUID(),
    });

    expect(run).not.toBeNull();
    expect((await runsFor(agentId)).length).toBe(1);
    expect((await wakeupRequestsFor(agentId)).filter((row) => row.status === "skipped")).toEqual([]);
  });

  it("eligibility is decided per agent within one tick", async () => {
    const companyId = await seedCompany();
    const busyAgentId = await seedAgent(companyId, "Busy Bot");
    const idleAgentId = await seedAgent(companyId, "Idle Bot");
    const brokenAgentId = await seedAgent(companyId, "Broken Bot");
    await seedIssue(companyId, busyAgentId, "todo");
    await seedIssue(companyId, brokenAgentId, "todo");
    failingLookupAgentIds.add(brokenAgentId);

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result).toMatchObject({ checked: 3, enqueued: 1, skipped: 2 });
    expect((await runsFor(busyAgentId)).length).toBe(1);
    expect(await runsFor(idleAgentId)).toEqual([]);
    expect(await runsFor(brokenAgentId)).toEqual([]);
    expect((await wakeupRequestsFor(idleAgentId)).map((row) => row.reason)).toEqual(["timer.no_actionable_work"]);
    expect((await wakeupRequestsFor(brokenAgentId)).map((row) => row.reason)).toEqual(["timer.actionable_work_lookup_failed"]);
  });
});
