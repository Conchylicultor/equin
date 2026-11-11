-- singularity:snapshot id=02d58d8b-b43b-41a2-90a4-406508e43580 parents=67c18c9b-e327-4d46-8134-4b3b4dddb922
-- singularity:supersedes 9c3b4e57
-- singularity:phase expand
ALTER TABLE "analytics_visit_members" ADD COLUMN "owner" boolean DEFAULT false NOT NULL;
ALTER TABLE "analytics_visits" ADD COLUMN "owner" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
