-- singularity:snapshot id=a7a42ca0-259a-4d36-b1af-6d92ff33b2b0 parents=493325f8-8282-437b-94df-4d473c50c8a3
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "account" text;
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "limit_hit_at" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
