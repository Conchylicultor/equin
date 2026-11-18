-- Custom SQL migration file, put your code below! --
-- migration: 20261118_140558__github_runs_times_backfill --
-- github_runs gains started_at / finished_at (the runs union's times). Rows
-- stored before them have only GitHub's updated_at: a run's start is not
-- known, so it reads as its last update (the next forwarder catch-up rewrites
-- the newest runs with their real run_started_at); a completed run finished at
-- its last update, which is exactly what the ingest stores from now on.
-- Idempotent: only rows still unset are touched.
UPDATE "github_runs" SET "started_at" = "github_updated_at" WHERE "started_at" IS NULL;
--> statement-breakpoint
UPDATE "github_runs" SET "finished_at" = "github_updated_at" WHERE "finished_at" IS NULL AND "status" = 'completed';
