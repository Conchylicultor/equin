-- singularity:snapshot id=e7a19f00-9c2a-4230-a842-9a231aaa0e1e parents=fd8e6d51-87e3-4406-bf01-dbfaf234adc1
-- singularity:supersedes 5a762cd9
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "cli_ready" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
