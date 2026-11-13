import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  modelMeta,
  normalizeModel,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  CONVERSATION_LAUNCH_CAUSE_OPTIONS,
  CONVERSATION_LAUNCH_CAUSES,
  ConversationKindSchema,
  conversationName,
} from "@plugins/tasks/plugins/tasks-core/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { launchNotice } from "./launch-notice";

const startedIcon = symbol("forum");
const unblockedIcon = symbol("lock-open");

// Fires once per conversation.created (server-side) so the new-conversation
// notification is recorded a single time, regardless of how many browser tabs
// are open. Replaces the per-tab AutoLaunchWatcher useEffect.
// What it announces, if anything, is `launchNotice`'s decision.
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
      kind: ConversationKindSchema,
      launchCause: z.enum(CONVERSATION_LAUNCH_CAUSES),
      shownByLauncher: z.boolean().optional(),
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const notice = launchNotice({
      kind: event.kind,
      launchCause: event.launchCause,
      shownByLauncher: event.shownByLauncher === true,
    });
    if (notice === null) return;
    // TODO(§4, research/2026-10-25-global-notifications-in-user-terms.md):
    // "Conversation started" is sent only while the user is not watching
    // the conversation (`unlessWatching`). Until the watching presence lands
    // it is sent always.
    const conversation = await getConversation(event.conversationId);
    if (conversation === null) return; // deleted since the emit
    await recordNotification({
      type: "conversation",
      category: "conversations",
      icon: notice.unblocked ? unblockedIcon : startedIcon,
      title: notice.title,
      description: "",
      subjectId: conversation.id,
      subjectName: conversationName(conversation),
      detail: `${modelMeta(normalizeModel(event.model)).label} · ${CONVERSATION_LAUNCH_CAUSE_OPTIONS[event.launchCause].label}`,
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
