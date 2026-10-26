-- singularity:snapshot id=9ce97a5e-18b8-41c1-bd27-f6339050fe8a parents=8491fcb8-5917-464c-896f-4aeee1e9eea8
-- singularity:phase expand
-- singularity:phase contract
ALTER TABLE "conversations_ext_sdk_agent" DROP COLUMN IF EXISTS "last_prompt_text";
ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "extra_text";
ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "submitted_text";
-- singularity:claims
-- 20261025_144630__retire_text_matched_turns
