import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  QueueSlotBlockedPayloadSchema,
  type QueueSlotBlockedPayload,
} from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// Re-alert the bell at most once per 10 minutes while a job keeps holding slots
// to wait. Same rationale as the other queue kinds: a persistent condition
// re-surfaced periodically rather than every sample.
const SLOT_BLOCKED_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-slot-blocked` report kind: **this job holds a worker slot to WAIT,
// not to work.**
//
// Why this is not `queue-slot-hog` with better wording. Slot-hog says a job is
// slow, and the fix for a slow job is to reclassify it or make it faster. This
// says something else entirely: the handler is not slow at all — it did a
// quarter-second of work — it is sitting on a worker slot inside an ADMISSION
// GATE it entered AFTER graphile had already handed it that slot. Measured on
// this system: `jobs.dead-gc` held a slot for 77 seconds to do 254 ms of work,
// all of it blocked on `background-tx-acquire`. Reported as "slow" that is a
// mystery; reported as "blocked on `background-tx-acquire`" it names the defect,
// and the fix is to stop entering that gate while holding a worker slot. This is
// exactly the pathology `serial` exists to eliminate, occurring system-wide
// through the DB lane gates, and it was invisible until this kind existed.
//
// It is also why hold-class conformance is measured on WORK rather than on
// hold: without this split, a correctly-classified job would be blamed every
// time an unrelated gate was busy.
//
// One report per distinct `jobName` (fingerprint `queue-slot-blocked:<jobName>`),
// with the payload refreshed each occurrence so the named gate is the current
// one rather than whichever was first seen.
//
// `duressExempt: true` — see the comment on the flag below.
export const slotBlockedKind = ReportKind({
  kind: "queue-slot-blocked",
  schema: QueueSlotBlockedPayloadSchema,
  fingerprint: (d: QueueSlotBlockedPayload) =>
    `queue-slot-blocked:${d.jobName}`,
  // A saturated admission gate and a host duress episode are overwhelmingly the
  // same event — gates saturate precisely when the box is in trouble, which is
  // when the sentinel latches duress and `recordReport` starts shedding. Without
  // this flag the report describing the contention would be buffered exactly
  // during the contention. Same argument the other four queue kinds make: this
  // report IS the durable record of the condition.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Job blocking on a gate while holding a slot",
    variant: "warning",
    notifCooldownMs: SLOT_BLOCKED_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueSlotBlockedPayloadSchema.parse(row.data);
    return {
      title: `[queue] Slot blocked: ${d.jobName} on ${d.layer}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: QueueSlotBlockedPayload): string {
  const lines: string[] = [];
  lines.push(
    `\`${d.jobName}\` held a worker slot ${formatDurationMs(d.holdMs)} to do ` +
      `${formatDurationMs(d.workMs)} of work, blocked on \`${d.layer}\`. The ` +
      "handler is not slow — it is sitting on a slot inside an admission gate " +
      "it entered AFTER graphile had already handed it that slot. While it " +
      "waits there, the slot is unavailable to every other job.",
  );
  lines.push("");
  lines.push(
    "This is the pathology `serial` exists to eliminate: a gate entered after " +
      "dispatch turns one blocked job into a held slot. The fix is to stop " +
      "entering the gate while holding a worker slot (or to move the gated work " +
      "out of the handler), **not** to give the job a longer hold class — its " +
      "declared class is about work time, and its work time is fine.",
  );
  lines.push("");
  lines.push(`**Job:** \`${d.jobName}\``);
  lines.push(`**Blocked on:** \`${d.layer}\` (${formatDurationMs(d.layerMs)})`);
  lines.push(`**Slot held:** ${formatDurationMs(d.holdMs)}`);
  lines.push(`**Of which waiting:** ${formatDurationMs(d.waitMs)}`);
  lines.push(`**Actual work:** ${formatDurationMs(d.workMs)}`);
  lines.push(
    `**Measured over:** ${d.runs} run(s) in ${formatDurationMs(d.windowMs)} ` +
      "(every duration above is a per-run average)",
  );

  if (d.layers.length > 1) {
    lines.push("");
    lines.push("**Wait by gate (per run):**");
    for (const l of d.layers) {
      lines.push(`- \`${l.layer}\` — ${formatDurationMs(l.ms)}`);
    }
  }

  lines.push("");
  lines.push(
    "Measured from the runtime profiler's `job` spans, which carry the " +
      "wait/work split the graphile row cannot: `locked_at` knows how long the " +
      "slot was held, never what the handler was doing inside that hold. " +
      "Cross-check per-gate contention in **Debug → Profiling** and the live " +
      "queue in **Debug → Queue**.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
