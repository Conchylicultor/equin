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
 * Stop a closed conversation's agent, whatever closed it: the one owner of
 * that stop. Every close is `markConversationClosed`, which writes `done` and
 * emits `conversation.statusChanged` in ONE transaction, and this job (`dedup:
 * "none"`) is enqueued on it — so no row is `done` without this run queued,
 * whatever happens to the closing process after the commit (2026-11-08: a
 * close written by a backend that crashed a second later, its event emitted
 * after the commit and lost, left the agent running ten days). The stops a
 * close path runs inline (the close endpoint's `CloseTeardown`, the exit
 * actions) only make it sooner; for those, a no-op. A run that never succeeds
 * is caught by the status sweep's `stopAgentsOfClosed`, a minute later.
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
