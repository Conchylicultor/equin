import { z } from "zod";
import { and, eq, isNull, lte, ne, or } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _eventSources } from "@plugins/apps/plugins/events/plugins/events-core/server";
import { runSource } from "./run-source";
import { refreshLog } from "./sink";

// The two jobs that drive the engine: a cadence tick that decides WHICH sources
// are due, and a per-source job that runs one.
//
// Splitting them is what keeps a slow or failing source contained: it owns its
// own retry budget and dead-letter, and cannot stall or dead-letter the tick
// that every other source depends on.

/**
 * Refresh exactly one source.
 *
 * `dedup` by `sourceId`, so the cadence tick, a "Refresh now" click, and a
 * retry all coalesce onto one run per source instead of racing two extractions
 * (two model calls) over the same page.
 *
 * `maxAttempts: 3` bounds the transient case. The terminal case never gets
 * there: `runSource` rethrows a classified terminal failure as
 * `NonRetryableError`, which dead-letters after the current attempt.
 */
export const refreshSourceJob = defineJob({
  name: "events.refresh-source",
  description: "Re-reads one event source and extracts its current events.",
  // minutes: a URL source may read the page through a real headless browser
  // (`browserFetch`) before the model call. A browser launch is bounded by
  // nothing shorter than the work — and `slowThresholdMs` below is 180s,
  // above the `seconds` ceiling.
  hold: "minutes",
  inProcess:
    "A run re-marks its source row as running when it starts and only writes " +
    "events after a full extraction, so a refresh killed mid-run is simply " +
    "re-fetched from scratch by the retry or the next cadence tick.",
  input: z.object({ sourceId: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.sourceId },
  maxAttempts: 3,
  // A URL source pays for a page fetch plus a one-shot model call; seconds is
  // normal and must not file slow-op noise.
  slowThresholdMs: 180_000,
  run: async ({ input, ctx }) => {
    await runSource(input.sourceId, ctx);
  },
});

/**
 * Which sources the tick owes a run: enabled, on a cadence, and due.
 *
 * A non-manual source with NO watermark is treated as due. `next_run_at <= now`
 * alone would silently strand such a row forever (SQL comparisons against NULL
 * are never true) — the failure mode being a source that simply never refreshes
 * and gives no reason why.
 */
async function selectDueSources(now: Date): Promise<{ id: string }[]> {
  return db
    .select({ id: _eventSources.id })
    .from(_eventSources)
    .where(
      and(
        eq(_eventSources.enabled, true),
        ne(_eventSources.refresh, "manual"),
        or(isNull(_eventSources.nextRunAt), lte(_eventSources.nextRunAt, now)),
      ),
    );
}

/**
 * The cadence driver — the documented exception to the no-polling rule. A
 * scraped venue page publishes no change signal to subscribe to, so the only
 * way to notice a new party is to look; a scheduled `defineJob` (mail's
 * `sync-tick` sets the precedent) is the sanctioned mechanism, never an
 * in-process `setInterval`.
 *
 * **Main-only** (`perWorktree` left unset), deliberately. Worktrees inherit
 * events through the DB fork, so a per-worktree schedule would have every live
 * agent worktree independently hammering the same third-party sites. Manual
 * "Refresh now" is a normal endpoint and still works in any worktree.
 *
 * Every 15 minutes rather than every minute: the finest cadence a source can
 * choose is hourly, so the tick only needs to be fine enough that "hourly" is
 * not visibly late.
 */
export const refreshTickJob = defineJob({
  name: "events.refresh-tick",
  description:
    "Finds event sources due for a refresh and queues a refresh for each.",
  // instant: the body only selects due sources and enqueues one
  // `refreshSourceJob` each. The fetching and extracting happen there.
  hold: "instant",
  // Cron payloads are built from `input.parse({})`, so this must parse `{}`.
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },
  maxAttempts: 3,
  run: async () => {
    const due = await selectDueSources(new Date());
    if (due.length === 0) return;

    // A failure here is a DB/queue failure, not a per-source one: let it throw
    // so the tick retries and the failure is visible, rather than half-enqueuing
    // in silence. Per-source failures cannot reach this loop at all — they
    // happen inside `refreshSourceJob`, which owns them.
    for (const source of due) {
      await refreshSourceJob.enqueue({ sourceId: source.id });
    }
    refreshLog.publish(`cadence tick enqueued ${due.length} due source(s)`);
  },
});
