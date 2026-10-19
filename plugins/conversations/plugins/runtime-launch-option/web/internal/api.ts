import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { ConversationRuntimeId } from "@plugins/conversations/plugins/runtime-catalog/core";
import { putTaskRuntime, deleteTaskRuntime } from "../../shared/endpoints";

export async function setTaskRuntimeRemote(
  taskId: string,
  runtime: ConversationRuntimeId | null,
): Promise<void> {
  if (runtime) {
    await fetchEndpoint(putTaskRuntime, { taskId }, { body: { runtime } });
  } else {
    await fetchEndpoint(deleteTaskRuntime, { taskId });
  }
}
