import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
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
 * Le tableau de bord interroge GET /companies/:id/heartbeat-runs?limit=200, qui se traduit par
 * « where company_id = ? order by created_at desc limit 200 ». Tant que le seul index utile
 * porte sur (company_id, agent_id, started_at) ou (company_id, liveness_state, created_at),
 * PostgreSQL ne peut pas satisfaire ce tri : il balaie toute la table puis garde 200 lignes.
 *
 * Ce n'est pas une inefficacité théorique. Sur l'instance quantum-dev, la table avait atteint
 * 149 754 lignes pour 185 Mo de tas ; chaque appel lançait deux workers parallèles et lisait
 * l'intégralité du tas, et le tableau de bord appelait la route environ dix-neuf fois par
 * minute. L'API a cessé de répondre.
 *
 * Le test échoue si l'index (company_id, created_at DESC) disparaît du schéma : sans lui le
 * plan retombe sur un Seq Scan, ce qui est exactement le défaut de production.
 */
describeEmbeddedPostgres("liste des runs par entreprise", () => {
  it("sert le tri created_at desc par un index, sans balayer la table", async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-runs-index-");
    cleanups.push(db.cleanup);
    await applyPendingMigrations(db.connectionString);

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

    // Assez de lignes, et assez larges, pour qu'un balayage séquentiel coûte franchement plus
    // cher que 200 entrées d'index : en dessous, le planificateur choisirait le balayage même
    // avec l'index en place et le test ne prouverait rien.
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
