import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The host-global Claude price-table dir (named `cost-usage` for the files it
 * already holds): `price-table.json`, our merge-only copy of LiteLLM's table
 * the daily refresh fetches into and the price history is recorded from — and,
 * left in place, read-only, the legacy year-sharded cost archive
 * (`sessions-<YYYY>.json`) Stats → Cost banked before the token ledger, the
 * only copy of deleted transcripts' usage until conversations/usage's one-shot
 * history import has read it into main's database.
 *
 * Host-global: one price table per machine, refreshed by main.
 */
export const costUsageDir = defineDataDir({
  kind: "state",
  name: "cost-usage",
  owner: "infra/claude-cli/usage-ledger/pricing/price-table",
  description:
    "Host-global Claude price table (our merge-only copy of LiteLLM's), plus the legacy year-sharded cost archive the token ledger's history import reads",
  // The legacy archive's shards are the only record of deleted transcripts'
  // usage until main has imported them; nothing reclaims the dir.
  reclaim: {
    kind: "never",
    reason:
      "the legacy cost archive beside the price table holds usage of transcripts already deleted, which nothing can rebuild",
  },
});

export default [costUsageDir];
