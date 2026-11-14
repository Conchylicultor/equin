import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  JOB_SLOT_FLOOR_KIND,
  type JobSlotFloorReport,
} from "@plugins/infra/plugins/jobs/server";
import {
  JobSlotFloorPayloadSchema,
  type JobSlotFloorPayload,
} from "../../core";
import { formatDurationMs } from "./format-duration";

// tsc-level proof that this kind validates exactly what the parent writes.
//
// Unlike the two run-level kinds, nothing maps field-by-field from a parent
// event into this payload — the parent writes the object straight to disk on
// its way out of the process, and the flush hands it back as opaque jsonb. So
// there is no call site where a drifting field would be a type error, and this
// assignment is that call site. If `JobSlotFloorReport` gains, loses or renames
// a field, this line stops compiling instead of the next floor crash filing a
// report whose payload its own schema rejects — on a backend that has already
// exited, where the failure is one line in a boot log.
const _payloadMatchesWhatTheParentWrites: (
  written: JobSlotFloorReport,
) => JobSlotFloorPayload = (written) => written;
void _payloadMatchesWhatTheParentWrites;

// Re-alert the bell at most once per 10 minutes, same as the two run-level
// kinds. On the crashed arm the practical re-arm is the crash itself; on the
// degraded arms the condition persists, so the cooldown re-surfaces it.
const NOTIF_COOLDOWN_MS = 600_000;

/**
 * The `job-slot-floor` report kind: **a runner has lost slots it cannot get
 * back, and one of them mattered enough to act on.**
 *
 * One rolling report per worktree (fixed fingerprint — the reports unique index
 * is `(fingerprint, worktree)`, so worktrees never collide). Deliberately NOT
 * per runner: the thing being reported is the state of this worktree's worker
 * pool, and the upsert refreshes `data` on the newest occurrence, so the row
 * always shows the latest and worst thing that happened to it.
 *
 * `duressExempt: true`, for the third time in this plugin and for the same
 * reason: a pool losing its slots and a host duress episode are usually the
 * same event, and shedding this report would lose the only evidence of a
 * backend that exited on purpose.
 *
 * The `kind` string comes from the parent (`JOB_SLOT_FLOOR_KIND`) rather than
 * being typed here. The parent is what writes the durable line, synchronously,
 * during a deliberate exit; a second spelling that drifted would leave that
 * line unresolvable on the next boot.
 */
export const slotFloorKind = ReportKind({
  kind: JOB_SLOT_FLOOR_KIND,
  schema: JobSlotFloorPayloadSchema,
  fingerprint: () => JOB_SLOT_FLOOR_KIND,
  duressExempt: true,
  meta: {
    tag: "[jobs]",
    notif: "Worker pool lost slots it cannot recover",
    variant: "error",
    category: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = JobSlotFloorPayloadSchema.parse(row.data);
    return {
      title:
        d.action === "crashed"
          ? `[jobs] backend exited — the ${d.runnerId} runner ran out of usable slots`
          : `[jobs] the ${d.runnerId} runner lost its slots`,
      description: renderFloor(row, d),
    };
  },
});

function renderFloor(row: ReportRow, d: JobSlotFloorPayload): string {
  const lines: string[] = [];
  const lost = d.concurrency - d.usable;
  const served = d.serves.map((h) => `\`${h}\``).join(", ");

  lines.push(
    `The \`${d.runnerId}\` runner has **${d.usable} of its ${d.concurrency} worker slots** left. ` +
      `The other ${lost} are held by handlers that passed their deadline, were told to stop, ` +
      `and did not — so the worker wrote those slots off. Nothing was taken from them: ` +
      `their job rows are untouched and their advisory locks are still held, which is exactly ` +
      `what stops the stuck-lock sweeper reclaiming a row whose handler is still running.`,
  );
  lines.push("");

  if (d.action === "crashed") {
    lines.push(
      `**The backend exited on purpose.** This runner is the only one that serves ${served} work, ` +
        `so with fewer than ${d.minUsableSlots} usable slots it could no longer do the job nothing ` +
        `else can — DB forks, conversation spawns, builds and backups had nowhere to go. ` +
        `A shorter class inherits a longer one's idle slots, never the reverse.`,
    );
    lines.push("");
    lines.push(
      "**What recovers it:** the exit itself. Postgres drops every advisory lock during " +
        "backend teardown, so the next boot's stuck-lock sweeper reclaims those rows — this " +
        "time provably, because their owner no longer exists — and the work re-runs. " +
        "Note the restart is **lazy**: the gateway does not respawn an exited backend, it " +
        "marks the worktree idle and the next request through it starts a fresh one. A " +
        "worktree nobody is looking at stays down until someone looks.",
    );
  } else if (d.restartSuppressed) {
    lines.push(
      `**This was fatal, and the backend stayed up anyway.** The runner is below its floor of ` +
        `${d.minUsableSlots} usable slots, which normally ends the process — but this worktree ` +
        `has already tripped the floor ${d.tripsThisWindow} times within ` +
        `${formatDurationMs(d.windowMs)}, past the ${d.maxTripsPerWindow} the anti-loop latch ` +
        `allows. An automatic restart that fixes nothing is worse than an honest wedge, so the ` +
        `exit was suppressed.`,
    );
    lines.push("");
    lines.push(
      `**Nothing will fix this on its own.** ${served} work has nowhere to run in this ` +
        "worktree until someone restarts the backend by hand and, more importantly, until the " +
        "handlers below are given a bound they respect. Restarting alone will most likely " +
        "reproduce this within the hour — that is what the latch is telling you.",
    );
  } else {
    lines.push(
      `**The pool is degraded, not dead.** Every slot on this runner is written off, but the ` +
        `task lists are nested — ${served} work still reaches the wider runners, which is why ` +
        `this is a report and not an exit. What is lost is the reserved capacity that made ` +
        `those classes independent of the long ones, so short work now queues behind whatever ` +
        `the wider runners are doing.`,
    );
  }

  lines.push("");
  lines.push("**Holding the slots:**");
  if (d.holders.length === 0) {
    lines.push(
      "- (none recorded — the slots were released between the trip and the write)",
    );
  } else {
    for (const h of d.holders) {
      lines.push(
        `- \`${h.jobName}\` (\`${h.hold}\`, job \`${h.jobId}\`) — still running after ` +
          `${formatDurationMs(h.heldMs)} past the moment it was written off`,
      );
    }
  }
  lines.push("");
  lines.push(
    "**What to do:** each of those handlers has a `job-zombie` report of its own naming it " +
      "from the inside. The fix is there, not here — a wait that accepts no cancellation is " +
      "the real defect, and every wait a handler can reach should take `ctx.signal`. Nothing " +
      "about this runner's size is the problem; more slots would only take longer to exhaust.",
  );
  lines.push("");
  lines.push(`**Runner:** \`${d.runnerId}\` (serves ${served})`);
  lines.push(`**Usable slots:** ${d.usable} of ${d.concurrency}`);
  lines.push(`**Floor:** ${d.minUsableSlots}`);
  lines.push(
    `**Floor trips in the last ${formatDurationMs(d.windowMs)}:** ${d.tripsThisWindow} ` +
      `(exit suppressed past ${d.maxTripsPerWindow})`,
  );
  lines.push("");
  lines.push(
    "**Debug → Queue** shows the written-off runs as `forfeited` — still locked, still alive, " +
      "and no longer counted. `queue-wedged` is the complementary signal: that one says the " +
      "queue as a whole stopped draining; this one says how much of the pool is never coming " +
      "back without a restart.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
