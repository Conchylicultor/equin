-- singularity:phase expand
-- singularity:phase contract
ALTER TABLE "slow_ops" DROP COLUMN IF EXISTS "callers";
-- singularity:claims
