import { ne } from "drizzle-orm";
import { activityServed } from "@plugins/activity/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationActivityArm } from "../../core";

/**
 * Conversations, bound into the activity union — system conversations left
 * out, as the All-conversations list leaves them out: they are the app's own
 * machinery (summaries, titles), not work anyone did.
 */
export const conversationActivityServed = activityServed.arm(
  conversationActivityArm,
  {
    from: _conversations,
    id: _conversations.id,
    base: (j) => ({
      title: j.base.title,
      updatedAt: j.base.updatedAt,
      createdAt: j.base.createdAt,
    }),
    // status / model / kind are picked: bound by name.
    extra: () => ({}),
    where: (j) => ne(j.base.kind, "system"),
  },
);
