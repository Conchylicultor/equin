import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { putTaskEffort, deleteTaskEffort } from "../../shared/endpoints";

export async function setTaskEffortRemote(
  fetchEndpoint: FetchEndpoint,
  taskId: string,
  level: EffortLevel | null,
): Promise<void> {
  if (level) {
    await fetchEndpoint(putTaskEffort, { taskId }, { body: { level } });
  } else {
    await fetchEndpoint(deleteTaskEffort, { taskId });
  }
}
