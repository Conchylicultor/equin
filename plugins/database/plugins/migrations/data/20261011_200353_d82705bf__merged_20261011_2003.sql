-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "automation_launch_batches" (
	"automation_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "tasks_ext_launch_decision" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tasks_ext_sidequest_triage" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"context" text NOT NULL,
	"question" text,
	"answers" jsonb NOT NULL,
	"answer" text,
	"risk" text NOT NULL,
	"size_minutes" integer NOT NULL,
	"value" integer NOT NULL,
	"areas" jsonb NOT NULL,
	"main_sha" text NOT NULL,
	"source_title" text NOT NULL,
	"source_description" text NOT NULL,
	"triaged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tasks_trackChanged_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"track" text
);
CREATE INDEX IF NOT EXISTS "tasks_ext_launch_decision_automation_decision_idx" ON "tasks_ext_launch_decision" USING btree ("automation_id","decision");
CREATE INDEX IF NOT EXISTS "tasks_trackChanged_triggers_track_idx" ON "tasks_trackChanged_triggers" USING btree ("track") WHERE enabled;
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "tasks_ext_launch_decision" ADD CONSTRAINT "tasks_ext_launch_decision_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "tasks_ext_sidequest_triage" ADD CONSTRAINT "tasks_ext_sidequest_triage_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
