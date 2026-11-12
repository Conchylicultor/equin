-- singularity:snapshot id=e7717784-cef6-42c8-b357-cf2e617660cb parents=65f150ac-9d35-4d00-911f-a1c20504afe1
-- singularity:supersedes 452380f7
-- singularity:supersedes 452380f7 <- 7719b302 07ad72d4 71a4a220
-- singularity:phase expand
CREATE TABLE "test_case_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"op_id" text NOT NULL,
	"path" text NOT NULL,
	"case_id" text NOT NULL,
	"message" text NOT NULL,
	"detail" text NOT NULL
);
CREATE TABLE "test_checkout_digests" (
	"path" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"runner" text NOT NULL,
	"plugin_id" text,
	"generation" text NOT NULL
);
CREATE TABLE "test_digest_generation" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"generation" text,
	"head_sha" text,
	"computed_at" timestamp with time zone,
	"computing_since" timestamp with time zone,
	"file_count" integer NOT NULL,
	"elapsed_ms" integer,
	"error" text
);
CREATE TABLE "test_file_results" (
	"id" text PRIMARY KEY NOT NULL,
	"op_id" text NOT NULL,
	"path" text NOT NULL,
	"runner" text NOT NULL,
	"digest" text NOT NULL,
	"outcome" text NOT NULL,
	"cases" integer NOT NULL,
	"failed_cases" integer NOT NULL,
	"duration_ms" double precision NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"origin" text NOT NULL,
	"slug" text NOT NULL
);
CREATE TABLE "test_file_status" (
	"path" text PRIMARY KEY NOT NULL,
	"plugin_id" text,
	"runner" text NOT NULL,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"last_outcome" text,
	"last_ran_at" timestamp with time zone,
	"last_op_id" text,
	"last_origin" text,
	"last_slug" text,
	"cases" integer,
	"failed_cases" integer,
	"duration_ms" double precision,
	"current_passed" integer NOT NULL,
	"current_failed" integer NOT NULL,
	"history" jsonb NOT NULL
);
CREATE TABLE "test_runs" (
	"op_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"origin" text NOT NULL,
	"repo" text NOT NULL,
	"head_sha" text,
	"tree_hash" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"digest_version" text NOT NULL,
	"runners" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"failed_count" integer NOT NULL
);
CREATE TABLE "host_idle_state" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"quiet_since" timestamp with time zone,
	"idle_since" timestamp with time zone,
	"evaluated_at" timestamp with time zone NOT NULL,
	"wake_at" timestamp with time zone,
	"blockers" jsonb NOT NULL
);
CREATE TABLE "tests_digestsSettled_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "host_idleBegan_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "host_idleEnded_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "op_log_ops" ADD COLUMN "opportunistic" boolean DEFAULT false NOT NULL;
CREATE INDEX "test_case_failures_op_path_idx" ON "test_case_failures" USING btree ("op_id","path");
CREATE INDEX "test_file_results_path_finished_idx" ON "test_file_results" USING btree ("path","finished_at" DESC NULLS LAST);
CREATE INDEX "test_file_results_path_digest_idx" ON "test_file_results" USING btree ("path","digest");
CREATE INDEX "test_file_results_op_idx" ON "test_file_results" USING btree ("op_id");
-- singularity:phase contract
-- singularity:claims
