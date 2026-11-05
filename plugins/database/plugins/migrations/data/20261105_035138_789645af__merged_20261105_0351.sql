-- singularity:snapshot id=fec7dc19-91b4-405f-8c3e-4d7cd4ffa73b parents=aa274962-ff32-4eab-8eef-cffd545a145c
-- singularity:supersedes 3c9487b6
-- singularity:phase expand
-- singularity:phase contract
ALTER TABLE "tasks" ALTER COLUMN "cluster_id" SET NOT NULL;
-- singularity:claims
-- 20261105_032419__backfill_task_cluster_id
