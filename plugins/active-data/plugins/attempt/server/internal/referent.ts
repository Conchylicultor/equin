import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { InlineTokenReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { _attempts, _tasks } from "@plugins/tasks/plugins/tasks-core/server";

/**
 * An `att-<id>` token's name, for text a model reads: the title of the task the
 * attempt works on — the name the chip falls back to before its conversation
 * has a title of its own. Read from the `attempts` and `tasks` TABLES, not the
 * `attempts_v` / `tasks_v` views `getAttempt` / `getTask` read, so a live value
 * rendering it declares base tables only.
 */
export async function resolveAttemptReferent(
  id: string,
): Promise<InlineTokenReferent> {
  const [row] = await db
    .select({ title: _tasks.title })
    .from(_attempts)
    .innerJoin(_tasks, eq(_tasks.id, _attempts.taskId))
    .where(eq(_attempts.id, id))
    .limit(1);
  return row ? { found: true, title: row.title } : { found: false };
}
