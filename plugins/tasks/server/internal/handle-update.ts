import { taskAttachments, updateTask } from "@plugins/tasks/plugins/tasks-core/server";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { updateTask as updateTaskEndpoint } from "../../core";

export const handleUpdate = implement(updateTaskEndpoint, async ({ params, body }) => {
  let row;
  try {
    row = await updateTask(params.id, body);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Bad request");
  }
  if (!row) throw new HttpError(404, "Not found");

  // Description is the only text column that can carry attachment refs today.
  // Reconcile the task's link rows against the ids referenced in the new
  // description; the orphan sweep collects any attachment that loses its last
  // link.
  if (typeof body.description === "string" || body.description === null) {
    const ids = body.description ? extractAttachmentIds(body.description) : [];
    await taskAttachments.set(params.id, ids);
  }
  return row;
});
