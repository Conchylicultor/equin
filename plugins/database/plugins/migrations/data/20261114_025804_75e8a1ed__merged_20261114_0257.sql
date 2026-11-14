-- singularity:snapshot id=1f7e2de8-b76b-43c5-b253-ea6d51c35845 parents=610c209d-89ce-45c5-af92-9f273c47ec87
-- singularity:supersedes a2fc2409
-- singularity:supersedes a2fc2409 <- b455df80
-- singularity:phase expand
DROP INDEX "supervisor_roles_one_fallback_idx";
-- singularity:phase contract
ALTER TABLE "supervisor_roles" DROP COLUMN "fallback";
-- singularity:claims
