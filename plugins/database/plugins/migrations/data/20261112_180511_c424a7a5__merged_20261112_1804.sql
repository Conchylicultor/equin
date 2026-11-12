-- singularity:snapshot id=5e709931-62cf-4485-8d0d-7e7374f6badc parents=d6e0e122-808b-43d5-8ec7-04fb4f4196f8
-- singularity:supersedes fa8f09cf
-- singularity:supersedes fa8f09cf <- 08016418
-- singularity:phase expand
ALTER TABLE "site_messages" ALTER COLUMN "ip_hash" DROP NOT NULL;
-- singularity:phase contract
-- singularity:claims
