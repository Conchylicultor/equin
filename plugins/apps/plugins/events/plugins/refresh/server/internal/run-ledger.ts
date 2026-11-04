import { eq } from "drizzle-orm";
import { db, writeAtomically } from "@plugins/database/server";
import type {
  EventSource,
  RunOutcome,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import {
  _eventSources,
  _eventSourceRuns,
  _eventSourceRunEvents,
  type TouchedEvent,
} from "@plugins/apps/plugins/events/plugins/events-core/server";
import type { RefreshErrorClassification } from "./classify-error";
import { computeNextRunAt } from "./schedule";
import {
  eventSourceIdKind,
  type EventRunId,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

// The ONLY writer of `event_source_runs` and of a source row's runtime state.
//
// Every run ends here, and every ending writes BOTH tables in one statement:
// the ledger row (what happened) and the source row (status, fingerprint,
// watermarks, classified error). Keeping the pair atomic is what makes the two
// answerable together — a source that says `error` always has the failed run row
// that explains it, and a source that says `idle` never has a half-written run.
//
// The row is written at the END of the run, not the start: an in-flight run is
// already visible as `status: "running"` on the live-pushed source row, so a
// second "started" write would only buy the ability to leave a half-row behind
// on a crash. Every ledger row is therefore complete by construction.
//
// The run's *id* is nevertheless minted by `runSource` before the first phase
// and passed in here. That is a nuance of the above, not a reversal of it — do
// not "fix" it back to a `randomUUID()` at insert time. Nothing is written
// earlier; only the identity exists earlier, which is what lets work in flight
// (a model call, a fetched artifact) stamp itself with the run it belongs to and
// be reachable afterwards from the row that explains the outcome. A run that
// dies before finishing still writes no row — its id simply names nothing, which
// is exactly what "the run never completed" should look like.

type SourceStatePatch = Partial<typeof _eventSources.$inferInsert>;

interface RunCounts {
  found: number;
  created: number;
  updated: number;
  disappeared: number;
}

const NO_COUNTS: RunCounts = {
  found: 0,
  created: 0,
  updated: 0,
  disappeared: 0,
};

/**
 * Flip a source to `running` before the first phase. Also the wedge cure: a
 * backend killed mid-run leaves the row stuck at `running`, and the next run
 * (cadence tick or "Refresh now") reclaims it here rather than needing a sweep.
 */
export async function markSourceRunning(sourceId: string): Promise<void> {
  await db
    .update(_eventSources)
    .set({ status: "running" })
    .where(eq(_eventSources.id, eventSourceIdKind.key(sourceId)));
}

/**
 * Write the ledger row and the source row together. `finishedAt` is the single
 * clock read both derive from, so `durationMs` and `lastRunAt` can never
 * disagree.
 */
async function completeRun(
  source: EventSource,
  run: {
    /** Minted by `runSource` at the start; see the header note. */
    runId: EventRunId;
    finishedAt: Date;
    startedAt: Date;
    outcome: RunOutcome;
    fingerprint: string | null;
    counts: RunCounts;
    /** What the extractor could not express. `[]` for a run that never read. */
    flags: string[];
    /**
     * Which events this run touched, and how — the detail behind `counts`.
     * Empty for a run that touched none (`unchanged`, `failed`).
     */
    touched: readonly TouchedEvent[];
    error: string | null;
  },
  sourceState: SourceStatePatch,
): Promise<void> {
  // ONE statement (`writeAtomically`), not a transaction of three round trips:
  // nothing here reads, so there is nothing to wait on between the writes, and
  // a transaction would only hold the source row locked across the app's next
  // round trip. The run-events' FK to the run row is checked at the end of the
  // statement, so the arms may land in any order.
  await writeAtomically(db, [
    db.insert(_eventSourceRuns).values({
      id: run.runId,
      sourceId: source.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      outcome: run.outcome,
      eventsFound: run.counts.found,
      eventsCreated: run.counts.created,
      eventsUpdated: run.counts.updated,
      eventsDisappeared: run.counts.disappeared,
      fingerprint: run.fingerprint,
      durationMs: run.finishedAt.getTime() - run.startedAt.getTime(),
      flags: run.flags,
      error: run.error,
    }),
    // In the SAME statement as the row above, which is what makes the counts
    // and the list they summarize one fact rather than two that can disagree.
    run.touched.length > 0
      ? db.insert(_eventSourceRunEvents).values(
          run.touched.map((t) => ({
            runId: run.runId,
            eventId: t.eventId,
            action: t.action,
          })),
        )
      : null,
    db
      .update(_eventSources)
      .set({
        lastRunAt: run.finishedAt,
        // Measured from the END of the run, so a slow source cannot accumulate
        // a backlog of overdue ticks.
        nextRunAt: computeNextRunAt(source.refresh, run.finishedAt),
        // In the BASE patch, not per-arm: `outcome` is already on the run row
        // being inserted in the first arm, so every ending writes it here by
        // construction and no arm can forget to. It is the newest thing the
        // engine knows — including the cheap `unchanged` runs — which is what
        // makes the sources list's derived status answer "how is it NOW"
        // rather than "how did it last go well".
        lastOutcome: run.outcome,
        ...sourceState,
      })
      .where(eq(_eventSources.id, source.id)),
  ]);
}

/**
 * The cache hit: the probe fingerprint matched, so `extract` was never called
 * and no model call was paid for. Recorded anyway — a run that deliberately did
 * nothing is precisely what "why did nothing happen" needs to see.
 */
export async function finishUnchanged(
  source: EventSource,
  args: { runId: EventRunId; startedAt: Date; fingerprint: string },
): Promise<void> {
  await completeRun(
    source,
    {
      runId: args.runId,
      finishedAt: new Date(),
      startedAt: args.startedAt,
      outcome: "unchanged",
      fingerprint: args.fingerprint,
      counts: NO_COUNTS,
      // This run read nothing, so it has nothing to report — and `lastFlags` is
      // deliberately NOT cleared below: the last extraction's caveats still
      // stand about a page nobody re-read.
      flags: [],
      // Extraction never ran, so no event was touched. An empty list here is the
      // true answer, not a missing one.
      touched: [],
      error: null,
    },
    // The fingerprint is unchanged by definition; a successful run clears any
    // error the previous one left behind.
    { status: "idle", lastError: null, lastErrorCode: null },
  );
}

/**
 * The full path: extraction ran, the diff landed, the fingerprint advances.
 *
 * The ONLY writer of `lastFlags`, and it writes it in the same statement as
 * the run row that produced it — so the Status card's caveats and the run they
 * came from can never disagree, and the card needs no second query to find them.
 */
export async function finishExtracted(
  source: EventSource,
  args: {
    runId: EventRunId;
    startedAt: Date;
    fingerprint: string | null;
    counts: RunCounts;
    flags: string[];
    touched: readonly TouchedEvent[];
  },
): Promise<void> {
  await completeRun(
    source,
    {
      runId: args.runId,
      finishedAt: new Date(),
      startedAt: args.startedAt,
      outcome: "extracted",
      fingerprint: args.fingerprint,
      counts: args.counts,
      flags: args.flags,
      touched: args.touched,
      error: null,
    },
    {
      // Written even when empty: this run DID read the page, so an extraction
      // that reported nothing is the positive statement "the caveats are gone",
      // not an absence of news.
      lastFlags: args.flags,
      // Written even when 0, for exactly the reason above: this run read the
      // page, so "it really does list nothing" is a positive statement — and
      // the one the sources list must surface, since a scrape that keeps
      // succeeding at zero events is what a site changing its markup looks
      // like. `finishUnchanged` and `finishFailed` leave this column alone for
      // the same reason they leave `lastFlags` alone: neither of them read the
      // page, so neither has a count to state, and writing 0 there would
      // replace a true count with a lie.
      lastEventCount: args.counts.found,
      // A `null` fingerprint is stored verbatim: the source declared it cannot
      // be fingerprinted cheaply, so the next run must extract again. Writing a
      // placeholder here would silently turn that into a permanent cache hit.
      lastFingerprint: args.fingerprint,
      status: "idle",
      lastError: null,
      lastErrorCode: null,
    },
  );
}

/**
 * A failed run. `lastFingerprint` is deliberately untouched — a failure taught
 * us nothing about the source's content, and advancing the cache key would make
 * the NEXT run skip extraction for material we never actually read.
 *
 * A TERMINAL failure parks the source in `status: "error"` with the classified
 * message; a TRANSIENT one drops back to `idle` and leaves the source row's
 * error columns alone, because graphile is still retrying and the detail already
 * lives on this run row (`lastError` is documented as terminal-only).
 *
 * `lastFlags` is untouched for the same reason as `lastFingerprint`: a failed run
 * produced no extraction, so it has nothing to say about what the format could or
 * could not express, and clearing the caveats would erase a true report.
 */
export async function finishFailed(
  source: EventSource,
  args: {
    runId: EventRunId;
    startedAt: Date;
    failure: RefreshErrorClassification;
  },
): Promise<void> {
  const { failure } = args;
  await completeRun(
    source,
    {
      runId: args.runId,
      finishedAt: new Date(),
      startedAt: args.startedAt,
      outcome: "failed",
      fingerprint: null,
      counts: NO_COUNTS,
      flags: [],
      // A failed run exits before the write phase — by construction it touched
      // nothing, even when it failed halfway through extraction.
      touched: [],
      error: `${failure.code}: ${failure.message}`,
    },
    failure.terminal
      ? {
          status: "error",
          lastError: failure.message,
          lastErrorCode: failure.code,
        }
      : { status: "idle" },
  );
}
