import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { recordPriceVersion } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { costUsageDir } from "../../data-dirs";
import { loadFallbackPriceTable } from "./litellm-fallback";
import {
  fetchPriceTable,
  loadPriceTable,
  mergePriceTable,
  savePriceTable,
} from "./price-table";
import { reportUnpricedModels } from "./unpriced";

const log = Log.channel("claude-pricing");

/** The persisted price table (`costUsageDir`), refreshed daily by main. */
export const PRICE_TABLE_PATH = costUsageDir.file("price-table.json");

/**
 * The table held on disk, or the vendored LiteLLM snapshot when this machine
 * never fetched one (first boot, offline) — never an empty table, which would
 * leave every model unpriced.
 */
async function heldPriceTable() {
  const persisted = await loadPriceTable(PRICE_TABLE_PATH);
  return persisted === null
    ? { table: await loadFallbackPriceTable(), source: "fallback" as const }
    : { table: persisted, source: "litellm" as const };
}

/**
 * Fetch LiteLLM's live table, merge it into what we hold (never dropping a
 * key — a model BerriAI has since pruned keeps the price we learned), persist
 * it, and record it as the dated price history's next version — effective
 * now, and only when a rate moved, so past hours keep the price they were
 * used at (`recordPriceVersion`).
 */
async function refreshPriceTable(): Promise<{ models: number }> {
  const [{ table: held }, fetched] = await Promise.all([
    heldPriceTable(),
    fetchPriceTable(),
  ]);
  const next = mergePriceTable(held, fetched);
  await savePriceTable(PRICE_TABLE_PATH, next);
  await recordPriceVersion(db, next, "litellm");
  return { models: Object.keys(next.models).length };
}

// Daily at 05:00 UTC, off-peak. `perWorktree` is OMITTED: graphile's fleet-wide
// cron runs it once per tick on MAIN — the table is host-global, and the
// version it records lands in main's database, which every fork copies. A tick
// missed while the machine slept or main was down runs once at main's next
// start (`catchUpWithinMs`).
export const priceTableRefreshJob = defineJob({
  name: "claude-cli.pricing.refresh",
  description:
    "Updates the Claude model prices from LiteLLM, records a new price version when a rate moved, and reports the models still unpriced.",
  // seconds: fetches the LiteLLM price table over the network, bounded by
  // safeFetch's own 20s timeout, then one aggregate over the priced ledger.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: {
    cron: "0 5 * * *",
    catchUpWithinMs: 7 * 24 * 60 * 60 * 1000,
  },
  async run() {
    // Prices first, so a model LiteLLM has just published is priced on the
    // same tick rather than reported as missing and resolved a day later.
    const { models } = await refreshPriceTable();
    const unpriced = await reportUnpricedModels(db);
    log.publish(
      `price table refreshed (${models} models); ${unpriced} model(s) unpriced`,
    );
  },
});

// The ledger's prices from the first boot on, not from the first daily
// refresh: with no version recorded yet the table held now becomes the first
// (effective from -infinity); with one, a no-op unless the persisted table
// moved while no process recorded it. `host` scope, like the refresh: main's
// database is the one forks copy.
export const priceVersionWarmup = defineWarmup({
  name: "claude-cli.pricing.record",
  description:
    "Records the Claude price table held on this computer as the price history's version, when it is not recorded yet.",
  scope: "host",
  run: async () => {
    const { table, source } = await heldPriceTable();
    await recordPriceVersion(db, table, source);
  },
});
