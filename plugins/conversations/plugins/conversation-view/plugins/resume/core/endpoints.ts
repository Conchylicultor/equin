import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const resumeConversationEndpoint = defineEndpoint({
  route: "POST /api/conversations/:id/resume",
  needsMachine: { feature: "Resuming an agent" },
  unpredicted: {
    reason: "precondition",
    why: "The server answers 409 with a message when the resume is blocked (workspace gone, not signed in), which the button shows.",
  },
});
