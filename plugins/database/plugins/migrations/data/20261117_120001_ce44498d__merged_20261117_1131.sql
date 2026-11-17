-- singularity:snapshot id=8592c5a3-da05-437d-8a9b-25b55163fb9a parents=35672749-9912-44ba-baf8-d2de49dbf4d7
-- singularity:supersedes 6dc57fbf
-- singularity:phase expand
CREATE TABLE "upstream_release_check" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"outcome" text NOT NULL,
	"remote" text,
	"latest" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upstream_release_check_one_row" CHECK ("upstream_release_check"."singleton")
);
-- singularity:phase contract
-- singularity:claims
-- 20261117_120000__retire_upstream_updates_report
