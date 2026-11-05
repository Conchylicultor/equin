-- singularity:snapshot id=fb369c9c-2676-4cba-9182-4e18a777e502 parents=fa138b7e-9a47-4771-b3a1-15addadafd8e
-- singularity:supersedes 418f4abc
-- singularity:supersedes 418f4abc <- 888c8af2
-- singularity:phase expand
CREATE TABLE "jobs_in_process_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"hold" text NOT NULL,
	"payload" jsonb NOT NULL,
	"job_key" text,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"dead" boolean NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
CREATE TABLE "jobs_in_process_schedules" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_execution" timestamp with time zone NOT NULL
);
CREATE INDEX "jobs_in_process_rows_job_key_idx" ON "jobs_in_process_rows" USING btree ("job_key");
-- singularity:phase contract
-- singularity:claims
