-- The task's free-text `author` becomes a typed author (`author_kind`, plus
-- `author_conversation_id` for an agent) and the surface it was filed from
-- (`filed_from`, a plugin id). The new columns are added by this push's expand
-- phase; `author` is dropped, and `author_kind` made NOT NULL, by its contract.
-- Idempotent: it runs again before the deferred contract, for rows the previous
-- code wrote in between.
--
-- Agent: a conversation id (`conv-…`, legacy `claude-…`).
UPDATE "tasks" SET "author_kind" = 'agent', "author_conversation_id" = "author"
  WHERE "author_kind" IS NULL AND ("author" LIKE 'conv-%' OR "author" LIKE 'claude-%');
-- Human: filed from the UI (`user`, the draft form into a category as
-- `improve-plugin`, a fresh conversation as the runtime namespace `singularity`,
-- or nothing at all), or by a button whose only effect is filing it
-- (Investigate on a report, Launch on a saved agent, Sonata transcription).
UPDATE "tasks" SET "author_kind" = 'human'
  WHERE "author_kind" IS NULL AND ("author" IS NULL OR "author" IN (
    'user', 'improve-plugin', 'singularity', 'reports-plugin', 'agents-plugin',
    'sonata-transcription'));
-- System: every other name a piece of code stamped (triage, automations,
-- deps upgrades, the old crash tasks, …).
UPDATE "tasks" SET "author_kind" = 'system' WHERE "author_kind" IS NULL;
-- Filed from: only where the old name says which plugin for certain. A NULL
-- reads as "filed before it was recorded".
UPDATE "tasks" SET "filed_from" = CASE
    WHEN "author" = 'task-triage' THEN 'tasks.task-triage'
    WHEN "author" LIKE 'automation:%' THEN 'tasks.automations'
    WHEN "author" = 'reports-plugin' THEN 'reports.engine'
    WHEN "author" = 'agents-plugin' THEN 'conversations.agents'
    WHEN "author" = 'sonata-transcription' THEN 'apps.sonata.transcription'
    WHEN "author" LIKE 'deps.%' THEN 'infra.deps.updates'
  END
  WHERE "filed_from" IS NULL AND "author" IS NOT NULL;
