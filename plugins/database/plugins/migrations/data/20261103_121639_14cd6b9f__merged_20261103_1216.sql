-- singularity:snapshot id=abb0a4f2-74ab-45cb-a572-867943fc2c87 parents=409d9e32-4a9f-4e9c-99e7-e221f7422695
-- singularity:supersedes 3bf93bec
-- singularity:phase expand
ALTER TABLE "tasks_ext_mandate" ADD COLUMN "source_task_id" text;
-- singularity:phase contract
ALTER TABLE "tasks_ext_mandate" ALTER COLUMN "source_task_id" SET NOT NULL;
-- singularity:claims
-- 20261103_120557__tasks_mandate_source_backfill
