import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { type ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  useLive,
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  createEventSource,
  deleteEventSource,
  eventRunIdKind,
  eventSourceRuns,
  eventSources,
  refreshAllEventSources,
  runEvents,
  refreshEventSourceNow,
  updateEventSource,
  type EventSource,
  type EventSourceRun,
} from "../../core";

/**
 * The configured sources, live: every one, newest first (the collection is
 * declared `all`). Not loaded yet is the loading arm, never an empty list.
 */
export function useEventSources(): ResourceResult<EventSource[]> {
  return useLive(eventSources);
}

/**
 * One source by id, live: pending, then found or determinately absent. Reads the
 * collection's point sibling — one row, not the whole set.
 */
export function useEventSourceRow(
  sourceId: string,
): LiveRowResult<EventSource> {
  return useLiveRow(eventSources, sourceId);
}

/**
 * One run, by its own id, live: pending, then found or determinately absent
 * (swept by retention, or its source deleted). Reads the `events.source-runs`
 * point sibling, so it answers for ANY run — a deep-linked run pane resolves
 * from the URL, never from whatever window the runs list happened to load.
 * The run pane and its sections all read it here; one id is one subscription.
 */
export function useEventSourceRun(
  runId: string,
): LiveRowResult<EventSourceRun> {
  // `key` upgrades a pre-rewrite bare-uuid run id (an old `run/<uuid>` URL).
  return useLiveRow(eventSourceRuns, eventRunIdKind.key(runId));
}

/**
 * The events one run touched, each with what that run did to it — the detail
 * behind the run row's counts (at most `RUN_EVENTS_LIMIT`), live. An unknown
 * run is the error arm, refused `missing` — never an empty list.
 */
export function useRunEvents(runId: string) {
  return useLive(runEvents, { runId });
}

/** Create a source. Failures surface through the global mutation toast. */
export function useCreateEventSource() {
  return useEndpointMutation(createEventSource);
}

/** Autosave PATCH behind every source field edit. */
export function useUpdateEventSource() {
  return useEndpointMutation(updateEventSource);
}

export function useDeleteEventSource() {
  return useEndpointMutation(deleteEventSource);
}

/**
 * "Refresh now". The response is a discriminated `RefreshSourceResult` — callers
 * MUST branch on `status` rather than treating a resolved promise as success:
 * `skipped` is a resolved, legitimate non-run.
 *
 * It invalidates nothing: this resolves at `enqueued`, before the run has even
 * started, so a refetch here could only ever re-read the list unchanged. The run
 * appears when it actually lands: the `events.source-runs` window is live.
 */
export function useRefreshEventSourceNow() {
  return useEndpointMutation(refreshEventSourceNow);
}

/**
 * "Refresh all" — every enabled source in one request. The response is a TALLY
 * the caller must render arm by arm, for the same reason `useRefreshEventSourceNow`
 * returns a discriminated result: a resolved promise is not "all refreshed", and
 * a tally reading `0 enqueued / 4 already-running` is a legitimate, useful answer.
 *
 * It invalidates nothing, for the same reason that one does not: this resolves at
 * enqueue time, before any run has started, so a refetch here could only re-read
 * the list unchanged. The runs appear as they land: the `events.source-runs`
 * window is live.
 */
export function useRefreshAllEventSources() {
  return useEndpointMutation(refreshAllEventSources);
}
