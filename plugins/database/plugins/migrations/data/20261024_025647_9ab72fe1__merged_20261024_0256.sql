-- singularity:snapshot id=2cb28db2-5a12-4481-8a5e-031257c7d1d5 parents=b27ec59b-3fd4-49ab-858e-965fe29627f1
-- singularity:supersedes cb555e59
-- singularity:supersedes cb555e59 <- 9cd37925
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "tasks_ext_triage" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"stale_reason" text,
	"conversation_id" text,
	"run_task_id" text,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"triaged_at" timestamp with time zone,
	"error" text,
	"verdict" text,
	"priority" text,
	"task_type" text,
	"risk" text,
	"context" text,
	"question" text,
	"answers" jsonb NOT NULL,
	"answer" text,
	"areas" jsonb NOT NULL,
	"main_sha" text,
	"source_title" text,
	"source_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tasks_ext_triage_note" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tasks_descriptionChanged_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text
);
ALTER TABLE "tasks_ext_sidequest_triage" DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS "tasks_ext_launch_decision_automation_decision_idx";
CREATE INDEX IF NOT EXISTS "tasks_ext_triage_state_idx" ON "tasks_ext_triage" USING btree ("state","requested_at");
CREATE INDEX IF NOT EXISTS "tasks_ext_triage_conversation_idx" ON "tasks_ext_triage" USING btree ("conversation_id");
CREATE INDEX IF NOT EXISTS "tasks_descriptionChanged_triggers_taskId_idx" ON "tasks_descriptionChanged_triggers" USING btree ("task_id") WHERE enabled;
CREATE INDEX IF NOT EXISTS "tasks_ext_launch_decision_decision_idx" ON "tasks_ext_launch_decision" USING btree ("decision");
-- singularity:phase contract
DROP TABLE "tasks_ext_sidequest_triage" CASCADE;
DO $$ BEGIN
 ALTER TABLE "tasks_ext_triage" ADD CONSTRAINT "tasks_ext_triage_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "tasks_ext_triage_note" ADD CONSTRAINT "tasks_ext_triage_note_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "tasks_ext_launch_decision" DROP COLUMN IF EXISTS "automation_id";
-- singularity:claims
