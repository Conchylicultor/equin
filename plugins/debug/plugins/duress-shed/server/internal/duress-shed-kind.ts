import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import type { ShedSummary } from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import { DuressShedPayloadSchema, type DuressShedPayload } from "../../core";

// Compile-time drift guard: consumers file `data: { ...summary }` verbatim, so
// every ShedSummary the shed engine emits must parse as a DuressShedPayload.
// If duress ever widens its summary shape, this line fails to compile here —
// at the kind that owns the schema — instead of failing schema.parse at flush.
type AssertTrue<T extends true> = T;
export type _ShedSummaryMatchesPayload = AssertTrue<
  ShedSummary extends DuressShedPayload ? true : false
>;

// The `duress-shed` report kind: the post-episode accounting summary each shed
// buffer files after its flush. Fingerprint keys on (buffer kind, episode
// setAt) so the traces / slow-ops / reports buffers — and successive episodes
// of the same buffer — each get their own row instead of deduping onto one.
// Variant `warning`: shedding is the system working as designed under duress,
// but a human should see WHAT was thinned and whether anything was dropped.
//
// `duressExempt` is the load-bearing flag: this summary is filed at the tail
// of a flush, and if duress re-trips mid-flush the gate in recordReport would
// otherwise shed (and possibly drop, on buffer overflow) the only record of
// what was shed. The kind that carries the accounting must never be gated by
// the mechanism it accounts for.
export const duressShedKind = ReportKind({
  kind: "duress-shed",
  schema: DuressShedPayloadSchema,
  fingerprint: (d: DuressShedPayload) =>
    `duress-shed:${d.kind}:${d.episodeSetAt ?? "unknown"}`,
  duressExempt: true,
  meta: {
    tag: "[duress-shed]",
    notif: "Observability writes shed under duress",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = DuressShedPayloadSchema.parse(row.data);
    const shed = totalOf(d, "shed");
    const dropped = totalOf(d, "dropped");
    return {
      title: `[duress-shed] ${d.kind}: ${shed} shed / ${dropped} dropped during duress episode`,
      description: renderDescription(row, d),
    };
  },
});

function totalOf(d: DuressShedPayload, field: "shed" | "dropped"): number {
  return Object.values(d.byCascade).reduce((a, c) => a + c[field], 0);
}

function renderDescription(row: ReportRow, d: DuressShedPayload): string {
  const episode =
    d.episodeSetAt !== null
      ? new Date(d.episodeSetAt).toISOString()
      : "unknown";
  const lines: string[] = [];
  lines.push(
    `During a host duress episode (set at ${episode}), the **${d.kind}** ` +
      `observability buffer shed durable writes past its first-N-per-cascade ` +
      `grant. The first N occurrences per cascade key persisted normally (the ` +
      `onset evidence); this report accounts for the tail.`,
  );
  lines.push("");
  lines.push(
    `**Shed** items were buffered in memory and replayed through the normal ` +
      `durable path after the episode cleared — deferred, not lost. **Dropped** ` +
      `items overflowed the bounded buffer: the item is gone, only the count ` +
      `survives. For the \`traces\` buffer, replay is a documented accounting ` +
      `no-op — a trace's value is its coherent instant, which cannot be ` +
      `reconstructed, so its "replayed" number only closes the books (no traces ` +
      `were fabricated).`,
  );
  lines.push("");
  lines.push(`**Per cascade key (shed / dropped):**`);
  for (const [key, stats] of Object.entries(d.byCascade)) {
    lines.push(`- \`${key}\` — ${stats.shed} shed / ${stats.dropped} dropped`);
  }
  lines.push("");
  lines.push(`**Replayed:** ${d.replayed}`);
  lines.push(`**Replay errors:** ${d.replayErrors}`);
  lines.push(`**Episode set at:** ${episode}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
