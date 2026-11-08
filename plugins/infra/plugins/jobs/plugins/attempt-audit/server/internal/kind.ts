import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { crashFingerprint } from "@plugins/reports/plugins/crash/core";
import {
  describeFate,
  JOB_ATTEMPT_FAILED_KIND,
  JobAttemptFailedPayloadSchema,
  type JobAttemptFailedPayload,
} from "../../core";

/**
 * The `job-attempt-failed` report kind: **one attempt of a job threw.**
 *
 * Filed for EVERY failed attempt, the one a retry recovered included — the
 * failure has a cause whether or not the next attempt got lucky, and a retry
 * that hides it turns a deterministic bug into a flaky one. Its `fate` says
 * what happened next, restated when the run settles
 * (`restateReportOccurrence`): retrying → recovered on attempt N, or gave up.
 * Never delayed, thresholded or downgraded to wait for that: the variant is
 * `error` from the first occurrence.
 *
 * Identity is the crash identity of the attempt's own error (error type + top
 * frames, or its normalized message), scoped by the job's name — the same
 * material a job failure filed as a plain `crash` used — so one bug in one job
 * is one row however many attempts and runs hit it, and its fate never moves
 * it to another row.
 */
export const jobAttemptFailedKind = ReportKind({
  kind: JOB_ATTEMPT_FAILED_KIND,
  schema: JobAttemptFailedPayloadSchema,
  fingerprint: async (d: JobAttemptFailedPayload, ctx) =>
    `job-attempt:${await crashFingerprint(
      {
        ...d,
        // Only an error naming its subject adds to the job's name, so every
        // other job failure keeps its row.
        scope: d.scope ? `${d.jobName} › ${d.scope}` : d.jobName,
      },
      { ...ctx, message: d.error },
    )}`,
  meta: { tag: "[jobs]", notif: "Job attempt failed", variant: "error" },
  renderTask: (row: ReportRow) => {
    const d = JobAttemptFailedPayloadSchema.parse(row.data);
    return {
      title: `[jobs] ${d.jobName} failed: ${firstLine(d.error)}`,
      description: renderAttemptTask(row, d),
    };
  },
});

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function renderAttemptTask(row: ReportRow, d: JobAttemptFailedPayload): string {
  const lines: string[] = [];
  lines.push(
    `Attempt ${d.attempt} of ${d.maxAttempts} of \`${d.jobName}\` threw:`,
  );
  lines.push("");
  lines.push("```");
  lines.push(d.stack ?? d.error);
  lines.push("```");
  lines.push("");
  lines.push(`**What happened next:** ${describeFate(d.fate)}.`);
  lines.push("");
  lines.push(
    d.fate.state === "recovered"
      ? "**The failure still needs a cause.** A later attempt got through, " +
          "but nothing explains why this one did not: a retry that works " +
          "turns a deterministic bug into a flaky one. Find what made this " +
          "attempt fail (a race, a deploy mid-run, an input it could not " +
          "handle yet) and fix that — never raise the retry budget."
      : "Find what made the attempt fail and fix that.",
  );
  lines.push("");
  lines.push(`**Queue row:** \`${d.jobId}\` (run \`${d.workflowRunId}\`)`);
  if (d.errorType) lines.push(`**Error type:** \`${d.errorType}\``);
  lines.push("");
  lines.push(
    `**Occurrences:** ${row.count} (each a failed attempt; Debug → Reports ` +
      "lists the recent ones, each with its own outcome)",
  );
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
