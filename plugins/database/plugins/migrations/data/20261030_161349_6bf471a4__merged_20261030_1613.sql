-- singularity:snapshot id=83662d2d-ddf5-4f51-a8b4-c91bc7a69db3 parents=9a7763a4-59ef-4505-8344-b5648e4e0471
-- singularity:supersedes 0eeff18e
-- singularity:phase expand
CREATE TABLE "tasks_refiled_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text
);
CREATE INDEX "tasks_refiled_triggers_taskId_idx" ON "tasks_refiled_triggers" USING btree ("task_id") WHERE enabled;
-- singularity:phase contract
-- singularity:claims
