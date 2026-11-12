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
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { reportIdKind } from "./id-kind";
import { REPORT_FIX_STATES, REPORT_FIX_STATE_LABELS } from "./fix-state";

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
  /**
   * The commit the code that raised it ran (the backend's pin, the bundle's
   * build commit, a CLI's HEAD); null when it cannot be named (a mixed boot, a
   * dev bundle, an occurrence recorded before the field existed). What a
   * regression is judged on: does it descend from the fix?
   */
  commit: z.string().nullable().default(null),
});
export type ReportOccurrence = z.infer<typeof ReportOccurrenceSchema>;

/** How many hour buckets a report keeps in {@link reportFields}' `hourly`. */
export const REPORT_HOURLY_MAX = 24;

/**
 * A report's occurrences counted per clock hour (UTC hour start, epoch ms),
 * newest first, the newest {@link REPORT_HOURLY_MAX} hours that saw one — what
 * "how many in the last 24 h" is read from (`reportActivity`), since `count`
 * is the lifetime total and `recent` keeps only the newest few.
 *
 * `untrackedBefore`: null when the report was counted per hour from its first
 * occurrence — every occurrence in a kept hour is in it; otherwise when
 * counting began (a report first seen before `hourly` existed), occurrences
 * before it possibly missing.
 */
export const ReportHourlySchema = z.object({
  hours: cappedList(z.object({ h: z.number(), n: z.number() }), {
    max: REPORT_HOURLY_MAX,
  }),
  untrackedBefore: z.number().nullable(),
});
export type ReportHourly = z.infer<typeof ReportHourlySchema>;

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
  /** Every occurrence since first seen — the lifetime total. */
  count: intField({ label: "Total" }),
  /**
   * Generic velocity state: set when this fingerprint fired faster than the
   * velocity window allows; while the burst lasts, recordReport skips the bell
   * notification.
   */
  rateLimited: boolField({ label: "Rate-limited" }),
  noise: boolField({ label: "Noise" }),
  /**
   * Every occurrence so far came from an outdated tab (`fromOutdatedBundle`,
   * judged against the graph the server served AT THAT MOMENT) — sticky: one
   * occurrence from a tab on the served graph clears it for good. A fact,
   * stored because nothing can re-derive it later: the server's graph has
   * moved on by then, and judging an old row against the current one calls
   * every report filed before the last deploy stale. It EXPLAINS nothing by
   * itself: nearly every long-lived tab is outdated (main deploys on every
   * push), and a bug in an old bundle is a bug.
   */
  staleOrigin: boolField({ label: "Stale tab" }),
  /**
   * Every occurrence so far PROVED version skew, by the proof its source
   * declares (reports/core's `SKEW_PROOF`): a failed module load by a file of
   * the tab's build the server answered 404 for and confirmed retired
   * (`ReportBody.missingFile`, build/server-build-id's `isRetiredBuildFile`);
   * another build's stored entry by the tab being outdated. Sticky like
   * `staleOrigin`: one occurrence that proved nothing clears it for good. The
   * one fact version skew explains a report by (`versionSkewExplains`).
   */
  skewProven: boolField({ label: "Version skew" }),
  /**
   * Attribution (last-writer-wins): the tab + bundle identity of the most
   * recent report for this fingerprint. NOT part of the dedup key.
   * `lastBuildId` holds the bundle's GRAPH HASH — the artifact's content
   * identity; the column name is the older spelling.
   */
  lastClientId: nullable(textField()),
  lastBuildId: nullable(textField()),
  /** The newest occurrence's `commit` (see {@link ReportOccurrenceSchema}). */
  lastCommit: nullable(textField({ label: "Commit" })),
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
   * Occurrences per hour (see {@link ReportHourlySchema}). Null on a report
   * not written since the column was added: nothing counted per hour yet.
   */
  hourly: nullable(jsonField({ schema: ReportHourlySchema })),
  /**
   * Soft reference to tasks.id — the cross-plugin FK would cross a plugin
   * boundary, so integrity is validated in code via getTask(). A deleted task
   * just surfaces as `needsTask` on the next report.
   */
  taskId: nullable(textField()),
  /**
   * Where the report stands against its fix (`core/fix-state.ts`): DERIVED
   * from the fix ledger (`report_fixes`) by the engine's one writer of it,
   * never set by a caller. `fixCommit` is the latest fix's commit, and
   * `fixStateAt` when the state began (landed / deployed / regressed).
   */
  fixState: enumTextField(REPORT_FIX_STATES, {
    label: "Status",
    default: "open",
    ordered: true,
    options: {
      open: { label: REPORT_FIX_STATE_LABELS.open },
      pending: { label: REPORT_FIX_STATE_LABELS.pending, variant: "info" },
      fixed: { label: REPORT_FIX_STATE_LABELS.fixed, variant: "success" },
      regressed: {
        label: REPORT_FIX_STATE_LABELS.regressed,
        variant: "destructive",
      },
    },
  }),
  fixCommit: nullable(textField({ label: "Fix" })),
  fixStateAt: nullable(dateField({ label: "Status since" })),
  firstSeenAt: dateField({ label: "First seen" }),
  lastSeenAt: dateField({ label: "When" }),
  createdAt: dateField({ label: "Created" }),
  updatedAt: dateField({ label: "Updated" }),
} satisfies FieldsRecord;

/** The `reports` entity — every recorded report of this worktree. */
export const reportsEntityRef = entityRef("reports", reportFields);
