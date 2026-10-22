import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  createPromptBlockTask,
  type CreatePromptBlockTaskBody,
} from "../../shared/endpoints";

// Create the task a prompt block launches, stamped with the block's provenance.
// Imperative (not a mutation hook) because it runs inside `LaunchControl`'s
// `getRequest` seam — the caller needs the task id back before it can launch.
// A non-2xx throws `EndpointError`; nothing is swallowed here.
export async function createPromptTask(
  fetchEndpoint: FetchEndpoint,
  body: CreatePromptBlockTaskBody,
): Promise<{ taskId: string }> {
  return fetchEndpoint(createPromptBlockTask, {}, { body });
}
