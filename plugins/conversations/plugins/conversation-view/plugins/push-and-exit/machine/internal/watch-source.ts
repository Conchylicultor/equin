import { watchSource } from "@plugins/tasks/plugins/orchestration/plugins/watch/machine";
import { FLAG_CATEGORIES } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/flag-categories/core";
import { conversationFlagRaised } from "../../server/internal/tables-events";

/** A raised flag reaches whoever watches its task (`flagged`). */
export const flagWatchSource = watchSource({
  id: "flag",
  on: conversationFlagRaised,
  toEvents: (p) => [
    {
      kind: "flagged",
      taskId: p.taskId,
      actorConversationId: p.conversationId,
      summary: p.items
        .map((item) => `${FLAG_CATEGORIES[item.category].label}: ${item.text}`)
        .join("\n"),
    },
  ],
});
