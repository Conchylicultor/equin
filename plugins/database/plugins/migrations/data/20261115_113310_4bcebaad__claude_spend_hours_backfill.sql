-- Custom SQL migration file, put your code below! --
-- migration: 20261115_113310__claude_spend_hours_backfill --
-- The per-day account spend (conversation_usage_account_days) moves into the
-- one spend ledger, claude_spend_hours (plugins/infra/plugins/claude-cli/plugins/
-- spend-ledger/server/internal/tables.ts): each (account, day) row becomes the
-- row of 00:00 UTC that day, source 'unattributed' — the history predates the
-- ledger keeping what spent it. The month chart, summed per day, is unchanged.
--
-- Idempotent and convergent: the new code never writes 'unattributed', so a
-- re-run (the deferred contract re-runs claimed data) sets each migrated row
-- to the day row as it stands — including what the old code still added
-- during the hot-swap.

INSERT INTO "claude_spend_hours" ("account_id", "hour", "source", "cost_usd")
SELECT d.account_id,
       (d.date || 'T00:00:00Z')::timestamptz,
       'unattributed',
       d.cost_usd
FROM "conversation_usage_account_days" AS d
ON CONFLICT ("account_id", "hour", "source")
DO UPDATE SET "cost_usd" = excluded.cost_usd;
