-- singularity:snapshot id=21e29e17-d798-48d9-a76a-9b6b861c067c parents=3886a0de-61e0-4fbb-9967-fd93a53098c3
-- singularity:supersedes 87da44fd
-- singularity:phase expand
CREATE TABLE "tasks_ext_manager" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"manager_task_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "tasks_ext_manager" ADD CONSTRAINT "tasks_ext_manager_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
