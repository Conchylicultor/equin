-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" text PRIMARY KEY GENERATED ALWAYS AS (job_name || ':' || seq::text) STORED NOT NULL,
	"job_name" text NOT NULL,
	"slot" integer NOT NULL,
	"seq" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"duration_ms" integer NOT NULL,
	"attempt" integer NOT NULL,
	"job_id" text,
	"hold" text,
	"max_attempts" integer,
	"queued_at" timestamp with time zone,
	"input" jsonb
);
CREATE INDEX IF NOT EXISTS "job_runs_finished_at_idx" ON "job_runs" USING btree ("finished_at");
-- singularity:phase contract
DROP TABLE "job_recent_runs" CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "job_runs_job_name_slot_idx" ON "job_runs" USING btree ("job_name","slot");
-- singularity:claims
-- 20261010_004900__job_runs_from_recent_runs
