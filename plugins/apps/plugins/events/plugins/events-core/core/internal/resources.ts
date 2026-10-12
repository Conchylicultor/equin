import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  EventSourceRunSchema,
  EventSourceSchema,
  RunEventSchema,
} from "./schema";
import { RUN_OUTCOMES } from "./vocab";

/**
 * The configured sources, as the WHOLE ordered set (`all`, newest first) plus
 * its `:rows` point sibling for by-id reads. Every reader needs every source:
 * the Sources list filters, sorts and groups them client-side (its derived
 * fields have no column), and the events list's Source field offers each as
 * an option — so a window would silently drop the oldest past its edge. The
 * set is user-curated (a person adds each source by hand).
 *
 * Read whole with `useLive(eventSources)`; one row by id is `useLiveRow`.
 *
 * The key is `events.sources.all`, not the old window's `events.sources`: no
 * bundle ever declared this key with another contract, so a tab on an older
 * one gets `unknown-key` (a `skew` verdict) and never parses these rows.
 */
export const eventSources = liveCollection("events.sources.all", {
  row: EventSourceSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "desc"]],
    unbounded: {
      reason:
        "a person adds every source by hand, and the Sources list and the events list's Source field each need every source",
    },
  },
});

/**
 * The DataView surface the run ledger is listed on (the source pane's Runs
 * section, `defineDataView("events.source-runs")`): the scope whose custom
 * columns sort and filter the window. The DataView declares the same literal
 * and asserts at mount that the two agree.
 */
const SOURCE_RUNS_VIEW_ID = "events.source-runs";

/**
 * The run ledger (`event_source_runs`) as a live collection: a bounded,
 * scrollable window — the source pane scopes it to one source with
 * `.scoped({ where: { sourceId } })` — plus its `:rows` point sibling, which is
 * how the run pane and its sections read one run by its OWN id (a deep link
 * resolves from the URL, never from whatever window the list has loaded).
 *
 * The ledger row and the source row's status are written in ONE transaction
 * (`run-ledger.ts`), and the source window is live — so the ledger must be too,
 * or the card beside it contradicts it. The change feed routes each run row's
 * write to the tuples holding it: no revision tick, no refetch.
 *
 * A scroll collection: retention keeps 30 days, and a source on a short cadence
 * writes more than one window of that. `flags` (the caveats list) is on the
 * wire but display-only — no saved view sorts or filters by it.
 */
export const eventSourceRuns = liveCollection("events.source-runs", {
  row: EventSourceRunSchema,
  id: "id",
  filterable: {
    sourceId: liveText(),
    outcome: liveText(z.enum(RUN_OUTCOMES)),
    error: liveText(),
    startedAt: liveInstant(),
    finishedAt: liveInstant(),
    eventsFound: liveNumber(),
    eventsCreated: liveNumber(),
    eventsUpdated: liveNumber(),
    eventsDisappeared: liveNumber(),
    durationMs: liveNumber(),
  },
  sortable: [
    "startedAt",
    "finishedAt",
    "outcome",
    "eventsFound",
    "eventsCreated",
    "eventsUpdated",
    "eventsDisappeared",
    "durationMs",
  ],
  default: { orderBy: [["startedAt", "desc"]], limit: 100 },
  maxLimit: 500,
  scroll: true,
  columnScope: SOURCE_RUNS_VIEW_ID,
});

/**
 * How many of a run's events `runEvents` holds. One run is one extraction —
 * tens of events — so this is a guard against a pathological page, not a page
 * size: there is deliberately no "load more", because a run's set is closed.
 */
export const RUN_EVENTS_LIMIT = 200;

/**
 * The events one run touched, each with what the run did to it — the detail
 * behind that run's counts — ordered by when the event happens, at most
 * `RUN_EVENTS_LIMIT`.
 *
 * Keyed by the run id alone: the run pane's params are own-only, so a
 * deep-linked run resolves its whole content from the URL without first
 * learning which source it belongs to (the run row itself is read the same
 * way, through the `events.source-runs` point sibling).
 *
 * Live (served `db`): the set is written once, in the transaction that closes
 * the run, but the events it lists keep moving (a later run updates one, a
 * source rename re-labels it), and retention or a source delete removes the
 * run — the read follows each. An unknown run is refused `missing`, never an
 * empty list: "this run is gone" and "this run touched nothing" (what every
 * `unchanged` run legitimately looks like) are different answers.
 */
export const runEvents = liveValue("events.run-events", {
  schema: z.array(RunEventSchema),
  params: ["runId"],
  refusals: ["missing"],
});
