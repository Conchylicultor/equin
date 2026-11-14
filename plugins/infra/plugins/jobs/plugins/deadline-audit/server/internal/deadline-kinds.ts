import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { JobDeadlinePayloadSchema, type JobDeadlinePayload } from "../../core";
import { formatDurationMs } from "./format-duration";

// Re-alert the bell at most once per 10 minutes per job. An overrunning job is
// a persistent condition — the same handler trips on every dispatch — so the
// cooldown re-surfaces it periodically without spamming, the same rationale the
// four queue-health kinds use.
const NOTIF_COOLDOWN_MS = 600_000;

// `duressExempt: true` on BOTH kinds. A job wedging its slot and a host duress
// episode are the SAME event far more often than not — the box is in trouble,
// the sentinel latches duress, and the reports funnel starts shedding. Without
// this flag `recordReport` buffers exactly the reports that describe the outage
// and hands back `{ reportId: null }`, so the alarm for the outage is silenced
// by the outage. That is Silencer 2 of the 2026-08-17 incident, and the same
// argument `wedged-kind.ts`, `duress-shed` and `duress-episode` all make: this
// report IS the durable record of the condition, so shedding it loses the only
// evidence there was one.

/**
 * The `job-deadline-exceeded` report kind: **one run of this job passed its
 * class's deadline and was given up on.**
 *
 * Deduped per `jobName`, because that is the unit anyone acts on: one handler
 * overrunning across many dispatches is one problem, not N.
 *
 * Variant `warning`, not `error`: the abort itself is the system working. The
 * handler may well unwind cleanly, fail, and retry — an ordinary job failure
 * from there. What escalates to `error` is the handler ignoring the abort, and
 * that has its own kind below.
 */
export const deadlineExceededKind = ReportKind({
  kind: "job-deadline-exceeded",
  schema: JobDeadlinePayloadSchema,
  fingerprint: (d: JobDeadlinePayload) => `job-deadline-exceeded:${d.jobName}`,
  duressExempt: true,
  meta: {
    tag: "[jobs]",
    notif: "Job exceeded its hold-class deadline",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = JobDeadlinePayloadSchema.parse(row.data);
    return {
      title: `[jobs] ${d.jobName} exceeded its ${d.hold} deadline`,
      description: renderExceeded(row, d),
    };
  },
});

function renderExceeded(row: ReportRow, d: JobDeadlinePayload): string {
  const lines: string[] = [];
  lines.push(
    `\`${d.jobName}\` held a worker slot for ${formatDurationMs(d.elapsedMs)} — ` +
      `past the ${formatDurationMs(d.deadlineMs)} its \`${d.hold}\` hold class ` +
      `allows one run — so the worker gave up on it and aborted \`ctx.signal\`.`,
  );
  lines.push("");
  lines.push(
    "**Nothing was taken away from the handler.** The job row was not touched " +
      "and its advisory lock was not released, so it cannot be re-dispatched " +
      "while it is still running. The abort is the only lever the worker has: " +
      "if the handler threads the signal into what it waits on, it fails now " +
      "and frees the slot. If it does not, it keeps running invisibly — and a " +
      "`job-zombie` report follows shortly after saying exactly that.",
  );
  lines.push("");
  lines.push(
    "**This is the escalation of `queue-slot-hog` for the same job.** That " +
      "report fires at a fraction of this same deadline, so if the condition " +
      "was building you should already have one for `" +
      d.jobName +
      "` — this one says the warning went unanswered and the run was killed.",
  );
  lines.push("");
  lines.push(
    "**What to do:** the fix is almost never a bigger class. Either the " +
      "handler needs a bound it does not have (a `timeoutMs`, `ctx.signal` " +
      "threaded into its `fetch` / spawn / pool acquire), or it is waiting for " +
      "something and should be suspending instead — `ctx.waitFor` / `ctx.sleep` " +
      "RETURN from `run` and release the slot, and the resume gets a fresh " +
      "deadline.",
  );
  lines.push("");
  lines.push(`**Hold class:** \`${d.hold}\``);
  lines.push(`**Deadline:** ${formatDurationMs(d.deadlineMs)}`);
  lines.push(`**Held for:** ${formatDurationMs(d.elapsedMs)}`);
  lines.push(`**Runner:** \`${d.runnerId}\``);
  lines.push(`**Sample job:** \`${d.jobId}\` (attempt ${d.attempt})`);
  lines.push("");
  lines.push(
    "Inspect the live queue in **Debug → Queue** and the full history in " +
      "**Debug → Reports**.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}

/**
 * The `job-zombie` report kind: **this handler ignored its abort and is still
 * holding a worker slot.**
 *
 * Variant `error`, because this is the failure the deadline exists to catch and
 * cannot fix. The slot is gone for the life of this process, and the only thing
 * that returns it is the handler settling or the backend restarting.
 *
 * Deduped per `jobName`, same reasoning as the kind above.
 */
export const jobZombieKind = ReportKind({
  kind: "job-zombie",
  schema: JobDeadlinePayloadSchema,
  fingerprint: (d: JobDeadlinePayload) => `job-zombie:${d.jobName}`,
  duressExempt: true,
  meta: {
    tag: "[jobs]",
    notif: "Job ignored its deadline and is still holding a slot",
    variant: "error",
    category: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = JobDeadlinePayloadSchema.parse(row.data);
    return {
      title: `[jobs] ${d.jobName} is a zombie — slot held after its deadline`,
      description: renderZombie(row, d),
    };
  },
});

function renderZombie(row: ReportRow, d: JobDeadlinePayload): string {
  const lines: string[] = [];
  lines.push(
    `\`${d.jobName}\` was aborted at its ${formatDurationMs(d.deadlineMs)} ` +
      `\`${d.hold}\` deadline and **still had not settled** ` +
      `${formatDurationMs(d.elapsedMs - d.deadlineMs)} later. It is still ` +
      "running, and still holding a worker slot on the `" +
      d.runnerId +
      "` runner.",
  );
  lines.push("");
  lines.push(
    "**This slot does not come back.** A running promise cannot be un-awaited, " +
      "so the only lever the worker had was the abort, and this handler did not " +
      "take it — it is waiting on something that accepts no cancellation. The " +
      "slot is unavailable until the handler settles on its own or the backend " +
      "restarts.",
  );
  lines.push("");
  lines.push(
    "**The row is still safe.** Its advisory lock is held by this live " +
      "backend, so the stuck-lock sweeper provably will not reclaim it and " +
      "graphile cannot hand it to a second worker. Giving up on a handler never " +
      "moves its row — that distinction is what keeps this from being the " +
      "age-based lease this plugin bans.",
  );
  lines.push("");
  lines.push(
    "**What to do:** find what the handler is blocked on and give it a bound. " +
      "Every wait it can reach should take `ctx.signal` — `fetch`, " +
      "`spawnCaptured` / `spawnExpectOk`, and pool acquisition all accept one. " +
      "A wait that accepts no signal is the real defect; a bigger hold class " +
      "only makes the wedge take longer to notice.",
  );
  lines.push("");
  lines.push(`**Hold class:** \`${d.hold}\``);
  lines.push(`**Deadline:** ${formatDurationMs(d.deadlineMs)}`);
  lines.push(`**Still held at:** ${formatDurationMs(d.elapsedMs)}`);
  lines.push(`**Runner:** \`${d.runnerId}\``);
  lines.push(`**Sample job:** \`${d.jobId}\` (attempt ${d.attempt})`);
  lines.push("");
  lines.push(
    "**Debug → Queue** shows the row still locked and alive. If every slot on " +
      "a runner reaches this state, `queue-wedged` is the complementary signal " +
      "— that one says the queue as a whole stopped; this one names the handler " +
      "from the inside, at the moment we gave up on it.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
