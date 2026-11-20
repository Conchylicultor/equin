import { db } from "@plugins/database/server";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import { _attempts, _conversations } from "./tables";
import { eq, isNull } from "drizzle-orm";
import { withTaskStatusChange } from "./status-scope";

// An attempt with no conversation reads as an active attempt, so the task sits
// at "In progress" forever. Delete it on boot so the task's status is honest.
//
// This is an INVARIANT ALARM, not routine cleanup. A launch creates its attempt
// and its conversation in one transaction (conversations' `commitConversation`),
// so a crash or a throw mid-launch rolls both back and cannot leave one of these.
// Finding one therefore means a write path we cannot explain — it is announced on
// `orphanedAttemptSink`, which conversations maps to a crash report so the bell
// shows it. (A sink, not a direct recordReport: this barrel is loaded by
// drizzle-kit through the tables it exports, and reports/server pulls config_v2,
// which throws at module eval outside a backend.) The task is deliberately NOT re-armed for
// auto-start: that would guess the intent of the unexplained write.
export interface OrphanedAttempt {
  attemptId: string;
  taskId: string;
}

export const orphanedAttemptSink = defineReportSink<OrphanedAttempt>(
  "tasks/plugins/tasks-core:orphanedAttemptSink",
);

export async function sweepOrphanedAttempts(): Promise<void> {
  const orphaned = await db
    .select({ id: _attempts.id, taskId: _attempts.taskId })
    .from(_attempts)
    .leftJoin(_conversations, eq(_conversations.attemptId, _attempts.id))
    .where(isNull(_conversations.id));

  if (orphaned.length === 0) return;

  for (const attempt of orphaned) {
    await withTaskStatusChange(attempt.taskId, db, async () => {
      await db.delete(_attempts).where(eq(_attempts.id, attempt.id));
    });
    orphanedAttemptSink.emit({ attemptId: attempt.id, taskId: attempt.taskId });
  }
}
