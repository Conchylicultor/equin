-- Custom SQL migration file, put your code below! --
-- migration: 20261103_120557__tasks_mandate_source_backfill --
-- Every task's mandate source (tasks_ext_mandate.source_task_id): the task
-- whose own mandate_ref is in effect — itself when it states one, else the
-- nearest ancestor that does. Idempotent: it runs again before the deferred
-- contract (rows the old code wrote meanwhile carry no source).
WITH RECURSIVE down(id, src) AS (
  SELECT id, id FROM tasks WHERE folder_id IS NULL AND mandate_ref IS NOT NULL
  UNION ALL
  SELECT c.id, CASE WHEN c.mandate_ref IS NULL THEN d.src ELSE c.id END
    FROM tasks c JOIN down d ON c.folder_id = d.id
)
UPDATE tasks_ext_mandate m
   SET source_task_id = d.src
  FROM down d
 WHERE m.parent_id = d.id
   AND m.source_task_id IS DISTINCT FROM d.src;
