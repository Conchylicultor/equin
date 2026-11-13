import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { db } from "@plugins/database/server";
import {
  clearMandate,
  getTask,
  nearestMandate,
  setMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import { mandateDefinitionEntries } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { deleteTaskMandate, putTaskMandate } from "../../core";

/**
 * Refuses a change to a task that itself states an OWNED mandate: its owner
 * stated it with state of its own beside it (a role session's root and its
 * role), so only the owner unstates it.
 */
async function assertOwnMandateNotOwned(taskId: string): Promise<void> {
  const own = await nearestMandate(taskId, db);
  if (own.kind === "none" || own.rootTaskId !== taskId) return;
  const entry = mandateDefinitionEntries().get(own.mandateId);
  if (entry?.owned) {
    throw new HttpError(
      409,
      `Task "${taskId}" states the ${entry.mandate.label} mandate, which only its owner sets and changes.`,
    );
  }
}

export const handlePutTaskMandate = implement(
  putTaskMandate,
  async ({ params, body }) => {
    const entry = mandateDefinitionEntries().get(body.mandateId);
    if (!entry) {
      throw new HttpError(400, `No mandate "${body.mandateId}" is defined.`);
    }
    if (entry.owned) {
      throw new HttpError(
        400,
        `The ${entry.mandate.label} mandate is stated only by its owner, never by hand.`,
      );
    }
    if ((await getTask(params.taskId)) === null)
      throw new HttpError(404, `No task "${params.taskId}".`);
    await assertOwnMandateNotOwned(params.taskId);
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
    await assertOwnMandateNotOwned(params.taskId);
    await clearMandate(params.taskId);
  },
);
