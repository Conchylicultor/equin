import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const resumeConversationEndpoint = defineEndpoint({
  route: "POST /api/conversations/:id/resume",
  needsMachine: { feature: "Resuming an agent" },
});
