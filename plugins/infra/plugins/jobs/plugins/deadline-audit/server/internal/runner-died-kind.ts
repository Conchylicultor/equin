import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  JOB_RUNNER_DIED_KIND,
  type JobRunnerDiedReport,
} from "@plugins/infra/plugins/jobs/server";
import {
  JobRunnerDiedPayloadSchema,
  type JobRunnerDiedPayload,
} from "../../core";
import { formatDurationMs } from "./format-duration";

// tsc-level proof that this kind validates exactly what the parent writes: the
// parent writes the object straight to disk on its way out, so this assignment
// is the only place a drifting field can be a type error. See slot-floor-kind.ts.
const _payloadMatchesWhatTheParentWrites: (
  written: JobRunnerDiedReport,
) => JobRunnerDiedPayload = (written) => written;
void _payloadMatchesWhatTheParentWrites;

const NOTIF_COOLDOWN_MS = 600_000;

/**
 * The `job-runner-died` report kind: **graphile stopped one of this backend's
 * runners on its own.** One rolling report per worktree, like `job-slot-floor`.
 * `duressExempt` for the same reason: it is the only evidence of a backend that
 * exited on purpose. Written synchronously by the parent during the exit and
 * replayed on the next boot, so only the kind has to exist.
 */
export const runnerDiedKind = ReportKind({
  kind: JOB_RUNNER_DIED_KIND,
  schema: JobRunnerDiedPayloadSchema,
  fingerprint: () => JOB_RUNNER_DIED_KIND,
  duressExempt: true,
  meta: {
    tag: "[jobs]",
    notif: "A job runner stopped on its own",
    variant: "error",
    category: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = JobRunnerDiedPayloadSchema.parse(row.data);
    return {
      title:
        d.action === "crashed"
          ? `[jobs] backend exited — the ${d.runnerId} runner stopped on its own`
          : `[jobs] the ${d.runnerId} runner is dead and the restart was suppressed`,
      description: renderRunnerDied(row, d),
    };
  },
});

function renderRunnerDied(row: ReportRow, d: JobRunnerDiedPayload): string {
  const served = d.serves.map((h) => `\`${h}\``).join(", ");
  const lines: string[] = [
    `graphile stopped the \`${d.runnerId}\` runner (${d.concurrency} slots, serves ${served}): ` +
      `\`${d.reason}\`. A stopped runner never comes back in the same process.`,
    "",
  ];
  if (d.carriesCron) {
    lines.push(
      "This runner carries the cron schedule, so every scheduled job stopped with it.",
      "",
    );
  }
  if (d.action === "crashed") {
    lines.push(
      "**The backend exited on purpose**, so the next boot starts every runner again. " +
        "The restart is lazy: the next request through the gateway starts it.",
    );
  } else {
    lines.push(
      `**The backend stayed up without this runner.** This worktree has exited ` +
        `${d.tripsThisWindow - 1} times within ${formatDurationMs(d.windowMs)}, past the ` +
        `${d.maxTripsPerWindow} the anti-loop latch allows, so the runner stays dead until ` +
        `someone restarts the backend. The cause keeps recurring; restarting alone will not fix it.`,
    );
  }
  lines.push(
    "",
    "**What to do:** find what the reason above names. graphile already retried it, so it is " +
      "not a passing blip.",
    "",
    `**Occurrences:** ${row.count}`,
    `**Worktree:** ${row.worktree}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  );
  return lines.join("\n");
}
