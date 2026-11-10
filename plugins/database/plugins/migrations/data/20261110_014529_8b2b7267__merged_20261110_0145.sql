-- singularity:snapshot id=7e75808b-75ec-4229-b01a-adef71190d39 parents=2a8bf372-bcfc-48b7-86e3-06257782d659
-- singularity:supersedes cfde2b78
-- singularity:phase expand
ALTER TABLE "analytics_hits" ADD COLUMN "gaps" jsonb;
-- singularity:phase contract
-- singularity:claims
