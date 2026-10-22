import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { WorkspaceSpec } from "@plugins/conversations/plugins/workspace/core";
import { putTaskWorkspace, deleteTaskWorkspace } from "../../shared/endpoints";

export async function setTaskWorkspaceRemote(
  fetchEndpoint: FetchEndpoint,
  taskId: string,
  spec: WorkspaceSpec | null,
): Promise<void> {
  if (spec) {
    await fetchEndpoint(putTaskWorkspace, { taskId }, { body: { spec } });
  } else {
    await fetchEndpoint(deleteTaskWorkspace, { taskId });
  }
}
