import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { closeSession } from "./host";

/** Close a conversation's browser session when the conversation ends. */
export const browserConversationEndedJob = defineJob({
  name: "mcp-browser.conversation-ended",
  description:
    "Closes an agent's headless browser session (and reverts the writes it made) when its conversation ends.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: z.string() })
    .passthrough(),
  run: async ({ event }) => {
    if (!event || event.status !== "done") return;
    await closeSession(event.conversationId);
  },
});
