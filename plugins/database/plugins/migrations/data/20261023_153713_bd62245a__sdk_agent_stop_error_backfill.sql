-- Custom SQL migration file, put your code below! --
-- migration: 20261023_153713__sdk_agent_stop_error_backfill --
-- Before stop_error existed, only a usage limit set the stop (limit_hit_at,
-- now stopped_at): every stop already recorded is a usage limit.
UPDATE "conversations_ext_sdk_agent" SET "stop_error" = 'rate_limit' WHERE "stopped_at" IS NOT NULL AND "stop_error" IS NULL;
