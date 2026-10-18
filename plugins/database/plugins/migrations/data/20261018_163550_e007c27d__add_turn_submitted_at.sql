-- singularity:phase expand
ALTER TABLE "conversation_turns" ADD COLUMN "submitted_at" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
