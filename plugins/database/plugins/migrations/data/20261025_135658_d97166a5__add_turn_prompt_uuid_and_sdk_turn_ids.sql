-- singularity:snapshot id=8491fcb8-5917-464c-896f-4aeee1e9eea8 parents=fe4f5486-32b0-491a-bd3a-cefcb1d71eff
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "turn_ids" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_turns" ADD COLUMN "prompt_uuid" text;
-- singularity:phase contract
-- singularity:claims
