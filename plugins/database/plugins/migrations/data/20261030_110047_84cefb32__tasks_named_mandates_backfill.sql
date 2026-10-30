-- Custom SQL migration file, put your code below! --
-- migration: 20261030_110047__tasks_named_mandates_backfill --
-- Named mandates (research/2026-10-30-tasks-named-mandates.md): every task's
-- stored grants become the id of the named mandate they were built from, and
-- every task gets its effective mandate in tasks_ext_mandate. Idempotent: it
-- runs again before the deferred contract (rows the old code wrote meanwhile).

-- 1. The stated mandates: a task an automation filed or launched names that
--    automation's; one granting watch.tree (whole tree, or the root's own
--    scope in the current shape) the supervisor's; any other the interactive
--    one — the only three the code ever stated.
UPDATE tasks t
   SET mandate_ref = CASE
         WHEN o.automation_id IS NOT NULL THEN 'automation:' || o.automation_id
         WHEN t.mandate ? 'watch.tree'
           OR COALESCE(t.mandate -> '@root', '{}'::jsonb) ? 'watch.tree'
           THEN 'supervisor'
         ELSE 'interactive'
       END
  FROM tasks s
  LEFT JOIN tasks_ext_origin o ON o.parent_id = s.id
 WHERE s.id = t.id
   AND t.mandate IS NOT NULL
   AND t.mandate_ref IS NULL;

-- 2. Every task's effective mandate: its own, else its nearest ancestor's.
WITH RECURSIVE down(id, eff) AS (
  SELECT id, mandate_ref FROM tasks WHERE folder_id IS NULL
  UNION ALL
  SELECT c.id, COALESCE(c.mandate_ref, d.eff)
    FROM tasks c JOIN down d ON c.folder_id = d.id
)
INSERT INTO tasks_ext_mandate (parent_id, mandate_id)
SELECT id, eff FROM down WHERE eff IS NOT NULL
ON CONFLICT (parent_id) DO UPDATE
   SET mandate_id = EXCLUDED.mandate_id
 WHERE tasks_ext_mandate.mandate_id IS DISTINCT FROM EXCLUDED.mandate_id;
