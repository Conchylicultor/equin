import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  QueueBacklogPayloadSchema,
  type QueueBacklogPayload,
} from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// Re-alert the bell at most once per 10 minutes while the backlog persists. The
// backlog is a rolling metric on a singleton fingerprint, so the cooldown
// re-surfaces it periodically without spamming — same rationale as slow-op's.
const BACKLOG_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-backlog` report kind. One rolling report per worktree (fixed
// fingerprint — the reports unique index is (fingerprint, worktree), so
// worktrees never collide). Variant `warning`; the message escalates to a
// STALLED note when the worker is making no progress (0 locked + overdue).
export const backlogKind = ReportKind({
  kind: "queue-backlog",
  schema: QueueBacklogPayloadSchema,
  fingerprint: () => "queue-backlog:rollup",
  // Exempt from the duress shed gate — see the same comment on `deadJobKind`.
  // A host under duress is precisely when the queue backs up, so gating this
  // report on the duress latch means never filing it when it matters.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Job queue backing up",
    variant: "warning",
    notifCooldownMs: BACKLOG_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueBacklogPayloadSchema.parse(row.data);
    return {
      title: d.stalled
        ? "[queue] Job queue STALLED"
        : "[queue] Job queue backing up",
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: QueueBacklogPayload): string {
  const lines: string[] = [];
  if (d.stalled) {
    lines.push(
      "**STALLED — the worker is making no progress.** Jobs are overdue but " +
        "nothing is locked (running), so the queue is wedged rather than merely " +
        "busy.",
    );
  } else {
    lines.push(
      "The job queue is backing up: ready jobs are accumulating faster than the " +
        "worker is draining them.",
    );
  }
  lines.push("");
  lines.push(`**Ready (overdue, unlocked):** ${d.readyCount}`);
  lines.push(`**Oldest overdue:** ${formatDurationMs(d.oldestOverdueMs)}`);
  lines.push(`**Locked (running):** ${d.lockedCount}`);
  if (d.topReady && d.topReady.length > 0) {
    lines.push("");
    lines.push("**Top jobs in the ready queue:**");
    for (const j of d.topReady) {
      lines.push(
        `- \`${j.jobName}\` — ${j.readyCount} ready, oldest ${formatDurationMs(
          j.oldestOverdueMs,
        )}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Inspect the live queue in **Debug → Queue** and the full report history " +
      "in **Debug → Reports**.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
