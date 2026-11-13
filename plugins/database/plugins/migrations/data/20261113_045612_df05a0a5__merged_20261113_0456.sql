-- singularity:snapshot id=969d851e-9a39-4cdb-972b-44c6d6126c36 parents=41eb71df-eab0-4952-8ede-5d13fff96fdd
-- singularity:supersedes a155eb29
-- singularity:phase expand
ALTER TABLE "tasks_ext_auto_start" ADD COLUMN "armed_from" text;
ALTER TABLE "conversations" ADD COLUMN "launch_cause" text;
ALTER TABLE "conversations" ADD COLUMN "launched_from" text;
-- singularity:phase contract
ALTER TABLE "tasks_ext_auto_start" ALTER COLUMN "armed_from" SET NOT NULL;
ALTER TABLE "conversations" ALTER COLUMN "launch_cause" SET NOT NULL;
ALTER TABLE "conversations" DROP COLUMN "spawned_by";
-- singularity:claims
-- 20261113_044755__conversation_launch_cause
