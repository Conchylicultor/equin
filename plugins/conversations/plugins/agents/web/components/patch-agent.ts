import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { moveAgent, updateAgent } from "@plugins/conversations/plugins/agents/core";

// No `rank`: repositioning goes through `moveAgentTo` below, which carries
// positional intent and lets the server mint the rank against the complete
// sibling set. A client only ever holds a projection of that set.
type AgentPatch = {
  name?: string;
  parentId?: string | null;
};

export async function patchAgent(
  fetchEndpoint: FetchEndpoint,
  id: string,
  patch: AgentPatch,
) {
  await fetchEndpoint(updateAgent, { id }, { body: patch });
}

/** Reposition an agent: positional intent (`targetId`/`zone`), never a rank. */
export async function moveAgentTo(
  fetchEndpoint: FetchEndpoint,
  id: string,
  dest: {
    parentId: string | null;
    targetId: string | null;
    zone: "before" | "after";
  },
) {
  await fetchEndpoint(moveAgent, { id }, { body: dest });
}
