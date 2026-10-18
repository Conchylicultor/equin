import { liveCollection } from "@plugins/network/plugins/live/core";
import type { LiveRowsCollection } from "@plugins/network/plugins/live/core";
import { reportsEntityRef } from "./entity";

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
  // Generic columns only — the per-kind payload lives in `data` (validated
  // server-side by each kind's ReportKindSpec.schema), and kind-specific
  // rendering is delegated to the matching Reports.KindView. `message` and
  // `fingerprint` are searched (filterable text, hidden by default).
  from: reportsEntityRef,
  pick: [
    "kind",
    "source",
    "noise",
    "rateLimited",
    "count",
    "lastSeenAt",
    "message",
    "fingerprint",
  ],
  carry: {
    pick: [
      "id",
      "worktree",
      "url",
      "userAgent",
      "data",
      "lastClientId",
      "lastBuildId",
      "taskId",
      "firstSeenAt",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  sortable: ["kind", "source", "count", "lastSeenAt"],
  default: { orderBy: [["lastSeenAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: REPORTS_VIEW_ID,
});

/** One recorded report, as the list and the detail pane read it. */
export type Report =
  typeof reportsList extends LiveRowsCollection<infer R> ? R : never;

/** The text columns the search box matches (any of, case-insensitively). */
export const REPORTS_SEARCHABLE = ["message", "kind", "fingerprint"] as const;
