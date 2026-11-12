-- singularity:snapshot id=e5b9fa82-4691-469d-94e4-128f9b69d957 parents=e7717784-cef6-42c8-b357-cf2e617660cb
-- singularity:supersedes 13d072a4
-- singularity:phase expand
DROP INDEX "analytics_visits_started_at_idx";
CREATE INDEX "analytics_visits_started_at_id_idx" ON "analytics_visits" USING btree ("started_at","id");
-- singularity:phase contract
-- singularity:claims
