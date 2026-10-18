import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { logsDirFor } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { BootWedgePayloadSchema, type BootWedgePayload } from "../../core";

// Re-alert the bell at most once per ~15 min while a boot stays wedged. A boot
// that never comes up is an active outage, not a one-shot condition, so the
// cooldown re-surfaces it periodically (each open tick bumps `count`; the
// cooldown decides when the bell re-arms) without spamming a fresh row per
// minute. Tighter than boot-budget's 6h re-arm because a wedged boot is a live
// outage a human should look at now, not a chronic cost regression.
const BOOT_WEDGE_NOTIF_COOLDOWN_MS = 15 * 60 * 1000;

// The `boot-wedge` report kind. Dedups per WORKTREE (fingerprint
// `boot-wedge:<worktree>`), NOT per boot attempt: the row's own `worktree`
// column is always `main` (the monitor job runs there), so the subject must
// live in the fingerprint, and a crash-loop that never comes up collapses to a
// single row whose `count` is the number of times the watchdog saw it un-ready.
// Variant `error`: a backend that never became ready is a hard failure — it
// serves nothing — unlike a merely-slow boot (boot-budget's `warning`).
export const bootWedgeKind = ReportKind({
  kind: "boot-wedge",
  schema: BootWedgePayloadSchema,
  fingerprint: (d: BootWedgePayload) => `boot-wedge:${d.worktree}`,
  meta: {
    tag: "[boot-wedge]",
    notif: "Backend never became ready",
    variant: "error",
    notifCooldownMs: BOOT_WEDGE_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = BootWedgePayloadSchema.parse(row.data);
    return {
      title: `[boot-wedge] ${d.worktree} never became ready (${Math.round(d.wedgedMs / 1000)}s)`,
      description: renderDescription(row, d),
    };
  },
});

function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function renderDescription(row: ReportRow, d: BootWedgePayload): string {
  const lines: string[] = [];
  const stateWord =
    d.state === "open"
      ? "is wedged RIGHT NOW (still the latest attempt, and the gateway fleet still lists it as live)"
      : "never became ready before a later attempt superseded it";
  lines.push(
    `The backend for worktree \`${d.worktree}\` ${stateWord}: its process ` +
      `started ${new Date(d.processStartedAt).toISOString()} but never wrote a ` +
      `boot \`ready\` line within its **${d.budgetMs}ms** budget — it has been ` +
      `un-ready for **${humanMs(d.wedgedMs)}**.`,
  );
  lines.push("");
  lines.push(
    `A never-ready boot serves nothing: no requests, no live-state, no jobs. It ` +
      `renders on the Timeline (Debug → Slow Events → Timeline) as an ` +
      `open-ended boot bar, but before this watchdog it reached no report and no ` +
      `bell — exactly the 11.5-minute never-ready boot of main that sat unseen ` +
      `during the 2026-07-17 incident (see ` +
      `research/2026-07-17-global-debug-surface-consolidation.md).`,
  );
  lines.push("");
  lines.push(
    `**What to do:** open the worktree's boot/health logs ` +
      `(\`${logsDirFor(d.worktree)}\`) and the Timeline around ` +
      `this window. A boot that wedges past its budget is almost always stuck in ` +
      `migrations, an \`onReadyBlocking\` hook, or host duress (a concurrent ` +
      `duress episode starves the boot) — the boot-budget reports and the ` +
      `duress-episode band on the same window are the next place to look.`,
  );
  lines.push("");
  lines.push(`**Worktree:** \`${d.worktree}\``);
  lines.push(`**Process started:** ${new Date(d.processStartedAt).toISOString()}`);
  lines.push(`**Un-ready for:** ${d.wedgedMs}ms`);
  lines.push(`**Budget:** ${d.budgetMs}ms`);
  lines.push(`**State:** ${d.state}`);
  if (d.state === "superseded" && d.supersededAtMs !== undefined) {
    lines.push(
      `**Superseded at:** ${new Date(d.supersededAtMs).toISOString()} (outage bounded)`,
    );
  }
  if (d.fleetState !== undefined) lines.push(`**Gateway fleet state:** ${d.fleetState}`);
  lines.push("");
  lines.push(`**Occurrences (watchdog sightings):** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
