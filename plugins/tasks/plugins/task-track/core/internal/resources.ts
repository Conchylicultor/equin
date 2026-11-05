import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { DEFAULT_TASK_TRACK, TASK_TRACKS, TRACK_META } from "./track";

// A task's track, stored in the `tasks_ext_track` entity-extension table (1:1
// per task), which `server/internal/tables.ts` builds from this shape. The
// field declares its default, `main` (the column's DB default agrees): a task
// with no row is main, so only a sidequest needs a row (`setTaskTrack` deletes
// it on main) and no existing task needs a backfill. `createdAt` (when the task
// left main) rides on the wire as a plain field of the shape.
//
// It EXPOSES the track to every list whose rows reach a task (`exposes` —
// the conversation lists today): a task with no row reads the field's default,
// each value presents as its `TRACK_META` chip. No list is named here.
export const taskTrackShape = defineExtensionShape({
  key: "taskId",
  fields: {
    track: enumTextField(TASK_TRACKS, {
      label: "Track",
      default: DEFAULT_TASK_TRACK,
      options: TRACK_META,
    }),
  },
  wireTimestamps: ["createdAt"],
  exposes: { parent: tasksEntityRef, name: "track", fields: { track: {} } },
});
export const TaskTrackRowSchema = taskTrackShape.schema;
export type TaskTrackRow = z.infer<typeof TaskTrackRowSchema>;

// The stored tracks, read by task: `useLive(taskTracks, { id: taskId })` —
// the exact answer for ONE task (the task detail's Track control, the
// conversation header chip); `found: false` is main. Lookup-only (`:rows`
// alone, never preloaded): no surface needs every task's track — a LIST of
// tasks reads the track exposed into its rows (`exposes` above), and the
// sidequest launch list filters `tasks.tree` by it on the server — so the
// set is bounded by construction, its cost one row per mounted reader.
//
// The key is `task-tracks.by-id`, not the old whole set's `task-tracks.all`: a
// tab on an older bundle subscribing `{}` gets `unknown-key` (a `skew`
// verdict), never this collection's rows — no C39 old-bundle proof to keep.
export const taskTracks = liveCollection("task-tracks.by-id", {
  from: taskTrackShape,
  id: "taskId",
});
