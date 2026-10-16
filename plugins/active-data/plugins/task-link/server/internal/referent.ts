import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { InlineTokenReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";

/**
 * A `task-<id>` token's task title, for text a model reads. Read from the
 * `tasks` TABLE (the title is its own column) rather than `getTask`'s `tasks_v`
 * view, so a live value rendering it declares `tasks` alone as its read.
 */
export async function resolveTaskReferent(
  id: string,
): Promise<InlineTokenReferent> {
  const [task] = await db
    .select({ title: _tasks.title })
    .from(_tasks)
    .where(eq(_tasks.id, id))
    .limit(1);
  return task ? { found: true, title: task.title } : { found: false };
}
