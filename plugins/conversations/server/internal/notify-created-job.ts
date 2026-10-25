import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import {
  modelMeta,
  normalizeModel,
} from "@plugins/conversations/plugins/model-provider/core";

// spawnedBy values that mean "a conversation was launched on the user's behalf"
// and should surface a one-time notification. Mirrors the old client-side
// AutoLaunchWatcher filter set; anything else (e.g. forks, system) is silent.
const CAUSALITY_VALUES = new Set([
  "user-launch",
  "dep-resolved",
  "mcp-add-task",
]);

// Fires once per conversation.created (server-side) so the new-conversation
// notification is recorded a single time, regardless of how many browser tabs
// are open. Replaces the per-tab AutoLaunchWatcher useEffect.
export const notifyConversationCreatedJob = defineJob({
  name: "conversations.notify-created",
  description:
    "Records a notification when a conversation is launched on the user's behalf, once regardless of how many tabs are open.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      taskId: z.string(),
      model: z.string(),
      spawnedBy: z.string(),
      shownByLauncher: z.boolean().optional(),
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (!CAUSALITY_VALUES.has(event.spawnedBy)) return;

    const model = modelMeta(normalizeModel(event.model)).label;
    const task = await getTask(event.taskId);
    const taskTitle = task?.title ?? "";
    const title =
      event.spawnedBy === "dep-resolved"
        ? "Task unblocked"
        : "Conversation started";
    const description = taskTitle ? `${taskTitle} · ${model}` : model;

    await recordNotification({
      type: "task",
      title,
      description,
      variant: "info",
      // The launcher already shows it (an opened pane, an embedded thread): a
      // toast would only cover what the user is looking at. Still in the bell.
      muted: event.shownByLauncher === true,
      linkTo: conversationRoute.link(agentManagerApp, {
        convId: event.conversationId,
      }),
      dedupeKey: `conversation-created:${event.conversationId}`,
    });
  },
});
