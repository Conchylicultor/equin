import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const mcpRequest = defineEndpoint({
  route: "POST /api/mcp/:conversationId",
  internal: { why: "MCP transport used by agent sessions, never the browser" },
});
