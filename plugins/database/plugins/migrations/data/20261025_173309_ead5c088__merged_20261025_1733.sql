-- singularity:snapshot id=48c31ec0-ed1a-4324-8e0f-7e161a4191e4 parents=5219360d-92c5-495c-bcd1-027ba083997d
-- singularity:supersedes d19b0933
-- singularity:supersedes d19b0933 <- 98a7db28
-- singularity:phase expand
ALTER TABLE "conversation_turns" ADD COLUMN "prompt_uuid" text;
-- singularity:phase contract
-- singularity:claims
