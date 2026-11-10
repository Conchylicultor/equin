-- singularity:snapshot id=c342f1f7-4c4c-4d7a-9ab6-2605720198b5 parents=7e75808b-75ec-4229-b01a-adef71190d39
-- singularity:supersedes 3f4e236a
-- singularity:phase expand
ALTER TABLE "analytics_hits" ADD COLUMN "load" jsonb;
-- singularity:phase contract
-- singularity:claims
