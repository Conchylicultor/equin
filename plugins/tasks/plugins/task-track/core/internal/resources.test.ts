/**
 * The exposed track keeps the id saved task-list views name (`track`), reads
 * the declared default for a task with no row, and presents each value.
 *
 * Run: `./singularity test plugins/tasks/plugins/task-track`.
 */

import { expect, test } from "bun:test";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { taskTrackShape } from "./resources";

test("the track is exposed on tasks as `track`, main when absent", () => {
  const exposure = taskTrackShape.exposure;
  expect(exposure.parent).toBe(tasksEntityRef);
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["track"]);
  expect(exposure.fields.track).toMatchObject({
    label: "Track",
    absent: "main",
  });
  expect(Object.keys(exposure.fields.track.options ?? {})).toEqual([
    "main",
    "sidequest",
  ]);
});
