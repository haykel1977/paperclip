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
 * DELETE /api/issues/:id répondait 500 dès qu'un agent avait facturé un appel ou commenté
 * la carte : cost_events.issue_id puis issue_comments.issue_id n'avaient aucune règle
 * ON DELETE. La migration 0101 leur donne SET NULL (le coût reste comptabilisé) et
 * CASCADE (le commentaire suit sa carte). Le test échoue si l'une de ces règles disparaît.
 */
describeEmbeddedPostgres("suppression d'une carte avec coûts et commentaires", () => {
  it("supprime la carte, conserve la ligne de coût et efface les commentaires", async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-issue-delete-fk-");
    cleanups.push(db.cleanup);

    const sql = postgres(db.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end({ timeout: 5 });
    });

    const [company] = await sql<{ id: string }[]>`
      insert into companies (name) values ('Delete Fixture') returning id
    `;
    const [issue] = await sql<{ id: string }[]>`
      insert into issues (company_id, title) values (${company.id}, 'Carte de test') returning id
    `;
    await sql`
      insert into cost_events (company_id, issue_id, provider, model, cost_cents, occurred_at)
      values (${company.id}, ${issue.id}, 'opencode', 'glm-5.3', 7, now())
    `;
    await sql`
      insert into issue_comments (company_id, issue_id, body)
      values (${company.id}, ${issue.id}, 'result=glm_ok')
    `;

    await sql`delete from issues where id = ${issue.id}`;

    const [costs] = await sql<{ n: number; linked: number; cents: number }[]>`
      select count(*)::int as n, count(issue_id)::int as linked, coalesce(sum(cost_cents), 0)::int as cents
      from cost_events where company_id = ${company.id}
    `;
    expect(costs).toEqual({ n: 1, linked: 0, cents: 7 });

    const [comments] = await sql<{ n: number }[]>`
      select count(*)::int as n from issue_comments where company_id = ${company.id}
    `;
    expect(comments.n).toBe(0);
    // Démarrage de Postgres embarqué + chaîne complète des migrations : même délai que
    // heartbeat-runs-listing-index.test.ts, le défaut de Vitest (5 s) ne suffit pas.
  }, 180_000);
});
