-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "tasks_ext_workspace" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "tasks_ext_workspace" ADD CONSTRAINT "tasks_ext_workspace_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
