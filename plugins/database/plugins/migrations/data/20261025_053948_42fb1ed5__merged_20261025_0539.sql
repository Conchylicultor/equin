-- singularity:snapshot id=b92275ca-b08c-414c-ae94-6e12a85459b3 parents=50b13286-8c74-4cf7-be6d-b5d4e2f31062
-- singularity:supersedes 22d6fd6e
-- singularity:phase expand
ALTER TABLE "conversation_usage_files" ADD COLUMN "cost_usd" double precision;
ALTER TABLE "conversation_usage_files" ADD COLUMN "unpriced_models" jsonb DEFAULT '[]'::jsonb NOT NULL;
-- singularity:phase contract
-- singularity:claims
