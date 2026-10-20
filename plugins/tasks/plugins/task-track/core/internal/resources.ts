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

// The stored tracks, read two ways from one declaration:
//
// - `useLiveRow(taskTracks, taskId)` — the exact answer for ONE task (the task
//   detail's Track row, the conversation header chip). `found: false` is main.
// - `useLive(taskTracks)` — the WHOLE ordered set (`all`), for a surface that
//   needs a track for EVERY task it shows (the sidequest autopilot's launch
//   list), so its reader holds the set entire. A row a task has (or not) is
//   its track: one row per sidequest at most, never a stand-in for one past a
//   window's edge. (A LIST of tasks reads neither: the track is exposed into
//   its rows — `exposes` above.)
//
// Served from the extension table (`server/internal/resource.ts`): marking a
// task a sidequest is one entrant, moving it back to main (or the task's
// delete, by FK cascade) an exit — never a whole-set reload.
//
// The key is `task-tracks.all`, not the old window's `task-tracks`: no bundle
// ever declared this key with another contract, so a tab on an older one gets
// `unknown-key` (a `skew` verdict) and never parses these rows — no C39
// old-bundle proof to keep.
//
// Preloaded (`boot-and-keep`) so a surface reading every track never paints
// every task as main and then flips: the boot snapshot hydrates the `{}` tuple
// before first paint, and the cache stays resident for surfaces that mount
// late.
export const taskTracks = liveCollection("task-tracks.all", {
  from: taskTrackShape,
  id: "taskId",
  all: {
    orderBy: [["taskId", "asc"]],
    unbounded: {
      reason:
        "at most one row per task, and the sidequest launch list projects a track for every task it shows",
    },
  },
  preload: "boot-and-keep",
});
