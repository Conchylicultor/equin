import { implement } from "@plugins/infra/plugins/endpoints/server";
import { putTaskRuntime, deleteTaskRuntime } from "../../shared/endpoints";
import { setTaskRuntime } from "./mutations";

export const handlePutTaskRuntime = implement(
  putTaskRuntime,
  async ({ params, body }) => {
    await setTaskRuntime(params.taskId, body.runtime);
  },
);

export const handleDeleteTaskRuntime = implement(
  deleteTaskRuntime,
  async ({ params }) => {
    await setTaskRuntime(params.taskId, null);
  },
);
