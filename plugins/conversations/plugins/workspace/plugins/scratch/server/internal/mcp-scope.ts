import { Mcp } from "@plugins/infra/plugins/mcp/server";
import {
  findWorkspaceOfConversation,
  ScratchProfile,
} from "@plugins/conversations/plugins/workspace/server";

/**
 * The MCP scope of a conversation: a scratch conversation sees exactly its
 * profile's `mcpTools`; every other one the default scope. A conversation
 * this backend has no row for was never launched as a scratch one here (it
 * dials the backend that created it), so it keeps the default scope.
 */
export const scratchMcpScope = Mcp.scope(async ({ conversationId }) => {
  const found = await findWorkspaceOfConversation(conversationId);
  if (!found.found || found.workspace.spec.kind !== "scratch") {
    return { kind: "default" };
  }
  const { profile } = found.workspace.spec;
  return {
    kind: "profile",
    profile,
    tools: ScratchProfile.get(profile).mcpTools,
  };
});
