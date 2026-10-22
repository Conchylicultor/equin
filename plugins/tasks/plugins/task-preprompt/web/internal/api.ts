import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { putTaskPreprompt, deleteTaskPreprompt } from "../../shared/endpoints";

export async function setTaskPrepromptRemote(
  fetchEndpoint: FetchEndpoint,
  taskId: string,
  prepromptId: string | null,
): Promise<void> {
  if (prepromptId) {
    await fetchEndpoint(putTaskPreprompt, { taskId }, { body: { prepromptId } });
  } else {
    await fetchEndpoint(deleteTaskPreprompt, { taskId });
  }
}
