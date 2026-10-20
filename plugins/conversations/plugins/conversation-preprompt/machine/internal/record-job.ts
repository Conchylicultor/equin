import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { getTaskPreprompt } from "@plugins/tasks/plugins/task-preprompt/server";
import { resolvePrepromptItem } from "@plugins/conversations/plugins/preprompts/server";
import { recordConversationPreprompt } from "../../server/internal/record";

// Bound to the `conversationCreated` trigger event (see this plugin's machine
// barrel). For every newly created conversation, snapshots the launching
// task's selected preprompt (id + title + text) onto the conversation so the
// header chip can display exactly what the agent was launched with.
//
// Mirrors conversation-category's classify-job: reads `conversationId` from the
// triggering event. Fetches `getConversation` for the taskId (rather than
// trusting the event payload) for robustness against payload drift.
export const recordPrepromptJob = defineJob({
  name: "conversation-preprompt.record",
  description:
    "Saves the preprompt a task was launched with onto each new conversation so its header can show what the agent was given.",
  hold: "instant",
  input: z.object({
    conversationId: z.string().optional(),
  }),
  event: z
    .object({
      conversationId: z.string(),
      prepromptId: z.string().optional(),
    })
    .passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ input, event }) => {
    const conversationId = input.conversationId ?? event?.conversationId;
    if (!conversationId) {
      console.warn(
        "[conversation-preprompt] record fired with no conversationId; skipping",
      );
      return;
    }

    const conversation = await getConversation(conversationId);
    if (!conversation?.taskId) {
      // The conversation row may have been deleted between event emit and job
      // dispatch — nothing to record.
      return;
    }

    const prepromptId =
      event?.prepromptId ??
      (await getTaskPreprompt(conversation.taskId))?.prepromptId;
    const item = resolvePrepromptItem(prepromptId);
    if (!item) return;

    await recordConversationPreprompt(conversationId, {
      prepromptId: item.id,
      title: item.title,
      text: item.prompt,
      icon: item.icon,
    });
  },
});
