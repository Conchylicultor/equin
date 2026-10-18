import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { QueueWedgedPayloadSchema, type QueueWedgedPayload } from "../../core";
import { formatDurationMs } from "../../shared/format-duration";

// Re-alert the bell at most once per 10 minutes while the queue stays wedged.
// A wedge is a persistent condition — the same slots stay held tick after tick
// — so the cooldown re-surfaces it periodically without spamming, same
// rationale as the other three queue kinds.
const WEDGED_NOTIF_COOLDOWN_MS = 600_000;

// The `queue-wedged` report kind: **the queue has stopped draining.**
//
// Why a fourth kind when the 2026-08-17 incident strictly satisfied both
// existing conditions: "the queue is deep" (`queue-backlog`) and "something is
// slow" (`queue-slot-hog`) are routinely true and benign — the nightly
// `backup.run` trips slot-hog every night, and a burst of enqueues trips
// backlog. Neither says the thing an operator has to act on. This kind fires
// only when every slot is held by the SAME live jobs across consecutive samples
// while ready work waits: nothing is completing, so nothing behind it will ever
// start. Different urgency (variant `error`, not `warning`), different renderer,
// different re-arm.
//
// It stays GLOBAL now that the worker drains a ladder of three runners rather
// than one pool: this kind means every slot on every runner is frozen, so
// nothing of ANY hold class can start. The weaker per-tier claim — one class
// stopped draining while the pool churns — is `queue-class-starved`, a separate
// kind with its own evidence. The payload carries the per-class occupancy so an
// operator can see which tier the frozen rows belong to without a second query.
//
// One rolling report per worktree (fixed fingerprint — the reports unique index
// is (fingerprint, worktree), so worktrees never collide).
//
// `duressExempt: true` — see the comment on the flag below.
export const wedgedKind = ReportKind({
  kind: "queue-wedged",
  schema: QueueWedgedPayloadSchema,
  fingerprint: () => "queue-wedged",
  // A wedged queue and a host duress episode are the SAME event far more often
  // than not — the box is in trouble, so the sentinel latches duress, and the
  // reports funnel starts shedding. Without this flag `recordReport` buffers
  // this report and hands back `{ reportId: null }`, so the alarm for the outage
  // is silenced by the outage. That is Silencer 2 of the 2026-08-17 incident,
  // and it is the same argument `duress-shed` and `duress-episode` already make:
  // this report IS the durable record of the condition, so shedding it loses the
  // only evidence there was one.
  duressExempt: true,
  meta: {
    tag: "[queue]",
    notif: "Job queue wedged",
    variant: "error",
    notifCooldownMs: WEDGED_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = QueueWedgedPayloadSchema.parse(row.data);
    return {
      title: "[queue] Job queue WEDGED",
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: QueueWedgedPayload): string {
  const lines: string[] = [];
  lines.push(
    "**The job queue has stopped draining.** All " +
      `${d.holders.length}/${d.concurrency} worker slots are held by the same ` +
      "jobs sample after sample — nothing is completing — while " +
      `${d.readyCount} ready jobs wait behind them. Every holder is still ` +
      "**alive** (its advisory lock is held by a live backend), so the " +
      "stuck-lock sweeper correctly will not reclaim any of them: these " +
      "handlers are not dead, they are never returning.",
  );
  lines.push("");
  lines.push(
    "Until a slot frees, nothing else in this worktree runs — including " +
      "auto-build on `refs/heads/main`, push ingestion, DB forks and " +
      "conversation spawns.",
  );
  lines.push("");
  lines.push(`**Slots held:** ${d.holders.length} / ${d.concurrency}`);
  lines.push(
    `**Held for (every slot, at least):** ${formatDurationMs(d.heldForMs)}`,
  );
  lines.push(`**Ready jobs waiting:** ${d.readyCount}`);
  if (d.classes && d.classes.length > 0) {
    lines.push("");
    lines.push("**Queue by hold class:**");
    for (const c of d.classes) {
      lines.push(
        `- \`${c.hold}\` — ${c.readyCount} ready, ${c.lockedCount} running, ` +
          `${c.reachableSlots} slots reachable`,
      );
    }
    lines.push("");
    lines.push(
      "*`running` counts locked ROWS of each class, not slots held by that " +
        "tier: the three runners share one graphile job table and no runner id " +
        "is recorded per row, so a locked row cannot be attributed to the " +
        "runner holding it.*",
    );
  }
  lines.push("");
  lines.push("**Slot holders:**");
  for (const h of d.holders) {
    lines.push(
      `- \`${h.jobName}\` (job ${h.jobId}) — held ${formatDurationMs(
        h.lockedForMs,
      )}`,
    );
  }
  if (d.topReady && d.topReady.length > 0) {
    lines.push("");
    lines.push("**Top jobs starved behind them:**");
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
