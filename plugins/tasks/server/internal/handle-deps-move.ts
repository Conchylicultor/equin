import {
  getTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { moveTaskInDepsTree } from "../../core";
import { applyDepsTreeMove } from "./deps-tree-move";

export const handleDepsMove = implement(
  moveTaskInDepsTree,
  async ({ params, body }) => {
    if (!(await getTask(params.id))) throw new HttpError(404, "Task not found");
    try {
      // One transaction: heal + attach commit atomically and the status-change
      // triggers are coalesced to the net before→after, so no transient
      // zero-blocker state can fire auto-start mid-move.
      await withTaskStatusBatch((tx) =>
        applyDepsTreeMove(
          { taskId: params.id, newParentId: body.newParentId, mode: body.mode },
          tx,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bad request";
      const status = msg.includes("not found") ? 404 : 400;
      throw new HttpError(status, msg);
    }
    // return undefined → implement() sends 204
  },
);
