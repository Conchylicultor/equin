-- migration: 20261113_044755__conversation_launch_cause --
-- The conversation's free-text `spawned_by` becomes why it was launched
-- (`launch_cause`, a closed set) and the plugin that launched it
-- (`launched_from`, a plugin id); the auto-start marker gains the plugin that
-- armed it (`armed_from`). The new columns are added by this push's expand
-- phase; `spawned_by` is dropped, and the two NOT NULLs set, by its contract.
-- Idempotent: it runs again before the deferred contract, for rows the
-- previous code wrote in between.
-- Design: research/2026-11-13-conversations-typed-launch-cause.md.
--
-- Cause. `user-launch` was written both by the Launch button and by arming
-- from a UI create — the string cannot tell them apart, so it reads `direct`
-- (the common case). The runtime namespace (`singularity`, the old fallback),
-- the launchers' own names and NULL were all direct launches.
UPDATE "conversations" SET "launch_cause" = CASE
    WHEN "spawned_by" IN ('status-changed', 'dep-resolved', 'dep-unblocked', 'slot-freed') THEN 'unblocked'
    WHEN "spawned_by" IN ('auto-start', 'mcp-add-task', 'mcp-edit-task', 'help-ask', 'deps-outdated')
      OR "spawned_by" LIKE 'automation:%' THEN 'armed'
    WHEN "spawned_by" = 'boot-reconcile' THEN 'reconcile'
    WHEN "spawned_by" = 'poller' THEN 'adopted'
    ELSE 'direct'
  END
  WHERE "launch_cause" IS NULL;
-- Launched from: only where the old string names the plugin for certain. A
-- NULL reads as "launched before it was recorded".
UPDATE "conversations" SET "launched_from" = CASE
    WHEN "spawned_by" = 'task-triage' THEN 'tasks.task-triage'
    WHEN "spawned_by" = 'agents-plugin' THEN 'conversations.agents'
    WHEN "spawned_by" = 'conversation-summary' THEN 'conversations.summary'
    WHEN "spawned_by" = 'sonata-transcription' THEN 'apps.sonata.transcription'
    WHEN "spawned_by" = 'narrowing-fixture' THEN 'debug.read-set'
    WHEN "spawned_by" LIKE 'automation:%' THEN 'tasks.automations'
    WHEN "spawned_by" IN ('mcp-add-task', 'mcp-edit-task') THEN 'tasks'
    WHEN "spawned_by" = 'help-ask' THEN 'hints.ask'
  END
  WHERE "launched_from" IS NULL AND "spawned_by" IS NOT NULL;
-- A task armed before the armer was recorded: the launcher's own plugin.
UPDATE "tasks_ext_auto_start" SET "armed_from" = 'tasks.auto-start'
  WHERE "armed_from" IS NULL;
