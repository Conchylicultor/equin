import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const mcpRequest = defineEndpoint({
  route: "POST /api/mcp/:conversationId",
});
