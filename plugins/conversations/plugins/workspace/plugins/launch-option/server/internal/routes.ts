import { implement } from "@plugins/infra/plugins/endpoints/server";
import { putTaskWorkspace, deleteTaskWorkspace } from "../../shared/endpoints";
import { setTaskWorkspace } from "./mutations";

export const handlePutTaskWorkspace = implement(
  putTaskWorkspace,
  async ({ params, body }) => {
    await setTaskWorkspace(params.taskId, body.spec);
  },
);

export const handleDeleteTaskWorkspace = implement(
  deleteTaskWorkspace,
  async ({ params }) => {
    await setTaskWorkspace(params.taskId, null);
  },
);
