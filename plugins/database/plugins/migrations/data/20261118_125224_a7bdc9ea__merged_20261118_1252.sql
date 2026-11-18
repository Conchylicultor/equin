-- singularity:snapshot id=2cefce02-bbc5-4da0-b3a6-2070c7122962 parents=7191e1bd-f84b-4772-82db-c4873ab29e2c
-- singularity:supersedes ee956903
-- singularity:phase expand
DROP INDEX "notifications_dismissed_idx";
CREATE INDEX "notifications_window_idx" ON "notifications" USING btree ("dismissed","created_at" DESC NULLS LAST,"id");
-- singularity:phase contract
-- singularity:claims
