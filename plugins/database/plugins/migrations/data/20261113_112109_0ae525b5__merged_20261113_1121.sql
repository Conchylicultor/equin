-- singularity:snapshot id=ea23997c-6529-4f14-9c75-f504e197bf19 parents=969d851e-9a39-4cdb-972b-44c6d6126c36
-- singularity:supersedes a385713a
-- singularity:phase expand
ALTER TABLE "analytics_hits" ADD COLUMN "viewport" jsonb;
-- singularity:phase contract
-- singularity:claims
