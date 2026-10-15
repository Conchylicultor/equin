-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "tasks_ext_subject" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "tasks_ext_subject_subject_idx" ON "tasks_ext_subject" USING btree ("subject_kind","subject_id");
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "tasks_ext_subject" ADD CONSTRAINT "tasks_ext_subject_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
