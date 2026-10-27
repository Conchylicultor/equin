-- singularity:snapshot id=d3669c1b-4e81-4fe9-9422-951f400977e8 parents=1f1284dd-9acd-4904-8306-9321d36136bb
-- singularity:supersedes 0ab4e967
-- singularity:phase expand
ALTER TABLE "site_messages" ADD COLUMN "confirm_state" text DEFAULT 'skipped' NOT NULL;
ALTER TABLE "site_messages" ADD COLUMN "confirm_error" text;
ALTER TABLE "site_messages" ADD COLUMN "confirmed_at" timestamp with time zone;
CREATE INDEX "site_messages_confirm_state_idx" ON "site_messages" USING btree ("confirm_state","confirmed_at");
-- singularity:phase contract
-- singularity:claims
