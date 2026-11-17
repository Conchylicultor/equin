import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  SLOTS_EXHAUSTED_REPORT_KIND,
  SlotsExhaustedPayloadSchema,
  type SlotsExhaustedPayload,
} from "../../core";

// `main-slots-exhausted`, filed by a main build through the report outbox
// (`acquireBuildSlot`'s `onExhausted`, cli/) when it found no free slot and
// the draining ones at the leak limit. One row: it is one condition of the
// machine; the latest data names the holders.
export const slotsExhaustedKind = ReportKind({
  kind: SLOTS_EXHAUSTED_REPORT_KIND,
  schema: SlotsExhaustedPayloadSchema,
  fingerprint: () => SLOTS_EXHAUSTED_REPORT_KIND,
  meta: {
    tag: "[main-slots]",
    notif: "Main's old slots are not draining",
    variant: "warning",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d: SlotsExhaustedPayload = SlotsExhaustedPayloadSchema.parse(
      row.data,
    );
    const lines = d.slots.flatMap(({ slot, unservedAt, holders }) => [
      `- \`${slot}\`${unservedAt === null ? "" : ` — serves no app since ${unservedAt}`}${slot === d.waitedOn ? " (the build waited on this one)" : ""}`,
      ...(holders.length === 0
        ? ["  - no live holder recorded"]
        : holders.map(
            (h) =>
              `  - pid ${h.pid} — ${h.kind}${h.label === null ? "" : ` \`${h.label}\``} (${h.mode}) since ${h.acquiredAt}`,
          )),
    ]);
    return {
      title:
        "[main-slots] old slots are not draining — a main build waited for one",
      description: [
        `A main build needed a slot (\`infra/git/main-slots\`), found none free and ${d.slots.length} draining — the leak limit (${d.limit}) — so it waited for the oldest draining one instead of making another.${d.waitingMs > 0 ? ` When this was filed it had been waiting ${Math.round(d.waitingMs / 60_000)} min — main's deploy is stalled until a slot drains.` : ""}`,
        "",
        "A slot drains once its last app switched to a newer slot: the processes it left there finish. Slots piling up mean processes outlive their apps by several deploys — look for the long-lived holders below (a supervised child that never ended, a stale backend).",
        "",
        ...lines,
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
