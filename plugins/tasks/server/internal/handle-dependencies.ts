import {
  addTaskDependency as addTaskDependencyDb,
  DependencyCycleError,
  removeTaskDependency,
} from "@plugins/tasks/plugins/tasks-core/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { addTaskDependency, removeTaskDependency as removeTaskDependencyEndpoint } from "../../core/endpoints";

export const handleAddDependency = implement(
  addTaskDependency,
  async ({ params, body }) => {
    try {
      await addTaskDependencyDb(params.id, body.dependsOnTaskId);
    } catch (err) {
      // A cycle is a conflict with the graph as it stands, not a bad request.
      if (err instanceof DependencyCycleError)
        throw new HttpError(409, err.message);
      const msg = err instanceof Error ? err.message : "Bad request";
      const status = msg.includes("not found") ? 404 : 400;
      throw new HttpError(status, msg);
    }
    // return undefined → implement() sends 204
  },
);

export const handleRemoveDependency = implement(
  removeTaskDependencyEndpoint,
  async ({ params }) => {
    const found = await removeTaskDependency(params.id, params.depId);
    if (!found) throw new HttpError(404, "Not found");
    // return undefined → implement() sends 204
  },
);
