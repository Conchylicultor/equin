import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { HOLD_SPECS } from "@plugins/infra/plugins/jobs/server";
import {
  QueueClassStarvedPayloadSchema,
  type QueueClassStarvedPayload,
} from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// Re-alert the bell at most once per 10 minutes while a class stays starved. A
// starved class is a persistent condition (the head stays frozen tick after
// tick), so the cooldown re-surfaces it periodically without spamming — same
// rationale as the other queue kinds.
const CLASS_STARVED_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-class-starved` report kind: **one tier of the runner ladder has
// stopped draining**, while the pool as a whole may look perfectly healthy.
//
// Why a fifth kind when four already exist. `queue-wedged` is the whole pool
// stopping — every slot on every runner frozen — and stays exactly right for
// that. But the ladder made a strictly weaker failure possible and invisible: a
// class whose reachable slots are all busy while the rest of the pool churns.
// The queue looks alive from every global metric (`lockedCount` moves,
// `readyCount` is unremarkable, ids churn), and one whole category of work has
// not moved in half an hour. That is the shape of the 40-minute
// `tasks.push-ingest` lag this design set out to fix.
//
// It is also the signal that VERIFIES the reservation in production rather than
// asserting it: if reserving two slots for `instant` work works, this kind never
// fires for `instant`. When it does, the ladder is not doing its job, and the
// report says which tier and who was waiting in it.
//
// One rolling report per (class, worktree) — fingerprint `queue-class-starved:<hold>`,
// and the reports unique index is (fingerprint, worktree), so neither classes
// nor worktrees collide.
//
// `duressExempt: true` — see the comment on the flag below.
export const classStarvedKind = ReportKind({
  kind: "queue-class-starved",
  schema: QueueClassStarvedPayloadSchema,
  fingerprint: (d: QueueClassStarvedPayload) => `queue-class-starved:${d.hold}`,
  // A starved class and a host duress episode are overwhelmingly the same
  // event — the box is in trouble, the sentinel latches duress, and the reports
  // funnel starts shedding. Without this flag `recordReport` buffers this report
  // and hands back `{ reportId: null }`, so the alarm for the outage is silenced
  // by the outage. That is Silencer 2 of the 2026-08-17 incident, and the same
  // argument the other four queue kinds already make: this report IS the durable
  // record of the condition, so shedding it loses the only evidence there was one.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Job queue class starved",
    variant: "error",
    notifCooldownMs: CLASS_STARVED_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueClassStarvedPayloadSchema.parse(row.data);
    return {
      title: `[queue] Class starved: ${d.hold}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(
  row: ReportRow,
  d: QueueClassStarvedPayload,
): string {
  const spec = HOLD_SPECS[d.hold];
  const lines: string[] = [];
  lines.push(
    `**Nothing in the \`${d.hold}\` hold class has drained for ` +
      `${formatDurationMs(d.starvedForMs)}.** Its ready queue has ` +
      `${d.readyCount} job(s) waiting and the oldest of them has been ready ` +
      `for ${formatDurationMs(d.oldestOverdueMs)} — and it is the SAME row ` +
      "sample after sample, so nothing is being taken off the front of this " +
      "class. The queue as a whole may look healthy; this tier is not.",
  );
  lines.push("");
  lines.push(
    `A \`${d.hold}\` row can be picked up by **${d.reachableSlots} of the ` +
      "worker slots** (the runners whose task list serves this class). Every " +
      `one of them has been busy with something else for longer than this ` +
      `class's starvation window of ${formatDurationMs(d.windowMs)} — the ` +
      `longer of the wedge threshold and this class's own ${formatDurationMs(
        spec.ceilingMs,
      )} work ceiling, so a class is never called starved before one fully ` +
      "conforming run of it could have finished.",
  );
  lines.push("");
  lines.push(`**Class:** \`${d.hold}\` (${spec.label})`);
  lines.push(`**Reachable slots:** ${d.reachableSlots}`);
  lines.push(`**Ready (this class):** ${d.readyCount}`);
  lines.push(`**Running rows (this class):** ${d.lockedCount}`);
  lines.push(`**Oldest ready:** ${formatDurationMs(d.oldestOverdueMs)}`);
  lines.push(`**Not draining for:** ${formatDurationMs(d.starvedForMs)}`);

  if (d.classes && d.classes.length > 0) {
    lines.push("");
    lines.push("**Queue by class:**");
    for (const c of d.classes) {
      lines.push(
        `- \`${c.hold}\` — ${c.readyCount} ready, ${c.lockedCount} running, ` +
          `${c.reachableSlots} slots reachable`,
      );
    }
    lines.push("");
    lines.push(
      "*`running` counts locked ROWS of each class, not slots held by that " +
        "tier: the runners share one job table and graphile records no runner " +
        "id per row, so a locked row cannot be attributed to the runner " +
        "holding it.*",
    );
  }

  if (d.topReady && d.topReady.length > 0) {
    lines.push("");
    lines.push("**Jobs starved in this class:**");
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
