-- Custom SQL migration file, put your code below! --
-- migration: 20261105_032419__backfill_task_cluster_id --

-- `tasks.cluster_id` becomes total (NOT NULL): the cluster-scoped read
-- (`taskClusterRows`, one tuple per label) needs every task to name its scope.
-- A NULL label meant "never unioned ⇒ its own singleton", so the singleton's
-- label is its own id — exactly what `createTask` now writes on insert, and
-- what `unionTaskClusters` used to read a NULL as. Idempotent (guarded), as a
-- claimed data migration must be: the deferred contract re-runs it before the
-- SET NOT NULL, catching rows the outgoing backend inserted meanwhile.
UPDATE "tasks" SET "cluster_id" = "id" WHERE "cluster_id" IS NULL;
