-- Custom SQL migration file, put your code below! --
-- migration: 20261108_153714__sdk_agent_stop_backfill --
-- The stop fields (stopped_at, stop_error, account) move from the agent's
-- checkpoint row to its own stop row, which a live surface reads. Copied for
-- every agent that has one of them set; idempotent (an agent the new code
-- already wrote keeps its row).
INSERT INTO "conversations_ext_sdk_agent_stop" ("parent_id", "stopped_at", "stop_error", "account")
SELECT "parent_id", "stopped_at", "stop_error", "account"
FROM "conversations_ext_sdk_agent"
WHERE "stopped_at" IS NOT NULL OR "stop_error" IS NOT NULL OR "account" IS NOT NULL
ON CONFLICT ("parent_id") DO NOTHING;
