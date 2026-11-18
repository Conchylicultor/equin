-- singularity:snapshot id=7191e1bd-f84b-4772-82db-c4873ab29e2c parents=9099812d-e204-46df-816c-9bb3f6b1a628
-- singularity:supersedes 4c1a2f26
-- singularity:phase expand
CREATE TABLE "github_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"tag" text NOT NULL,
	"draft" boolean NOT NULL,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text NOT NULL,
	"github_updated_at" timestamp with time zone NOT NULL
);
CREATE TABLE "github_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"workflow_path" text NOT NULL,
	"workflow_name" text NOT NULL,
	"event" text NOT NULL,
	"head" text NOT NULL,
	"head_sha" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"url" text NOT NULL,
	"failed_jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"github_updated_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone
);
CREATE INDEX "github_releases_updated_idx" ON "github_releases" USING btree ("github_updated_at" DESC NULLS LAST);
CREATE INDEX "github_runs_repo_path_head_idx" ON "github_runs" USING btree ("repo","workflow_path","head","github_updated_at" DESC NULLS LAST);
CREATE INDEX "github_runs_updated_idx" ON "github_runs" USING btree ("github_updated_at" DESC NULLS LAST);
-- singularity:phase contract
-- singularity:claims
