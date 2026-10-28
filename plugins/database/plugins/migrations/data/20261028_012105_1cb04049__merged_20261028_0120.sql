-- singularity:snapshot id=3cc2f59b-547f-488d-9a43-971e3d0a385c parents=d3669c1b-4e81-4fe9-9422-951f400977e8
-- singularity:supersedes fc69aefa 454cf2ef
-- singularity:supersedes fc69aefa <- 04ee4d27
-- singularity:phase expand
ALTER TABLE "notifications" ADD COLUMN "subject_id" text;
ALTER TABLE "notifications" ADD COLUMN "subject_name" text;
ALTER TABLE "notifications" ADD COLUMN "detail" text;
ALTER TABLE "notifications" ADD COLUMN "icon" jsonb;
ALTER TABLE "notifications" ADD COLUMN "action" jsonb;
ALTER TABLE "notifications" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;
-- singularity:phase contract
-- singularity:claims
