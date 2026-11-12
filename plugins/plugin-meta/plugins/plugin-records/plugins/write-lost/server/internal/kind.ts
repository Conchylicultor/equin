import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  RECORDS_WRITE_LOST_KIND,
  RecordsWriteLostPayloadSchema,
  recordsWriteLostFingerprint,
  recordsWriteLostMessage,
} from "../../core";

// A lost write costs a recomputation, not a verdict: one ring a day per cause.
const NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The `plugin-records-write-lost` report kind — see the store's CLAUDE.md. */
export const recordsWriteLostKind = ReportKind({
  kind: RECORDS_WRITE_LOST_KIND,
  schema: RecordsWriteLostPayloadSchema,
  fingerprint: recordsWriteLostFingerprint,
  meta: {
    tag: "[plugin-records]",
    notif: "A process could not write its plugin records",
    variant: "warning",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = RecordsWriteLostPayloadSchema.parse(row.data);
    return {
      title: `Plugin records lost: store ${d.reason}`,
      description: [
        recordsWriteLostMessage(d),
        "",
        `- Store: \`${d.store}\``,
        `- Process: pid ${d.pid}, \`${d.command}\``,
        `- Transactions committed before the loss: ${d.transactions}`,
        `- Writer line: waited ${Math.round(d.waitedMs)} ms in total, longest ${Math.round(d.longestWaitMs)} ms`,
        `- Lock held: ${Math.round(d.heldMs)} ms in total, longest ${Math.round(d.longestHoldMs)} ms`,
        "",
        'Every writer of the store queues in its writer line (`plugins/plugin-meta/plugins/plugin-records`, "No write holds the store long"), so a busy lock means something outside the line held it past the backstop wait: find it (an old store file version? a hand-opened sqlite3?) rather than raising the wait.',
      ].join("\n"),
    };
  },
});
