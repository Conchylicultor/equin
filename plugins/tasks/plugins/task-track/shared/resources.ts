import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { STORED_TASK_TRACKS } from "../core";

// One row per NON-default-track task, stored in the `tasks_ext_track`
// entity-extension table (1:1 per task), which `server/internal/tables.ts`
// builds from this shape. The column only takes the stored tracks (today
// `sidequest`): absence of a row IS the main track, so `main` has no spelling
// here. `createdAt` (when the task left main) rides on the wire as a plain
// field of the shape.
export const taskTrackShape = defineExtensionShape({
  key: "taskId",
  fields: { track: enumTextField(STORED_TASK_TRACKS) },
  wireTimestamps: ["createdAt"],
});
export const TaskTrackRowSchema = taskTrackShape.schema;
export type TaskTrackRow = z.infer<typeof TaskTrackRowSchema>;

// The stored tracks, read two ways from one declaration:
//
// - `useLiveRow(taskTracks, taskId)` — the exact answer for ONE task (the task
//   detail's Track row, the conversation header chip). `found: false` is main.
// - `useLive(taskTracks)` — the WHOLE ordered set (`all`), for the task list's
//   `track` field, which must project a track for EVERY row the tasks DataView
//   groups and filters over, so its reader holds the set entire. A row a task
//   has (or not) is its track: one row per sidequest at most, never a stand-in
//   for one past a window's edge.
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
// Preloaded (`boot-and-keep`) so the tasks list never paints every row as main
// and then flips: the boot snapshot hydrates the `{}` tuple before first
// paint, and the cache stays resident for surfaces that mount late.
export const taskTracks = liveCollection("task-tracks.all", {
  row: TaskTrackRowSchema,
  id: "taskId",
  all: {
    orderBy: [["taskId", "asc"]],
    unbounded: {
      reason:
        "at most one row per task, and the task list projects a track for every task",
    },
  },
  preload: "boot-and-keep",
});
