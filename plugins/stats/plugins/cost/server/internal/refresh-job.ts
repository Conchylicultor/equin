import { z } from "zod";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { captureCostHistory, refreshPriceTable } from "./load-usage";

const log = Log.channel("stats-cost");

// The archive's durable heartbeat: once a day, learn today's prices and bank the
// current token state.
//
// Daily is the right cadence, not a compromise: Claude Code only deletes a
// transcript after `cleanupPeriodDays` (default 30) of untouched mtime, so a
// daily flush leaves a ~30× safety margin, and the "created and deleted between
// two flushes" window a 30-day GC would have to produce does not exist. Flushing
// per read instead would put a whole-shard `JSON.stringify` on the serving path.
//
// 05:00 UTC: off-peak, and after `conversations.transcript-touch` (04:00) so the
// touch has already refreshed the mtimes of everything worth retaining.
//
// A tick missed while the machine slept or main was down runs once at main's
// next start (`catchUpWithinMs`, graphile's cron backfill). That is what lets
// the boot warm-up NOT capture: it used to, on every one of main's ~74 boots a
// day, to cover exactly this missed tick — re-parsing the whole archive (~8 MB),
// re-pricing every session and re-writing the year's shard each time
// (0.8 s quiet, up to 22 s under host load).
//
// `perWorktree` is OMITTED, so graphile's fleet-wide cron runs this once per tick
// on MAIN. That is deliberate — the corpus index, the price table and the archive
// are all host-global (`costUsageDir`), and N worktree backends racing to write
// the same shards would be pure contention.
//
// KNOWN GAP (deferred, not an oversight): **the archive is dev-only today.**
// Its one write path is gated on `isMain()` upstream of this plugin, and
// `isMain()` is FALSE in a compiled release — the single release backend runs
// under its composition name:
//
//   • this cron never installs — `buildCronItems` skips every non-`perWorktree`
//     schedule when `!isMain()`
//     (`plugins/infra/plugins/jobs/machine/internal/worker.ts`).
//
// So in a release nothing calls `captureCostHistory` at all and no shard is ever
// written. `captureCostHistory` gates on `isHostSingleton()`, so the flush is
// correct wherever it IS reached — but that only closes this plugin's half. The
// real fix is moving that upstream gate (plus `corpus-index.ts:137`) to
// `isHostSingleton()`, which changes behaviour for every host-scoped warm-up and
// every main-only cron in the repo, and is deliberately out of scope here.
export const costRefreshJob = defineJob({
  name: "stats.cost.refresh",
  description:
    "Updates model prices and saves a snapshot of token usage so cost history outlives deleted transcripts.",
  // seconds: fetches the LiteLLM price table over the network, bounded by
  // safeFetch's own 20s timeout.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: {
    cron: "0 5 * * *", // daily at 05:00 UTC
    // The tick missed while the machine slept or main was down runs at main's
    // next start — the archive's only write point, so it must not skip a day.
    catchUpWithinMs: 7 * 24 * 60 * 60 * 1000,
  },
  async run() {
    // Prices first: the capture that follows reports unpriced models, and doing
    // it in this order means a model LiteLLM has just published is priced on the
    // same tick rather than reported as missing and resolved a day later.
    const { models } = await refreshPriceTable();
    await captureCostHistory();
    log.publish(
      `price table refreshed (${models} models) and cost archive flushed`,
    );
  },
});
