import { recordReport } from "@plugins/reports/plugins/engine/server";
import { orphanedAttemptSink } from "@plugins/tasks/plugins/tasks-core/server";

// tasks-core's boot sweep deletes attempts that have no conversation. A launch
// commits its attempt and conversation in one transaction (`commitConversation`),
// so one of these means a write path nobody can explain: file it as a crash so
// the bell shows it. Registered here because this plugin owns that launch
// invariant, and tasks-core cannot import reports (see the sink's comment).
// The sink holds what the sweep emitted before this registers, then replays it.
export function registerOrphanedAttemptReport(): void {
  orphanedAttemptSink.register(({ attemptId, taskId }) => {
    void recordReport({
      kind: "crash",
      source: "server-caught",
      message:
        `Swept orphaned attempt ${attemptId} (task ${taskId}): an attempt existed ` +
        `with no conversation, which a transactional launch cannot leave behind`,
      data: {
        errorType: "OrphanedAttemptError",
        label: "tasks-core.sweepOrphanedAttempts",
      },
    });
  });
}
