-- Custom SQL migration file, put your code below! --
-- migration: 20261116_013956__usage_ledger_legacy_carryover --
--
-- What the token ledger keeps of the legacy dollar ledger (claude_spend_hours),
-- copied in the group that drops it (after expand, before contract): its
-- `unattributed` dollars per account and UTC day (no source or model behind
-- them, so they cannot become tokens) into claude_account_spend_carryover, and
-- the one account each conversation hour was spent on into
-- claude_usage_import_accounts, for the one-shot history import that runs
-- after this boot (conversations/usage machine/internal/history-import.ts).
-- Idempotent: the deferred contract re-runs it before the drop, so a write the
-- old code made meanwhile is copied too.
INSERT INTO claude_account_spend_carryover (account_id, day, cost_usd)
SELECT account_id, (hour AT TIME ZONE 'UTC')::date, sum(cost_usd)
  FROM claude_spend_hours
 WHERE source = 'unattributed'
 GROUP BY account_id, (hour AT TIME ZONE 'UTC')::date
ON CONFLICT DO NOTHING;

DELETE FROM claude_usage_import_accounts;

INSERT INTO claude_usage_import_accounts (source, hour, account_id)
SELECT source, hour, min(account_id)
  FROM claude_spend_hours
 WHERE source LIKE 'conv:%'
 GROUP BY source, hour
HAVING count(DISTINCT account_id) = 1;
