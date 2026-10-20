-- Custom SQL migration file, put your code below! --
-- migration: 20261020_131216__retire_tmux_rows --
-- The tmux runtime is retired: every conversation still on it moves to sdk.
-- Replaces the boot step that did the same (runtime-sdk adopt-tmux-rows),
-- minus its session kill — no tmux-runtime agent is left running. A row that
-- claims a live process is hibernated, so its next Send resumes it on sdk from
-- its transcript; one left mid-turn settles to waiting. `done` and `gone` rows
-- only change runtime (a fork inherits its source's). Idempotent: it touches
-- only `tmux` rows.
UPDATE "conversations"
SET
  "hibernated_at" = coalesce("hibernated_at", now()),
  "status" = CASE WHEN "status" IN ('working', 'starting') THEN 'waiting' ELSE "status" END,
  "waiting_for" = CASE WHEN "status" IN ('working', 'starting') THEN NULL ELSE "waiting_for" END
WHERE "runtime" = 'tmux' AND "status" IN ('starting', 'working', 'waiting');
UPDATE "conversations" SET "runtime" = 'sdk' WHERE "runtime" = 'tmux';
