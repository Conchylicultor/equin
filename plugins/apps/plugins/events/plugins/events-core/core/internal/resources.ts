import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { compositeKey } from "@plugins/infra/plugins/query-resource/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import {
  eventSourceRunEventsEntityRef,
  eventSourceRunsEntityRef,
  eventSourcesEntityRef,
  eventsEntityRef,
} from "./entity-refs";
import { RunEventSchema } from "./schema";

/**
 * The configured sources, as the WHOLE ordered set (`all`, newest first) plus
 * its `:rows` point sibling for by-id reads. Every reader needs every source:
 * the Sources list filters, sorts and groups them client-side (its state and
 * extraction have no column), and the events list's Source field offers each as
 * an option — so a window would silently drop the oldest past its edge. The
 * set is user-curated (a person adds each source by hand).
 *
 * Read whole with `useLive(eventSources)`; one row by id is `useLive(c, { id })`.
 *
 * Declared by FIELDS: the rows ARE `event_sources` rows (`from`), the fields
 * the Sources list shows `pick`ed in list order — their labels, options and
 * filter domains the entity's. The list adds the two it derives from the run
 * bookkeeping (its state and extraction verdicts); the rest of the row is
 * carried.
 *
 * The key is `events.sources.all`, not the old window's `events.sources`: no
 * bundle ever declared this key with another contract, so a tab on an older
 * one gets `unknown-key` (a `skew` verdict) and never parses these rows.
 */
export const eventSources = liveCollection("events.sources.all", {
  from: eventSourcesEntityRef,
  pick: ["name", "type", "refresh", "status", "enabled", "lastRunAt"],
  carry: {
    pick: [
      "id",
      "config",
      "lastFingerprint",
      "nextRunAt",
      "lastError",
      "lastErrorCode",
      "lastFlags",
      "lastOutcome",
      "lastEventCount",
      "createdAt",
      "updatedAt",
    ],
  },
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
 * Read as key-range pages: retention keeps 30 days, and a source on a short
 * cadence writes more than one window of that. `flags` (the caveats list) is on the
 * wire but display-only — no saved view sorts or filters by it.
 *
 * Declared by FIELDS: the rows ARE `event_source_runs` rows (`from`), the
 * fields a list shows `pick`ed in list order — their labels, options and
 * filter domains the entity's. `sourceId` is listed because the source pane
 * SCOPES the window by it (a scope column must filter); the rest of the row is
 * carried.
 */
export const eventSourceRuns = liveCollection("events.source-runs", {
  from: eventSourceRunsEntityRef,
  pick: [
    "startedAt",
    "outcome",
    "eventsFound",
    "eventsCreated",
    "eventsUpdated",
    "eventsDisappeared",
    "durationMs",
    "error",
    "sourceId",
  ],
  carry: { pick: ["id", "finishedAt", "fingerprint", "flags"] },
  id: "id",
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
  scopedColumns: true,
});

/** A run as the ledger's window delivers it: the run row plus every exposed field under `$columns`. */
export type EventSourceRunRow =
  typeof eventSourceRuns extends LiveRowsCollection<infer R> ? R : never;

/**
 * The most events one run's set (`runEventLinks`) is read with: past it the
 * read fails loudly rather than drop rows. A run is one extraction — tens of
 * events (89 at most on main, 2026-11-03); `runEvents` shows the first
 * `RUN_EVENTS_LIMIT` of them by start.
 */
export const RUN_EVENT_LINKS_MAX = 500;

/**
 * The events one run touched and what it did to each — a follow target of
 * `runEvents`, a scoped set by `{ where: { runId } }` over the table's
 * composite key. A run writes its set once, at its end; another run's set
 * reaches no reader of this one.
 */
export const runEventLinks = liveCollection("events.run-event-links", {
  from: eventSourceRunEventsEntityRef,
  carry: { pick: ["runId", "eventId", "action"] },
  baseExposures: false,
  id: compositeKey(["runId", "eventId"]),
  all: {
    by: ["runId"],
    orderBy: [["eventId", "asc"]],
    max: RUN_EVENT_LINKS_MAX,
  },
});

/**
 * Events by id, as a run's detail lists them — a follow target of
 * `runEvents` (lookup-only: `:rows` alone). `firstSeenAt` / `lastSeenAt` are
 * left out: every run re-stamps `lastSeenAt` on every event it sees, and a
 * run's detail shows neither, so those writes reach no reader.
 */
export const runEventRows = liveCollection("events.run-event-rows", {
  from: eventsEntityRef,
  carry: {
    pick: [
      "id",
      "sourceId",
      "externalId",
      "title",
      "description",
      "date",
      "startsAt",
      "endsAt",
      "allDay",
      "venue",
      "city",
      "url",
      "imageUrl",
      "price",
      "category",
      "tags",
      "recurring",
      "recurrenceLabel",
      "disappearedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  baseExposures: false,
  id: "id",
  maxIds: RUN_EVENT_LINKS_MAX,
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
  schema: cappedList(RunEventSchema, { max: RUN_EVENTS_LIMIT }),
  params: ["runId"],
  refusals: ["missing"],
});
