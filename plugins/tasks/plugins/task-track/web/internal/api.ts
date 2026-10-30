import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { putTaskTrack, type TaskTrack } from "../../core";

export async function setTaskTrackRemote(
  fetchEndpoint: FetchEndpoint,
  taskId: string,
  track: TaskTrack,
): Promise<void> {
  await fetchEndpoint(putTaskTrack, { taskId }, { body: { track } });
}
