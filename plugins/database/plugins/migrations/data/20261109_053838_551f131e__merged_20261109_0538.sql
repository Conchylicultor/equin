-- singularity:snapshot id=5a4fd7d6-7591-4922-acc5-06cf38ad6f70 parents=ec004e9a-f993-422b-9ad4-0c1f7b14556a
-- singularity:supersedes d8cae46e
-- singularity:phase expand
-- singularity:phase contract
ALTER TABLE "prototype_state" DROP COLUMN "pinned";
-- singularity:claims
