import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import {
  runInBackgroundLane,
  runTracked,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  jobAttemptSink,
  type JobAttemptEvent,
  type JobAttemptOutcome,
} from "@plugins/infra/plugins/jobs/server";
import {
  recordReport,
  restateReportOccurrence,
} from "@plugins/reports/plugins/engine/server";
import {
  attemptReportMessage,
  JOB_ATTEMPT_FAILED_KIND,
  type AttemptFate,
  type JobAttemptFailedPayload,
} from "../../core";
import { _jobAttemptReports } from "./tables";

type Failed = Extract<JobAttemptEvent, { phase: "failed" }>;
type Settled = Extract<JobAttemptEvent, { phase: "settled" }>;

// One queue row's events in the order the queue announced them: a settle
// that follows its attempt's failure by milliseconds (a last attempt, then
// its death) must find that attempt's link already written.
const perRow = createKeyedMutex();

/**
 * The parent's attempt seam into the reports engine. A `sinkHandlers` entry;
 * until it attaches, the parent files each failed attempt as a plain server
 * error instead (`announceAttemptFailed`).
 *
 * `true` = this event has a durable home and is on its way there (the writes
 * are detached: the seam is called from the queue's failure path, which must
 * not wait on them). A write that fails rejects unhandled, which the reports
 * engine files.
 */
export const attemptReports = sinkHandler(
  jobAttemptSink,
  () =>
    (event: JobAttemptEvent): boolean => {
      void runTracked(`jobs.attempt-audit:${event.phase}`, () =>
        perRow.run(event.jobId, () =>
          runInBackgroundLane(() =>
            event.phase === "failed" ? fileAttempt(event) : settle(event),
          ),
        ),
      );
      return true;
    },
);

async function fileAttempt(event: Failed): Promise<void> {
  const data: JobAttemptFailedPayload = {
    jobName: event.jobName,
    jobId: event.jobId,
    workflowRunId: event.workflowRunId,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    error: event.message,
    ...event.crash,
    fate: { state: event.retrying ? "retrying" : "last-attempt" },
  };
  const occurredAt = Date.now();
  const filed = await recordReport({
    kind: JOB_ATTEMPT_FAILED_KIND,
    source: "server-caught",
    message: attemptReportMessage(data),
    data,
    occurredAt,
  });
  // Shed (replayed later, as filed), collapsed into a storm rollup, or handed
  // to the outbox: no row this process can restate. It stays saying what it
  // knew when it was filed.
  if (filed.outcome !== "recorded") return;
  await db
    .insert(_jobAttemptReports)
    .values({
      jobId: event.jobId,
      attempt: event.attempt,
      reportId: filed.reportId,
      occurredAt: new Date(occurredAt),
      data,
    })
    // A link a lost settle left on this (row, attempt) — the row since retried
    // from Debug → Queue, which restarts its attempts — names an occurrence
    // that already says all it will: this attempt's is the one to restate.
    .onConflictDoUpdate({
      target: [_jobAttemptReports.jobId, _jobAttemptReports.attempt],
      set: {
        reportId: filed.reportId,
        occurredAt: new Date(occurredAt),
        data,
        createdAt: new Date(),
      },
    });
}

async function settle(event: Settled): Promise<void> {
  const links = await db
    .select()
    .from(_jobAttemptReports)
    .where(eq(_jobAttemptReports.jobId, event.jobId));
  if (links.length === 0) return;
  const fate = fateOf(event.outcome, Date.now());
  for (const link of links) {
    const data: JobAttemptFailedPayload = { ...link.data, fate };
    await restateReportOccurrence({
      reportId: link.reportId,
      kind: JOB_ATTEMPT_FAILED_KIND,
      occurredAt: link.occurredAt.getTime(),
      message: attemptReportMessage(data),
      data,
    });
  }
  await db
    .delete(_jobAttemptReports)
    .where(eq(_jobAttemptReports.jobId, event.jobId));
}

function fateOf(outcome: JobAttemptOutcome, at: number): AttemptFate {
  switch (outcome.kind) {
    case "recovered":
      return {
        state: "recovered",
        attempt: outcome.attempt,
        suspended: outcome.suspended,
        at,
      };
    case "dead":
      return {
        state: "gave-up",
        cause: outcome.cause,
        error: outcome.error,
        at,
      };
    case "superseded":
      return { state: "superseded", at };
  }
}
