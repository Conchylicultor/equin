-- singularity:phase expand
ALTER TABLE "tasks_ext_runtime" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ALTER COLUMN "runtime" SET DEFAULT 'sdk';
-- singularity:phase contract
DROP TABLE "tasks_ext_runtime" CASCADE;
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "waiting_menu";
-- singularity:claims
