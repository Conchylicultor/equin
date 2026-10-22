import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { createTodoBlockTask } from "../../shared/endpoints";

/**
 * Dispatch an agent onto a TODO card: get back the card's task (created on the
 * first call, reused after) and the prompt to launch it with.
 *
 * Imperative rather than a mutation hook because it runs inside
 * `LaunchAgentForm`'s `getRequest` seam — the caller needs both values back
 * before it can launch. A non-2xx throws `EndpointError`; nothing is swallowed.
 */
export async function dispatchTodoAgent(
  fetchEndpoint: FetchEndpoint,
  blockId: string,
  context: string,
): Promise<{ taskId: string; prompt: string }> {
  return fetchEndpoint(
    createTodoBlockTask,
    { blockId },
    { body: { context: context.trim() || undefined } },
  );
}
