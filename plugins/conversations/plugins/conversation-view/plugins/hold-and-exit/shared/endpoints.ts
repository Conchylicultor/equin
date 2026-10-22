import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const holdAndExit = defineEndpoint({
  route: "POST /api/conversations/:id/hold-and-exit",
  needsMachine: { feature: "Closing an agent's conversation" },
});
