import { z } from "zod";
import {
  cappedList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { identifierField } from "@plugins/fields/plugins/identifier/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { reportIdKind } from "./id-kind";

/** How many occurrences a report keeps in {@link reportFields}' `recent`. */
// Small on purpose: `reports.list` carries it on every row of its window.
export const REPORT_RECENT_MAX = 10;

/**
 * One occurrence of a report, as `recent` keeps it: when, what it said, and
 * which tab (and page, and bundle) raised it — the attribution the row's
 * last-writer-wins columns overwrite on every repeat.
 */
export const ReportOccurrenceSchema = z.object({
  /** Epoch ms of the event (the occurrence's own instant, not the write). */
  at: z.number(),
  message: z.string(),
  clientId: z.string().nullable(),
  url: z.string().nullable(),
  buildId: z.string().nullable(),
});
export type ReportOccurrence = z.infer<typeof ReportOccurrenceSchema>;

/**
 * A report's fields, in column order — the `reports` table is built from them
 * (`server/internal/tables.ts`). One row per (fingerprint, worktree).
 *
 * `kind` discriminates the event type and is fully generic — the reports
 * engine never names a kind. Each kind contributes a ReportKindSpec (schema +
 * fingerprint + meta + renderTask) and stores its per-kind payload in `data`.
 */
export const reportFields = {
  id: idKindField(reportIdKind),
  kind: textField({ label: "Kind" }),
  fingerprint: identifierField({ label: "Fingerprint" }),
  worktree: textField({ label: "Worktree" }),
  source: textField({ label: "Source" }),
  /** Generic one-line summary shown in lists / notifications. */
  message: textField({ label: "Message" }),
  url: nullable(textField({ label: "URL" })),
  userAgent: nullable(textField({ label: "User agent" })),
  /**
   * The kind's validated payload. Each ReportKindSpec.schema owns this shape;
   * the engine persists whatever the schema parses without inspecting it. The
   * column's decoder states the ONE thing true of every kind — a JSON object —
   * and `z.record` keeps every key, so it normalizes nothing away from a kind
   * it has never heard of. `recordReport` parses the kind's schema before
   * writing, and each kind's task builder re-parses it on read.
   */
  data: jsonField({
    schema: wholeRecord(z.unknown(), {
      reason: "one report's payload — the named fields its kind records",
    }),
    default: {},
  }),
  count: intField({ label: "×" }),
  /**
   * Generic velocity state: set when this fingerprint fired faster than the
   * velocity window allows; while the burst lasts, recordReport skips the bell
   * notification.
   */
  rateLimited: boolField({ label: "Rate-limited" }),
  noise: boolField({ label: "Noise" }),
  /**
   * Attribution (last-writer-wins): the tab + bundle identity of the most
   * recent report for this fingerprint. NOT part of the dedup key.
   * `lastBuildId` holds the bundle's GRAPH HASH — the artifact's content
   * identity; the column name is the older spelling.
   */
  lastClientId: nullable(textField()),
  lastBuildId: nullable(textField()),
  /**
   * The newest {@link REPORT_RECENT_MAX} occurrences, newest first — so a
   * repeat no longer erases what the one before it said (its duration, its
   * tab). `count` still counts every occurrence; older ones age out here.
   */
  recent: jsonField({
    schema: cappedList(ReportOccurrenceSchema, { max: REPORT_RECENT_MAX }),
    default: [],
  }),
  /**
   * Soft reference to tasks.id — the cross-plugin FK would cross a plugin
   * boundary, so integrity is validated in code via getTask(). A deleted task
   * just surfaces as `needsTask` on the next report.
   */
  taskId: nullable(textField()),
  firstSeenAt: dateField({ label: "First seen" }),
  lastSeenAt: dateField({ label: "When" }),
  createdAt: dateField({ label: "Created" }),
  updatedAt: dateField({ label: "Updated" }),
} satisfies FieldsRecord;

/** The `reports` entity — every recorded report of this worktree. */
export const reportsEntityRef = entityRef("reports", reportFields);
