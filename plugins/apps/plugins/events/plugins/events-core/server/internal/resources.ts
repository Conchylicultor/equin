import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  eventSourceRuns,
  eventSources,
  RUN_EVENTS_LIMIT,
  runEvents,
} from "../../core";
import { _eventSources, _eventSourceRuns } from "./tables";
import { listRunEvents, runExists } from "./sources-repo";

// The sources collection over `event_sources`: its window (filterable on
// status / enabled, sortable by createdAt / name) and its `:rows` point sibling.
// Every column is on the wire — a source row is small and the whole thing is
// what the sources pane renders. `createdAt` never changes; `name` does, so a
// rename costs one bounded ids query per subscribed window (the order signature
// covers every sortable column), while a status / fingerprint / watermark write
// stays an in-place upsert.
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

// One run's events (`events.run-events`). The loader reads the run, its
// run-events rows, the events and their sources, so the change feed recomputes
// an open tuple when the run's set lands (one transaction at the end of the
// run), when a listed event or its source changes, and when retention or a
// source delete removes the run — which then answers `missing`, never `[]`.
export const runEventsServed = serveValue(runEvents, {
  source: "db",
  unbounded: {
    reason:
      "one run's closed event set — a single extraction, tens of events — and the loader caps it at RUN_EVENTS_LIMIT rows",
  },
  loader: async ({ runId }) => {
    if (!(await runExists(runId))) {
      throw runEvents.refuse("missing", `Unknown event source run: ${runId}`);
    }
    return listRunEvents(runId, RUN_EVENTS_LIMIT);
  },
});
