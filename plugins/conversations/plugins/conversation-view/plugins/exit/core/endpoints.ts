import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const exitConversation = defineEndpoint({
  route: "POST /api/conversations/:id/exit",
  needsMachine: { feature: "Closing an agent's conversation" },
});
