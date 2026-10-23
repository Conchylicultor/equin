-- singularity:snapshot id=b27ec59b-3fd4-49ab-858e-965fe29627f1 parents=25f13bab-3212-49ba-b020-e004beac078b
-- singularity:supersedes ca582553
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" RENAME COLUMN "limit_hit_at" TO "stopped_at";
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "stop_error" text;
-- singularity:phase contract
-- singularity:claims
-- 20261023_153713__sdk_agent_stop_error_backfill
