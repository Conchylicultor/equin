import { db } from "@plugins/database/server";
import { _attempts } from "../tables";
import { attempts } from "../views";
import { eq } from "drizzle-orm";
import { withTaskStatusChange } from "../status-scope";
import type { DbExecutor } from "../status-batch";
import type { WorkspaceSpec } from "@plugins/conversations/plugins/workspace/core";

export async function deleteAttempt(id: string): Promise<void> {
  const [row] = await db
    .select({ taskId: _attempts.taskId })
    .from(_attempts)
    .where(eq(_attempts.id, id))
    .limit(1);
  if (!row) return;
  await withTaskStatusChange(row.taskId, db, async () => {
    await db.delete(_attempts).where(eq(_attempts.id, id));
  });
}

export interface CreateAttemptInput {
  id: string;
  taskId: string;
  worktreePath: string;
  workspace: WorkspaceSpec;
}

// `exec`: pass the transaction when the attempt must commit together with the
// rest of a launch (see conversations' `commitConversation`). Inside a status
// batch it MUST be the batch's tx — `withTaskStatusChange` asserts it.
export async function createAttempt(
  input: CreateAttemptInput,
  exec: DbExecutor = db,
) {
  // The new attempt may flip the parent task's computed status (e.g.
  // new → attempted → in_progress once a conversation lands). The actual
  // flip usually happens via insertConversation, but the write is bracketed
  // here too in case an attempt is created without one.
  await withTaskStatusChange(input.taskId, exec, async () => {
    await exec.insert(_attempts).values(input);
  });
  const [row] = await exec
    .select()
    .from(attempts)
    .where(eq(attempts.id, input.id))
    .limit(1);
  return row!;
}
