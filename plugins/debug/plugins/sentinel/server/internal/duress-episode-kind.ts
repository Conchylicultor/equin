import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  DuressEpisodeReportPayloadSchema,
  type DuressEpisodeReportPayload,
} from "../../core";

// Re-alert the bell at most once per ~30 min while duress episodes keep firing
// with the same cause-signature. A recurring congestion condition is a standing
// warning, not a one-shot crash, so the cooldown re-surfaces it periodically
// while episodes within a window only bump `count`.
const DURESS_EPISODE_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;

// The `duress-episode` report kind — the report/bell half of the duress signal
// (the trip instant already gets the cluster-onset critical trace + the timeline
// duress band). Filed once per episode, on clear.
//
// Fingerprint is the sorted CAUSE-SIGNATURE, not the episode: a 10-episode storm
// driven by the same signals collapses to ONE row with count=10, the trustworthy
// front-door shape (per-episode rows would be spam). The row's `worktree` column
// is always `main` (the sentinel is main-only), which is fine here — the cause
// signature, not the worktree, is the identity.
//
// duressExempt: true — This report IS the durable record of the condition that
// drives shedding; without exemption it can be lost to a re-trip racing the async
// record or to buffer overflow at peak — same bar as duress-shed's own summary
// kind.
export const duressEpisodeKind = ReportKind({
  kind: "duress-episode",
  schema: DuressEpisodeReportPayloadSchema,
  fingerprint: (d: DuressEpisodeReportPayload) =>
    `duress-episode:${[...d.elevated].sort().join(",")}`,
  duressExempt: true,
  meta: {
    tag: "[duress-episode]",
    notif: "Cluster duress episode",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: DURESS_EPISODE_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = DuressEpisodeReportPayloadSchema.parse(row.data);
    const cause = d.elevated.length > 0 ? d.elevated.join(", ") : "(adopted / unknown)";
    return {
      title: `[duress-episode] Cluster duress: ${cause} (${Math.round(d.durationMs / 1000)}s${d.forced ? ", forced" : ""})`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: DuressEpisodeReportPayload): string {
  const lines: string[] = [];
  lines.push(
    `The cluster sentinel latched a duress episode: signals ` +
      `**${d.elevated.length > 0 ? d.elevated.join(", ") : "(adopted / unknown)"}** ` +
      `elevated, held for **${Math.round(d.durationMs / 1000)}s** ` +
      `(${new Date(d.episodeSetAt).toISOString()} → ${new Date(d.endedAt).toISOString()}).`,
  );
  lines.push("");
  if (d.forced) {
    lines.push(
      `**⚠ FORCED CLEAR (max-episode-hold).** This episode did NOT resolve on its ` +
        `own — the sentinel force-cleared the latch after the max-episode-hold ` +
        `safety bound and re-evaluated from scratch. That means either the ` +
        `elevation was still real when the bound hit (the condition outlasted the ` +
        `hold — look for a sustained root cause) or a threshold is mis-calibrated. ` +
        `A forced clear re-grants shed first-N on the re-trip.`,
    );
    lines.push("");
  }
  lines.push(
    `During a duress episode the shedding gates are active, so slow-op and report ` +
      `signals inside this window are deliberately sparse — the timeline duress ` +
      `band marks it as "thinned". Correlate with the \`cluster-onset\` trace and ` +
      `the host-pressure heat on the Timeline (Debug → Slow Events → Timeline) for ` +
      `the cause.`,
  );
  lines.push("");
  lines.push(`**Cause signals:** ${d.elevated.length > 0 ? d.elevated.join(", ") : "(none recorded — adopted episode)"}`);
  lines.push(`**Reason:** ${d.reason}`);
  lines.push(`**Started:** ${new Date(d.episodeSetAt).toISOString()}`);
  lines.push(`**Ended:** ${new Date(d.endedAt).toISOString()}`);
  lines.push(`**Duration:** ${d.durationMs}ms`);
  lines.push(`**Forced:** ${d.forced ? "yes (max-episode-hold)" : "no (resolved naturally)"}`);
  lines.push("");
  lines.push(`**Occurrences (episodes, this cause-signature):** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
