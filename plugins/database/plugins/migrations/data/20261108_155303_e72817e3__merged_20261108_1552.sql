-- singularity:snapshot id=02649ede-c21c-49a2-8be8-299a7d9b6c00 parents=59f5fa0f-368d-4bae-953a-1830707e831d
-- singularity:supersedes 9a2e08d7
-- singularity:phase expand
ALTER TABLE "reports" ADD COLUMN "hourly" jsonb;
-- singularity:phase contract
-- singularity:claims
