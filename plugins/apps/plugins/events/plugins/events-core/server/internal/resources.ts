import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  eventRunIdKind,
  eventSourceRuns,
  eventSources,
  RUN_EVENTS_LIMIT,
  runEventLinks,
  runEventRows,
  runEvents,
} from "../../core";
import {
  _events,
  _eventSources,
  _eventSourceRuns,
  _eventSourceRunEvents,
} from "./tables";
import { runEventsOf } from "./run-events";

// The sources collection over `event_sources`: the whole ordered set and its
// `:rows` point sibling. Every column is on the wire — a source row is small
// and the whole thing is what the sources pane renders. A new source is an
// entrant (one refill + one `orderOf`), a delete an exit; `createdAt` (the
// order) never changes, so a rename or a status / fingerprint / watermark write
// is a one-row refill.
export const eventSourcesServed = serveCollection(eventSources, {
  from: _eventSources,
});

// The run ledger over `event_source_runs`: every `EventSourceRun` field is a
// column of the table by name, so the projection is exactly the row schema.
// No base `where`: the source pane scopes a window to its source (`sourceId`, a
// filterable column), and the run pane reads one run through `:rows`. A run
// row is written once, at the END of its run, in the same transaction as the
// source row's status (`run-ledger.ts`); the change feed routes that insert —
// and the 30-day retention sweep's and a source delete's cascaded deletes — to
// the tuples holding the run.
export const eventSourceRunsServed = serveCollection(eventSourceRuns, {
  from: _eventSourceRuns,
});

// The rows `events.run-events` follows: one run's set (the run-events
// table, over its composite key) and the events it names.
export const runEventLinksServed = serveCollection(runEventLinks, {
  from: _eventSourceRunEvents,
});
export const runEventRowsServed = serveCollection(runEventRows, {
  from: _events,
});

// One run's events (`events.run-events`): the run (its existence), its set,
// then the events the set names and their sources (`follow.from`). The run's
// set lands once, in one transaction at the end of the run; a listed event's
// edit or its source's rename reaches it; retention or a source delete
// removing the run answers `missing`, never `[]`. A write about any other
// run, event or source reaches none.
export const runEventsServed = serveValue(runEvents, {
  source: "db",
  follows: (follow) => {
    const links = follow(runEventLinksServed, ({ runId }) => ({
      where: { runId: eventRunIdKind.key(runId) },
    }));
    const events = follow.from({ links }, runEventRowsServed, (_p, r) => ({
      ids: r.links.map((l) => l.eventId),
    }));
    return {
      run: follow(eventSourceRunsServed, ({ runId }) => ({
        ids: [eventRunIdKind.key(runId)],
      })),
      links,
      events,
      sources: follow.from({ events }, eventSourcesServed, (_p, r) => ({
        ids: [...new Set(r.events.map((e) => e.sourceId))],
      })),
    };
  },
  loader: ({ runId }, { followed }) => {
    if (followed.run.length === 0) {
      throw runEvents.refuse("missing", `Unknown event source run: ${runId}`);
    }
    return runEventsOf(followed, RUN_EVENTS_LIMIT);
  },
});
