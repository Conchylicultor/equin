import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import type { StormSummary } from "@plugins/reports/plugins/engine/server";
import { ReportStormPayloadSchema, type ReportStormPayload } from "../../core";

// Compile-time drift guard: the reports engine files `data: { ...summary }`
// verbatim, so every StormSummary it emits must parse as a ReportStormPayload.
// If the fan-out engine ever widens its summary shape, this line fails to
// compile here — at the kind that owns the schema — instead of failing
// schema.parse when the next storm is filed.
type AssertTrue<T extends true> = T;
export type _StormSummaryMatchesPayload = AssertTrue<
  StormSummary extends ReportStormPayload ? true : false
>;

// The `report-storm` kind: what a burst of alerts becomes once the reports
// engine's fan-out ceiling collapses it. The fingerprint keys on (collapsed
// kind, window start), so each window of a long incident gets its own row
// naming its own roster, and two kinds storming at once never dedupe onto each
// other.
//
// Variant `warning`: a storm means the alerts you would have received were
// folded, which a human should see — and the fact that identifies the bug (N
// unrelated operations went slow at once) exists only in this row. No
// notification cooldown: each window is already its own row, so re-arming
// would only duplicate it.
//
// `fanOutExempt` is the load-bearing flag: this report IS the fan-out
// mechanism's accounting. Without the exemption a long enough incident — one
// storm rollup per window, past the ceiling — would collapse the rollups
// themselves, and the record of what was collapsed would be the thing
// collapsed. Same reason `duress-shed` declares `duressExempt`.
export const reportStormKind = ReportKind({
  kind: "report-storm",
  schema: ReportStormPayloadSchema,
  fingerprint: (d: ReportStormPayload) =>
    `report-storm:${d.collapsedKind}:${d.windowStartedAt}`,
  fanOutExempt: true,
  meta: {
    tag: "[storm]",
    notif: "Alert storm collapsed",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = ReportStormPayloadSchema.parse(row.data);
    const seconds = burstSeconds(d);
    return {
      title:
        `[storm] ${d.collapsedKind}: ${d.distinctFingerprints} fingerprints ` +
        `raised ${d.occurrences} alerts in ${seconds}s (budget ${d.budget}/window)`,
      description: renderDescription(row, d),
    };
  },
});

function burstSeconds(d: ReportStormPayload): number {
  return Math.max(1, Math.round((d.windowEndedAt - d.windowStartedAt) / 1000));
}

function renderDescription(row: ReportRow, d: ReportStormPayload): string {
  const lines: string[] = [];
  lines.push(
    `**${d.distinctFingerprints} distinct \`${d.collapsedKind}\` fingerprints** ` +
      `raised **${d.occurrences} alerts** within ${burstSeconds(d)}s — past the ` +
      `${d.budget}-per-window ceiling on how many distinct fingerprints of one ` +
      `kind may each raise their own alert. The ones past the budget were ` +
      `collapsed into this single row instead of minting one row (and one bell ` +
      `notification) each.`,
  );
  lines.push("");
  lines.push(
    `**The burst itself is the finding.** Each collapsed alert individually ` +
      `points at its own operation, which is usually not the culprit; what ` +
      `identifies the problem is that this many *unrelated* operations degraded ` +
      `at the same instant. Look for a shared cause — a stalled event loop, a ` +
      `dropped socket that made every subscriber re-settle at once, host duress ` +
      `— rather than at any single fingerprint below.`,
  );
  lines.push("");
  lines.push(
    `**Nothing was lost.** Only the *alert* was collapsed. Per-occurrence ` +
      `detail is untouched in the kind's own surface (for \`slow-op\`, ` +
      `Debug → Slow Ops keeps every occurrence with counts, max duration, ` +
      `caller attribution and contention snapshots), and the budget refills ` +
      `every window — anything still happening a window later mints its own row.`,
  );
  lines.push("");
  lines.push(`**Collapsed fingerprints (occurrences each):**`);
  for (const e of d.roster) {
    lines.push(`- \`${e.fingerprint}\` ×${e.count} — ${e.message}`);
  }
  if (d.rosterTruncated > 0) {
    lines.push(
      `- …and ${d.rosterTruncated} further distinct fingerprints the roster ` +
        `had no room to name (raise \`reports.stormRosterMax\` to widen it).`,
    );
  }
  lines.push("");
  lines.push(
    `**Window:** ${new Date(d.windowStartedAt).toISOString()} → ${new Date(d.windowEndedAt).toISOString()}`,
  );
  lines.push(`**Budget:** ${d.budget} distinct fingerprints per window`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
