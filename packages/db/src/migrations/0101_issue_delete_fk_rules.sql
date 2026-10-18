-- Règles ON DELETE manquantes qui faisaient échouer DELETE /api/issues/:id (500).
-- Ne fait rien si la règle est déjà en place (cas de quantum-dev, corrigé à la main le 18/10/2026).
-- NOT VALID : la contrainte remplacée garantissait déjà ces mêmes références, donc pas de
-- balayage des lignes existantes sous verrou ACCESS EXCLUSIVE ; les nouvelles écritures sont contrôlées.
-- Validation complète possible plus tard, hors migration :
--   ALTER TABLE "cost_events" VALIDATE CONSTRAINT "cost_events_issue_id_issues_id_fk";
--   ALTER TABLE "issue_comments" VALIDATE CONSTRAINT "issue_comments_issue_id_issues_id_fk";
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_events_issue_id_issues_id_fk' AND conrelid = 'public.cost_events'::regclass AND confdeltype = 'n'
  ) THEN
    ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_issue_id_issues_id_fk";
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_comments_issue_id_issues_id_fk' AND conrelid = 'public.issue_comments'::regclass AND confdeltype = 'c'
  ) THEN
    ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_issue_id_issues_id_fk";
    ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;
