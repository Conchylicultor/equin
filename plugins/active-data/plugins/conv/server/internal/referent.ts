import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { InlineTokenReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";

/**
 * A `conv-<id>` token's name, for text a model reads: the conversation's own
 * title, else the title of the task it works on (a fresh conversation has none
 * yet). Read from the `conversations`, `attempts` and `tasks` TABLES, not the
 * `conversations_v` / `attempts_v` / `tasks_v` views `getConversation` & co.
 * read, so a live value rendering it declares base tables only.
 */
export async function resolveConversationReferent(
  id: string,
): Promise<InlineTokenReferent> {
  const [row] = await db
    .select({ title: _conversations.title, taskTitle: _tasks.title })
    .from(_conversations)
    .innerJoin(_attempts, eq(_attempts.id, _conversations.attemptId))
    .innerJoin(_tasks, eq(_tasks.id, _attempts.taskId))
    .where(eq(_conversations.id, id))
    .limit(1);
  if (!row) return { found: false };
  const own = row.title?.trim();
  return { found: true, title: own ? own : row.taskTitle };
}
