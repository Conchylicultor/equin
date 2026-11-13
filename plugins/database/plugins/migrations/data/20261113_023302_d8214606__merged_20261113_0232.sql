-- singularity:snapshot id=775d7df0-5d4f-4f98-989e-1ffb44f91a08 parents=72e30f20-661f-4b9a-ba8b-be89e06cdbb8
-- singularity:supersedes b9b33eeb
-- singularity:phase expand
ALTER TABLE "tasks" ADD COLUMN "author_kind" text;
ALTER TABLE "tasks" ADD COLUMN "author_conversation_id" text;
ALTER TABLE "tasks" ADD COLUMN "filed_from" text;
-- singularity:phase contract
ALTER TABLE "tasks" ALTER COLUMN "author_kind" SET NOT NULL;
ALTER TABLE "tasks" DROP COLUMN "author";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_author_agent_has_conversation" CHECK (("tasks"."author_kind" = 'agent') = ("tasks"."author_conversation_id" IS NOT NULL));
-- singularity:claims
-- 20261113_021936__task_author_kind
