-- singularity:snapshot id=9fa186b0-9a2e-4edc-a9ba-ee37b1485dbd parents=e33ba18d-3f06-40c9-9c95-45c224b6d2a8
-- singularity:supersedes b71d58fc
-- singularity:phase expand
ALTER TABLE "github_runs" ADD COLUMN "started_at" timestamp with time zone;
ALTER TABLE "github_runs" ADD COLUMN "finished_at" timestamp with time zone;
-- singularity:phase contract
ALTER TABLE "github_runs" ALTER COLUMN "started_at" SET NOT NULL;
-- singularity:claims
-- 20261118_140558__github_runs_times_backfill
