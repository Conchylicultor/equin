-- singularity:snapshot id=a091aac2-c955-46f2-bc28-188916b4e66e parents=01ac77b3-0ac7-4676-8098-c8f14fb421cb
-- singularity:supersedes 5bff2fe6
-- singularity:phase expand
ALTER TABLE "reports" ADD COLUMN "recent" jsonb DEFAULT '[]'::jsonb NOT NULL;
-- singularity:phase contract
-- singularity:claims
