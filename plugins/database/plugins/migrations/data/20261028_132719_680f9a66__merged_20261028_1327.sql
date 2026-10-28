-- singularity:snapshot id=35e0e396-7f2a-48de-aa13-1772d8c11f0f parents=3cc2f59b-547f-488d-9a43-971e3d0a385c
-- singularity:supersedes 07e4a58d
-- singularity:supersedes 07e4a58d <- a00b9498 84804f51
-- singularity:phase expand
CREATE TABLE "digest_cursors" (
	"conversation_id" text NOT NULL,
	"root_task_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_cursors_conversation_id_root_task_id_pk" PRIMARY KEY("conversation_id","root_task_id")
);
ALTER TABLE "tasks" ADD COLUMN "mandate" jsonb;
-- singularity:phase contract
ALTER TABLE "digest_cursors" ADD CONSTRAINT "digest_cursors_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "digest_cursors" ADD CONSTRAINT "digest_cursors_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_root_has_mandate" CHECK ("tasks"."folder_id" IS NOT NULL OR "tasks"."mandate" IS NOT NULL);
-- singularity:claims
-- 20261028_003450__backfill_root_mandates
