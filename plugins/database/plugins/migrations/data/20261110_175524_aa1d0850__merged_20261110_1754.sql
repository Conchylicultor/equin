-- singularity:snapshot id=d1b7b216-f7ce-41e6-ada6-15b9d564aeb6 parents=c342f1f7-4c4c-4d7a-9ab6-2605720198b5
-- singularity:supersedes f02278dd
-- singularity:phase expand
ALTER TABLE "analytics_hits" ADD COLUMN "sections" jsonb;
-- singularity:phase contract
-- singularity:claims
