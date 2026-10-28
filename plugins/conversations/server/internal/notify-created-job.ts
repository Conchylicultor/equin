import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  modelMeta,
  normalizeModel,
} from "@plugins/conversations/plugins/model-provider/core";
import { conversationName } from "@plugins/tasks/plugins/tasks-core/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const startedIcon = symbol("forum");
const unblockedIcon = symbol("lock-open");

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

    // The launcher already shows it (an opened pane, an embedded thread):
    // the notification would only cover what the user is looking at — and
    // since the bell is exactly the toasts sent, it is not recorded at all.
    if (event.shownByLauncher === true) return;
    // TODO(§4, research/2026-10-25-global-notifications-in-user-terms.md):
    // "Conversation started" is sent only while the user is not watching
    // the conversation (`unlessWatching`). Until the watching presence lands
    // it is sent always.
    const conversation = await getConversation(event.conversationId);
    if (conversation === null) return; // deleted since the emit
    const unblocked = event.spawnedBy === "dep-resolved";
    await recordNotification({
      type: "conversation",
      category: "conversations",
      icon: unblocked ? unblockedIcon : startedIcon,
      title: unblocked ? "Conversation unblocked" : "Conversation started",
      description: "",
      subjectId: conversation.id,
      subjectName: conversationName(conversation),
      detail: `${modelMeta(normalizeModel(event.model)).label} · ${event.spawnedBy}`,
      variant: "info",
      action: {
        kind: "open",
        payload: {
          to: conversationRoute.link(agentManagerApp, {
            convId: event.conversationId,
          }),
        },
      },
      dedupeKey: `conversation-created:${event.conversationId}`,
    });
  },
});
