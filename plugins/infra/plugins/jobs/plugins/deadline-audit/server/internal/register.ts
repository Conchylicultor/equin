import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  jobDeadlineSink,
  type JobDeadlineEvent,
} from "@plugins/infra/plugins/jobs/server";
import type { JobDeadlinePayload } from "../../core";
import { formatDurationMs } from "./format-duration";

/**
 * Route deadline announcements from the parent's seam into the reports engine.
 *
 * Registered in `onReady` and cleared in `onShutdown`. Until it is registered
 * the seam is a no-op that returns `undefined`, and the parent treats that as its explicit
 * fallback branch (`reportServerError`) — so a deadline firing before this
 * plugin is ready is still loud, it just lands as a plain server error instead
 * of a typed report.
 */
export function registerDeadlineReports(): void {
  jobDeadlineSink.register((event: JobDeadlineEvent): boolean => {
    const data: JobDeadlinePayload = {
      jobName: event.jobName,
      jobId: event.jobId,
      attempt: event.attempt,
      hold: event.hold,
      deadlineMs: event.deadlineMs,
      elapsedMs: event.elapsedMs,
      runnerId: event.runnerId,
    };

    // Detached deliberately. The seam's handler is synchronous — it is called
    // from the deadline timer, on the abort path — and `recordReport` is a DB
    // write. Awaiting it is not an option, and returning a promise would make
    // the seam's contract "did it record?" unanswerable at the moment we have
    // to answer it. So `true` here means *this event has a durable home and is
    // on its way there*, which is exactly the question the parent's fallback
    // branch needs answered: it distinguishes "nobody is listening" from "a
    // consumer owns this". A failure inside `recordReport` surfaces as an
    // unhandled rejection, which the reports plugin itself files.
    // A zombie that finally settled. There is no kind for it, deliberately:
    // the durable record it would update is a `job-zombie` row, and bumping
    // that row's count to say "it recovered" would make the count mean two
    // opposite things. Declining it (`false`) rather than claiming it is the
    // honest answer to the seam's question — the parent then logs the recovery
    // and files nothing, which is the branch it has for exactly this.
    if (event.phase === "unforfeited") return false;

    if (event.phase === "zombie") {
      void recordReport({
        kind: "job-zombie",
        source: "server-queue-monitor",
        message:
          `${event.jobName} ignored its ${event.hold} deadline — still holding a ` +
          `slot after ${formatDurationMs(event.elapsedMs)}`,
        data,
      });
      return true;
    }

    void recordReport({
      kind: "job-deadline-exceeded",
      source: "server-queue-monitor",
      message:
        `${event.jobName} (${event.hold}) exceeded its ` +
        `${formatDurationMs(event.deadlineMs)} deadline — held ` +
        `${formatDurationMs(event.elapsedMs)}, aborted`,
      data,
    });
    return true;
  });
}

export function unregisterDeadlineReports(): void {
  jobDeadlineSink.register(null);
}
