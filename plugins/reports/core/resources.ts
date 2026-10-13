import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveBoolean,
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";

// Web-safe view of a report row. Generic columns only — the per-kind payload
// lives in `data` (validated server-side by each kind's ReportKindSpec.schema),
// and kind-specific rendering is delegated to the matching Reports.KindView.
export const ReportSchema = z.object({
  id: z.string(),
  kind: z.string(),
  fingerprint: z.string(),
  worktree: z.string(),
  source: z.string(),
  message: z.string(),
  url: z.string().nullable(),
  userAgent: z.string().nullable(),
  data: z.record(z.unknown()),
  count: z.number().int(),
  rateLimited: z.boolean(),
  noise: z.boolean(),
  lastClientId: z.string().nullable(),
  lastBuildId: z.string().nullable(),
  taskId: z.string().nullable(),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Report = z.infer<typeof ReportSchema>;

/**
 * The Debug → Reports DataView's id (its `storageKey`): the surface
 * `reportsList` is listed on, whose custom columns sort and filter it. The
 * DataView declares the same literal with `defineDataView` (a web-only marker
 * the codegen scrapes); the DataView asserts at mount that the two agree.
 */
const REPORTS_VIEW_ID = "debug.reports";

// Every recorded report, last seen first — the Reports DataView's live source,
// the detail pane's by-id read (`useLiveRow`, the collection's `:rows`) and its
// kind / source filter options (the `:groups` grouping). One collection serves
// all three: there is no base `where` (a worktree only ever holds its own rows —
// `reports` is excluded from the fork).
//
// `reports` has no change-feed trigger: its change source is the reports
// producer (server/internal/producer.ts), which routes the ids every write
// returned, coalesced to one flush per 2 s — so a crash storm UPDATEing a hot
// row thousands of times a minute costs each reading tuple one scoped refill per
// window. Read as key-range pages (no depth limit); NOT preloaded — a
// produced table may have no L2-persisted reader (A6), and a window never is.
export const reportsList = liveCollection("reports.list", {
  row: ReportSchema,
  id: "id",
  // What the Reports DataView can filter on, by filter-language domain.
  // `message` and `fingerprint` have no field: they are searched only.
  filterable: {
    kind: liveText(),
    source: liveText(),
    noise: liveBoolean(),
    rateLimited: liveBoolean(),
    count: liveNumber(),
    lastSeenAt: liveInstant(),
    message: liveText(),
    fingerprint: liveText(),
  },
  sortable: ["kind", "source", "count", "lastSeenAt"],
  default: { orderBy: [["lastSeenAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: REPORTS_VIEW_ID,
});

/** The text columns the search box matches (any of, case-insensitively). */
export const REPORTS_SEARCHABLE = ["message", "kind", "fingerprint"] as const;
