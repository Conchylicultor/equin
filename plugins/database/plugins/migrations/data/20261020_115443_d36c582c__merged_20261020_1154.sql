-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "background_tasks" integer DEFAULT 0 NOT NULL;
ALTER TABLE "conversations" ADD COLUMN "working_on" text;
-- singularity:phase contract
-- singularity:claims
