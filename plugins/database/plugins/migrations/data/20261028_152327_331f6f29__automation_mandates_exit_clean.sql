-- Custom SQL migration file, put your code below! --
-- migration: 20261028_152327__automation_mandates_exit_clean --
-- Every automation mandate grants `exit.clean`, so a person can ask its agent
-- to wrap up. Interactive mandates always had it, so a stored mandate lacking
-- it is an automation's. Runs after interactive_mandates_push_on_request, which
-- still told the two apart by `exit.clean`. Idempotent.
UPDATE "tasks"
SET "mandate" = "mandate" || '{"exit.clean": true}'::jsonb
WHERE "mandate" IS NOT NULL
  AND NOT ("mandate" ? 'exit.clean');
