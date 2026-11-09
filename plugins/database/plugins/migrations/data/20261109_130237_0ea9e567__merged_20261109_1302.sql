-- singularity:snapshot id=2a8bf372-bcfc-48b7-86e3-06257782d659 parents=5a4fd7d6-7591-4922-acc5-06cf38ad6f70
-- singularity:supersedes bd847fba
-- singularity:phase expand
ALTER TABLE "notifications" ADD COLUMN "state_tone" text GENERATED ALWAYS AS (state ->> 'tone') STORED;
-- singularity:phase contract
-- singularity:claims
