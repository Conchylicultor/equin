-- singularity:snapshot id=9fe1ee25-1a1d-4559-a3b4-b6d00a9aa2fd parents=4ee37412-44b1-4161-9867-b0103bd0c18f
-- singularity:supersedes e8426a6b
-- singularity:supersedes e8426a6b <- 869feeac
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "account" text;
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "limit_hit_at" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
