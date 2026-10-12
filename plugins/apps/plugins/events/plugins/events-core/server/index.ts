import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  createEventSource,
  deleteEventSource,
  getEventSource,
  listEventSources,
  refreshAllEventSources,
  refreshEventSourceNow,
  updateEventSource,
} from "../core";
import {
  handleCreateSource,
  handleDeleteSource,
  handleGetSource,
  handleListSources,
  handleRefreshAll,
  handleRefreshSource,
  handleUpdateSource,
} from "./internal/handlers";
import {
  eventSourceRunsServed,
  eventSourcesServed,
  runEventsServed,
} from "./internal/resources";
import { IdKinds } from "@plugins/ids/server";
import { eventSourceIdKind, eventIdKind, eventRunIdKind } from "../core";

// The physical tables, the source-type registry, the repo functions, and the
// refresh seam — everything the `refresh` engine, `event-list`, and `sources`
// build on. Re-exporting this plugin's OWN internal files is allowed; only
// proxying another plugin's symbols would violate the boundary rules.
export {
  _eventSources,
  _eventSourceRuns,
  _eventSourceRunEvents,
} from "./internal/tables";
// `events` is exported as a READ handle only. Every write goes through the repo
// funnel below, which owns the sighting stamps and soft disappearance;
// the `events/no-raw-events-write` lint rule fails any db.insert/update/delete
// on this handle outside `events-repo.ts`.
export { _events as eventsTable } from "./internal/tables";
export {
  upsertEvents,
  markEventsDisappeared,
  reanchorRecurringEvents,
} from "./internal/events-repo";
export type {
  EventWriteInput,
  TouchedEvent,
  UpsertEventsResult,
  ReanchorResult,
} from "./internal/events-repo";
export {
  defineEventSourceType,
  getEventSourceType,
  listEventSourceTypes,
} from "./internal/registry";
export type {
  EventSourceType,
  ProbeContext,
  ProbeResult,
} from "./internal/registry";
export {
  listSources,
  requireSource,
  createSource,
  updateSource,
  deleteSource,
  listRunEvents,
  requireRun,
} from "./internal/sources-repo";
export { registerRefreshRunner } from "./internal/refresh-runner";
export type { RefreshRunner } from "./internal/refresh-runner";
export { eventSourcesServed } from "./internal/resources";

export default {
  description:
    "Contract layer for the Events app: the event_sources / events / event_source_runs entities, the defineEventSourceType two-phase registry, source CRUD endpoints, and the live sources and run-ledger collections.",
  httpRoutes: {
    [listEventSources.route]: handleListSources,
    [createEventSource.route]: handleCreateSource,
    [getEventSource.route]: handleGetSource,
    [updateEventSource.route]: handleUpdateSource,
    [deleteEventSource.route]: handleDeleteSource,
    [refreshEventSourceNow.route]: handleRefreshSource,
    [refreshAllEventSources.route]: handleRefreshAll,
  },
  contributions: [
    IdKinds.Kind({ kind: eventSourceIdKind }),
    IdKinds.Kind({ kind: eventIdKind }),
    IdKinds.Kind({ kind: eventRunIdKind }),
    ...eventSourcesServed.declare,
    ...eventSourceRunsServed.declare,
    ...runEventsServed.declare,
  ],
} satisfies ServerPluginDefinition;
