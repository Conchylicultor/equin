-- singularity:snapshot id=3eae9304-169b-4ba5-9cd0-7179ea9f7118 parents=02649ede-c21c-49a2-8be8-299a7d9b6c00
-- singularity:supersedes a3fa2a32
-- singularity:phase expand
CREATE TABLE "conversations_ext_sdk_agent_stop" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_error" text,
	"account" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversations_ext_sdk_agent_stop" ADD CONSTRAINT "conversations_ext_sdk_agent_stop_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "conversations_ext_sdk_agent" DROP COLUMN "account";
ALTER TABLE "conversations_ext_sdk_agent" DROP COLUMN "stopped_at";
ALTER TABLE "conversations_ext_sdk_agent" DROP COLUMN "stop_error";
-- singularity:claims
-- 20261108_153714__sdk_agent_stop_backfill
