import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import {
  clearMandate,
  getTask,
  setMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import { mandateDefinitionEntries } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { deleteTaskMandate, putTaskMandate } from "../../core";

export const handlePutTaskMandate = implement(
  putTaskMandate,
  async ({ params, body }) => {
    const entry = mandateDefinitionEntries().get(body.mandateId);
    if (!entry) {
      throw new HttpError(400, `No mandate "${body.mandateId}" is defined.`);
    }
    await setMandate(params.taskId, entry.mandate);
  },
);

export const handleDeleteTaskMandate = implement(
  deleteTaskMandate,
  async ({ params }) => {
    const task = await getTask(params.taskId);
    if (!task) throw new HttpError(404, `No task "${params.taskId}".`);
    if (task.folderId === null) {
      throw new HttpError(
        400,
        `Task "${params.taskId}" is a root: a root always states its mandate.`,
      );
    }
    await clearMandate(params.taskId);
  },
);
