import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { reachableSlots } from "@plugins/infra/plugins/jobs/server";
import {
  QueueSlotHogPayloadSchema,
  type QueueSlotHogPayload,
} from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// Re-alert the bell at most once per 10 minutes while a job keeps hogging a
// slot. Slot-hogging is a persistent condition (the job stays locked tick after
// tick), so the cooldown re-surfaces it periodically without spamming — same
// rationale as the dead-job and backlog cooldowns.
const SLOT_HOG_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-slot-hog` report kind. Dedups per distinct `jobName` (fingerprint
// `queue-slot-hog:<jobName>`), so one long-running job collapses onto a single
// report while distinct hogs get distinct reports. Variant `warning`: a job holding
// a worker slot for too long starves the queue — the exact case the
// backlog `stalled` signal (which only trips at 0 locked) cannot see.
//
// "Too long" is PER HOLD CLASS: the threshold is the class's declared work
// ceiling times the configured headroom factor, so a `minutes` job holding a
// slot for six minutes is doing what it declared while an `instant` job holding
// one for six minutes has wedged a reserved floor slot. The threshold is
// measured on HOLD (the only quantity a locked graphile row exposes) against a
// ceiling defined on WORK, which is why the headroom factor exists — see the
// long comment on `checkSlotHogs` in `watchdog.ts`. When the excess is wait
// rather than work, `queue-slot-blocked` names the gate exactly.
export const slotHogKind = ReportKind({
  kind: "queue-slot-hog",
  schema: QueueSlotHogPayloadSchema,
  fingerprint: (d: QueueSlotHogPayload) => `queue-slot-hog:${d.jobName}`,
  // Exempt from the duress shed gate — see the same comment on `deadJobKind`.
  // A job holding a slot for many minutes is a normal SYMPTOM of a host under
  // duress, which is exactly the window in which the report would be shed.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Job hogging a queue slot",
    variant: "warning",
    notifCooldownMs: SLOT_HOG_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueSlotHogPayloadSchema.parse(row.data);
    return {
      title: `[queue] Slot hog: ${d.jobName}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: QueueSlotHogPayload): string {
  const lines: string[] = [];
  lines.push(
    `The job \`${d.jobName}\` has held a worker slot for ` +
      `${formatDurationMs(d.lockedForMs)}${
        d.hold ? `, far beyond what its \`${d.hold}\` hold class declares` : ""
      }. While it holds the slot, other ready jobs wait behind it — the queue is ` +
      "saturated even though the worker is running (so the backlog stall " +
      "signal, which only trips at 0 locked, stays silent).",
  );
  if (d.hold) {
    lines.push("");
    lines.push(
      `A \`${d.hold}\` row can be picked up by ${reachableSlots(
        d.hold,
      )} of the worker slots, so this hold is occupying one of them. If the ` +
        "time is really being spent WAITING on an admission gate rather than " +
        "working, `queue-slot-blocked` names the gate — check for a report on " +
        "this job there before reclassifying it.",
    );
  }
  lines.push("");
  lines.push(`**Job:** \`${d.jobName}\``);
  if (d.hold) lines.push(`**Hold class:** \`${d.hold}\``);
  lines.push(`**Held for:** ${formatDurationMs(d.lockedForMs)}`);
  if (d.thresholdMs !== undefined)
    lines.push(`**Threshold:** ${formatDurationMs(d.thresholdMs)}`);
  lines.push(`**Running rows (this job):** ${d.runningCount}`);
  if (d.sampleJobId) lines.push(`**Sample job id:** ${d.sampleJobId}`);
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
