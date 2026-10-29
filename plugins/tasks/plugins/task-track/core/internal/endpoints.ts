import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  choose,
  removeRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import { taskTracks } from "./resources";
import { DEFAULT_TASK_TRACK, TaskTrackSchema } from "./track";

/**
 * Switch a task's track (the human override from the task detail). Only a
 * sidequest has a row (`setTaskTrack` deletes it on main), so main removes the
 * task's row and a sidequest upserts it.
 */
export const putTaskTrack = defineEndpoint({
  route: "PUT /api/tasks/:taskId/track",
  body: z.object({ track: TaskTrackSchema }),
  effect: (on) =>
    choose(
      on,
      ({ body }) => (body.track === DEFAULT_TASK_TRACK ? "main" : "stored"),
      {
        main: removeRow(on, taskTracks, ({ params }) => params.taskId),
        stored: upsertRow(
          on,
          taskTracks,
          ({ params }) => params.taskId,
          (row, { params, body }) => ({
            taskId: params.taskId,
            createdAt: new Date(),
            ...row,
            track: body.track,
          }),
          { set: ({ body }) => ({ track: body.track }) },
        ),
      },
    ),
});
