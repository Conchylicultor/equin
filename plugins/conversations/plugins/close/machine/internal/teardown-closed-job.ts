import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { deleteConversation } from "@plugins/conversations/server";
import {
  ConversationStatusSchema,
  type ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";

const CLOSED: ConversationStatus = "done";

/**
 * Stop a closed conversation's agent, whatever closed it: the backstop of the
 * runtime half. The close endpoint stops the agent itself, in the request
 * (`CloseTeardown`); this catches every other way a row reaches `done` — an
 * exit action, the reconciler's own `closed` plan — so none leaves an agent
 * running. For a close that already stopped it, a no-op.
 *
 * Re-reads the row: a conversation resumed between the close and this run is
 * no longer `done`, and its new session must not be stopped. Stopping an
 * agent that already exited is a no-op (the runtime's `delete`).
 */
export const teardownClosedConversationJob = defineJob({
  name: "conversations.teardown-closed",
  description:
    "Stops a conversation's agent once the conversation is closed (its status moved to done), wherever the close was written.",
  // seconds: the runtime's `delete` waits for the agent to exit under its own
  // timeout, then kills it.
  hold: "seconds",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: ConversationStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event || event.status !== CLOSED) return;
    const row = await getConversation(event.conversationId);
    if (row?.status !== CLOSED) return;
    await deleteConversation(event.conversationId);
  },
});
