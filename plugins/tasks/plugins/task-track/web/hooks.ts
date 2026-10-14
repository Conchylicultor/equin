import { useMemo } from "react";
import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { DEFAULT_TASK_TRACK, type TaskTrack } from "../core";
import { taskTracks, type TaskTrackRow } from "../shared/resources";

/** One task's track: a read — loading, failed, or the track. */
export type TaskTrackResult = ResourceResult<TaskTrack>;

/**
 * The task's track: its row of the `taskTracks` point sibling. `found: false`
 * is determinately the default track (main); "not loaded yet" stays the
 * loading arm, so a sidequest can never flash as main.
 */
export function useTaskTrack(taskId: string): TaskTrackResult {
  const result = useLiveRow(taskTracks, taskId);
  return useMemo(
    () => mapRow(result, (row) => (row ? row.track : DEFAULT_TASK_TRACK)),
    [result],
  );
}

/** Every stored (non-main) track: a read of taskId → track. */
export type StoredTracks = ResourceResult<ReadonlyMap<string, TaskTrack>>;

// Stable (module-level), so the `select` re-runs only when the set changes.
function toTrackMap(
  rows: readonly TaskTrackRow[],
): ReadonlyMap<string, TaskTrack> {
  return new Map(rows.map((r) => [r.taskId, r.track]));
}

/**
 * Every stored track, from the whole `taskTracks` set, for a surface that
 * needs a track for EVERY task it shows (the sidequest launch list; a list of
 * tasks reads the exposed `track` field instead). A task missing from a
 * READY map is main; not loaded yet is the loading arm, never an empty map
 * (which would claim every task is main). The set is preloaded, so a
 * boot-hydrated read renders ready on its first render.
 */
export function useStoredTracks(): StoredTracks {
  return useLive(taskTracks, { select: toTrackMap });
}
