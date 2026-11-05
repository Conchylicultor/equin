-- singularity:snapshot id=8c6c8422-f80b-4402-b20d-1afdc9a32f44 parents=fec7dc19-91b4-405f-8c3e-4d7cd4ffa73b
-- singularity:supersedes bb82dc89
-- singularity:supersedes bb82dc89 <- cd275147
-- singularity:phase expand
CREATE TABLE "reports_reconciled" (
	"name" text PRIMARY KEY NOT NULL,
	"code_digest" text NOT NULL,
	"reconciled_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "reports" ADD COLUMN "stale_origin" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
-- 20261105_035410__reports_stale_origin_backfill
