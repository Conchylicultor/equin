-- singularity:snapshot id=1f1284dd-9acd-4904-8306-9321d36136bb parents=48c31ec0-ed1a-4324-8e0f-7e161a4191e4
-- singularity:supersedes e68e5e4a
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "turn_ids" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversations" ADD COLUMN "status_unverified_since" timestamp with time zone;
-- singularity:phase contract
ALTER TABLE "conversations_ext_sdk_agent" DROP COLUMN IF EXISTS "last_prompt_text";
ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "extra_text";
ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "submitted_text";
-- singularity:claims
-- 20261025_144630__retire_text_matched_turns
