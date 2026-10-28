-- Custom SQL migration file, put your code below! --
-- migration: 20261028_140013__interactive_mandates_push_on_request --
-- An interactive mandate (one granting `exit.clean` — no automation's does)
-- pushes when the user asks, not "never": `never` is an automation's policy
-- and its text ("Do NOT push … raise a flag") contradicted a user's own
-- "push". Idempotent: only interactive mandates still on `never`.
UPDATE "tasks"
SET "mandate" = jsonb_set("mandate", '{push.policy}', '"on-request"'::jsonb)
WHERE "mandate" IS NOT NULL
  AND "mandate" ? 'exit.clean'
  AND "mandate"->>'push.policy' = 'never';
