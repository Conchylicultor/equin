import { useMemo } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { DEFAULT_TASK_TRACK, type TaskTrack } from "../core";
import { taskTracks } from "../core";

/** One task's track: a read — loading, failed, or the track. */
export type TaskTrackResult = ResourceResult<TaskTrack>;

/**
 * The task's track: its row of the `taskTracks` point sibling. `found: false`
 * is determinately the default track (main); "not loaded yet" stays the
 * loading arm, so a sidequest can never flash as main.
 */
export function useTaskTrack(taskId: string): TaskTrackResult {
  const result = useLive(taskTracks, { id: taskId });
  return useMemo(
    () => mapRow(result, (row) => (row ? row.track : DEFAULT_TASK_TRACK)),
    [result],
  );
}
