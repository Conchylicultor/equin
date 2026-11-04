-- singularity:snapshot id=47a1b1b9-4d5a-4dba-ac95-efa8a1d67c54 parents=649805cf-1a45-460d-8eaf-699ba6d30fa8
-- singularity:supersedes 6ccc7a6f
-- singularity:phase expand
ALTER TABLE "conversations" ADD COLUMN "status_since" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
