import { getTask as getTaskDb } from "@plugins/tasks/plugins/tasks-core/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getTask } from "../../core";

export const handleGet = implement(getTask, async ({ params }) => {
  const row = await getTaskDb(params.id);
  if (!row) throw new HttpError(404, "Not found");
  return row;
});
