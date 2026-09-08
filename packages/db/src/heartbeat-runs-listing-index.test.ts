import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

/**
 * The dashboard polls GET /companies/:id/heartbeat-runs?limit=200, which becomes
 * `where company_id = ? order by created_at desc limit 200`. As long as every index on the
 * table places another column ahead of created_at — agent_id, liveness_state, status —
 * Postgres cannot order that scan: it reads the whole table and then keeps 200 rows.
 *
 * This is not a theoretical inefficiency. On one instance the table had reached 149,754 rows
 * and 185 MB of heap; each request read all of it and spawned two parallel workers, and the
 * dashboard called the route roughly nineteen times a minute. The API stopped responding.
 *
 * The test fails if the (company_id, created_at) index leaves the schema: the plan falls back
 * to a Seq Scan, which is exactly the production defect.
 */
describeEmbeddedPostgres("per-company run listing", () => {
  it("serves the created_at desc sort from an index instead of scanning the table", async () => {
    // startEmbeddedPostgresTestDatabase applies pending migrations itself, so the schema —
    // including the index under test — is already in place here.
    const db = await startEmbeddedPostgresTestDatabase("paperclip-runs-index-");
    cleanups.push(db.cleanup);

    const sql = postgres(db.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end({ timeout: 5 });
    });

    const [company] = await sql<{ id: string }[]>`
      insert into companies (name) values ('Index Fixture') returning id
    `;
    const [agent] = await sql<{ id: string }[]>`
      insert into agents (company_id, name) values (${company.id}, 'Fixture Agent') returning id
    `;

    // Enough rows, and wide enough, that a sequential scan costs clearly more than 200 index
    // entries. Below that the planner would pick the scan even with the index in place, and
    // the test would prove nothing.
    await sql`
      insert into heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot)
      select ${company.id}, ${agent.id}, 'succeeded',
             now() - (g || ' seconds')::interval,
             jsonb_build_object('issueId', g::text, 'pad', repeat('x', 400))
      from generate_series(1, 20000) as g
    `;
    await sql`analyze heartbeat_runs`;

    const plan = await sql<{ "QUERY PLAN": unknown }[]>`
      explain (format json, costs off)
      select id, created_at from heartbeat_runs
      where company_id = ${company.id}
      order by created_at desc
      limit 200
    `;
    const planText = JSON.stringify(plan[0]["QUERY PLAN"]);

    expect(planText).not.toContain("Seq Scan");
    expect(planText).toContain("heartbeat_runs_company_created_idx");
  }, 180_000);
});
