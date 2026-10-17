-- singularity:phase expand
CREATE INDEX IF NOT EXISTS "conversations_updated_id_idx" ON "conversations" USING btree ("updated_at","id");
CREATE INDEX IF NOT EXISTS "tasks_updated_id_idx" ON "tasks" USING btree ("updated_at","id");
-- singularity:phase contract
-- singularity:claims
