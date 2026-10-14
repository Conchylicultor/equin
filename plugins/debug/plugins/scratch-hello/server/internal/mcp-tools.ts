import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { workspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import { SCRATCH_HELLO } from "./profile";

// Visible only to `scratch.hello` conversations: proves a profile-only tool
// reaches its profile and no one else, and exercises the conversation →
// workspace lookup a real profile's tools use to find the agent's files.
export const scratchHelloWhereTool = Mcp.tool({
  name: "scratch_hello_where",
  description:
    "Reports the workspace this conversation runs in, as the server sees it (debug).",
  inputSchema: {},
  profiles: [SCRATCH_HELLO],
  handler: async (_args, { conversationId }) => {
    const at = await workspaceOfConversation(conversationId);
    return {
      content: [{ type: "text", text: JSON.stringify(at, null, 2) }],
    };
  },
});
