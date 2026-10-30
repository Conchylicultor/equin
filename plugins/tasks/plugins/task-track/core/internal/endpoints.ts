import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TaskTrackSchema } from "./track";

/**
 * Switch a task's track (the human override from the task detail). Only a
 * sidequest has a row (`setTaskTrack` deletes it on main), so main removes the
 * task's row and a sidequest upserts it.
 */
export const putTaskTrack = defineEndpoint({
  route: "PUT /api/tasks/:taskId/track",
  body: z.object({ track: TaskTrackSchema }),
});
