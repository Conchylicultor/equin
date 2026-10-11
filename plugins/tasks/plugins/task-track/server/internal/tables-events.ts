import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import type { TaskTrack } from "../../core";

export interface TaskTrackChangedPayload {
  taskId: string;
  track: TaskTrack;
  [key: string]: unknown;
}

// Emitted by `setTaskTrack` on every write, committed with it (a task created
// in a transaction emits on that transaction). Filterable by the new track, so
// a subscriber can say "when a task becomes a sidequest". A write that leaves
// the track as it was still emits: subscribers re-read before acting.
export const { event: taskTrackChanged, table: _taskTrackChangedTriggers } =
  defineTriggerEvent<TaskTrackChangedPayload>({
    name: "tasks.trackChanged",
    filters: {
      track: text("track"),
    },
  });
