-- Custom SQL migration file, put your code below! --
-- migration: 20261028_003450__backfill_root_mandates --
-- Every root task states its mandate (tasks_root_has_mandate). The roots that
-- predate the column get the interactive preset — a frozen copy of
-- `interactiveMandate()` (tasks/mandate-presets), exactly what every agent was
-- allowed before mandates existed. Idempotent: only roots with none.
UPDATE "tasks"
SET "mandate" = '{"tasks.file":{"main":{"start":["after"]},"sidequest":{"start":["manual"]}},"push.policy":"never","exit.clean":true,"flag.raise":true}'::jsonb
WHERE "folder_id" IS NULL AND "mandate" IS NULL;
