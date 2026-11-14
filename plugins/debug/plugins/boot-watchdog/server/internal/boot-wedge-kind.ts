import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { logsDirFor } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  BootWedgePayloadSchema,
  describeBootPhases,
  describeBootWedge,
  humanMs,
  type BootWedgePayload,
} from "../../core";

// Re-alert the bell at most once per ~15 min while a worktree keeps failing to
// boot. Each failed boot attempt is reported once (and a boot the gateway still
// waits on, each minute past its budget), bumping `count`; the cooldown decides
// when the bell re-arms, so a crash-loop someone keeps retrying re-surfaces
// without a bell per attempt, and an abandoned worktree rings once. Tighter than boot-budget's 6h re-arm because a wedged boot is a live
// outage a human should look at now, not a chronic cost regression.
const BOOT_WEDGE_NOTIF_COOLDOWN_MS = 15 * 60 * 1000;

// The `boot-wedge` report kind. Dedups per WORKTREE (fingerprint
// `boot-wedge:<worktree>`), NOT per boot attempt: the row's own `worktree`
// column is always `main` (the monitor job runs there), so the subject must
// live in the fingerprint, and a crash-loop that never comes up collapses to a
// single row whose `count` is the number of failed attempts (plus booting minutes).
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
    category: "error",
    notifCooldownMs: BOOT_WEDGE_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = BootWedgePayloadSchema.parse(row.data);
    return {
      title: `[boot-wedge] ${describeBootWedge(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: BootWedgePayload): string {
  const lines: string[] = [];
  lines.push(`**${describeBootWedge(d)}**`);
  lines.push("");
  const stateWord = {
    booting:
      "is still booting past its budget — the gateway is still waiting on it (fleet state `starting`)",
    failed:
      "was killed before it became ready, and the gateway gave up on it (fleet state `broken`: killed at its readiness deadline, a SIGKILL, so it wrote no exit line). No backend runs, nothing has become ready since, and the gateway retries it only on a deploy (`./equin build`) or a browser start — the worktree is unusable until then",
    killed:
      "was killed before it became ready; the gateway now runs nothing for the worktree and no longer holds the failure (it restarted, or swept the worktree idle), so the next request boots it again",
    "restart-failed":
      "was a hot restart's new process, killed before it became ready, while the previous backend kept serving — a failed deploy, not an outage",
    superseded: "never became ready before a later attempt superseded it",
    open: "was the latest attempt while the gateway still listed the worktree (legacy report — it may already have been dead)",
  }[d.state];
  lines.push(
    `The backend for worktree \`${d.worktree}\` ${stateWord}. Its process ` +
      `started ${new Date(d.processStartedAt).toISOString()} and never wrote a ` +
      `boot \`ready\` line within its **${d.budgetMs}ms** budget; the worktree ` +
      `has had no ready backend from it for **${humanMs(d.wedgedMs)}**.`,
  );
  const phases = describeBootPhases(d.journal);
  if (phases !== null) {
    lines.push("");
    lines.push(
      `**Where its time went** (its boot journal, ms since process start): ${phases}.`,
    );
  }
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
    `**What to do:** the step above is where it was when it stopped. Its ` +
      `\`boot-journal\` channel (\`${logsDirFor(d.worktree)}\`) has every ` +
      `step, and the gateway's \`gateway.log\` the kill (\`backend abandoned\`) ` +
      `and who asked for each start (\`backend start requested … cause=\`). A ` +
      `boot that ran darwinbg throughout was never moved by the gateway's ` +
      `escalation (a gateway older than its boot-tier probe); long imports ` +
      `with no darwinbg point at host load — the duress band on the Timeline ` +
      `around this window says.`,
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
  if (d.fleetState !== undefined)
    lines.push(`**Gateway fleet state:** ${d.fleetState}`);
  if (d.gatewayError !== undefined)
    lines.push(`**Gateway's last start error:** ${d.gatewayError}`);
  lines.push("");
  lines.push(`**Occurrences (watchdog sightings):** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
