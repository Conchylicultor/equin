import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  QueueDeadJobPayloadSchema,
  type QueueDeadJobPayload,
} from "../../core";

// Re-alert the bell at most once per 10 minutes while a job stays terminally
// dead. A dead-job storm is a persistent condition (it keeps retrying until
// max_attempts each tick), not a one-shot incident, so the cooldown re-surfaces
// it periodically without spamming — same rationale as slow-op's cooldown.
const DEAD_JOB_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-dead-job` report kind. Dedups per distinct `jobName`, so a
// retry-storm of one broken job collapses onto a single report while distinct
// broken jobs (e.g. a missing-relation job vs an unknown-job-name job) get
// distinct reports. Variant `error`: terminally-failed jobs are silently clogging
// the queue and never running.
export const deadJobKind = ReportKind({
  kind: "queue-dead-job",
  schema: QueueDeadJobPayloadSchema,
  fingerprint: (d: QueueDeadJobPayload) => `queue-dead-job:${d.jobName}`,
  // Every queue kind is duressExempt, for the same reason `duress-shed` and
  // `duress-episode` are: a queue in trouble and a host under duress are
  // overwhelmingly the same event, so the shed gate in `recordReport` would
  // buffer exactly the reports that describe the outage — and drop them on
  // buffer overflow at peak. These reports ARE the durable record of the
  // condition; shedding them loses the only evidence there was one. This was
  // the second, quieter silencer of the 2026-08-17 queue wedge: even a monitor
  // that ran would have had its report swallowed.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Dead jobs in queue",
    variant: "error",
    notifCooldownMs: DEAD_JOB_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueDeadJobPayloadSchema.parse(row.data);
    return {
      title: `[queue] Dead jobs: ${d.jobName}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: QueueDeadJobPayload): string {
  const lines: string[] = [];
  lines.push(
    `The job \`${d.jobName}\` has terminally-failed rows in the queue ` +
      "(exhausted retries, not currently locked). They never run and clog " +
      "`graphile_worker._private_jobs` until the hourly dead-job GC archives them.",
  );
  lines.push("");
  lines.push(`**Job:** \`${d.jobName}\``);
  lines.push(`**Dead rows:** ${d.deadCount}`);
  lines.push(`**Attempts:** ${d.attempts} / ${d.maxAttempts}`);
  if (d.sampleJobId) lines.push(`**Sample job id:** ${d.sampleJobId}`);
  if (d.lastError) {
    lines.push("");
    lines.push("**Last error:**");
    lines.push("```");
    lines.push(d.lastError);
    lines.push("```");
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
