import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { reportsList } from "@plugins/reports/core";
import { reportDetailPane } from "@plugins/debug/plugins/reports/web";
import type { IdReferentState } from "@plugins/ids/web";

/** A report's chip title — its kind and one-line message — from the by-id row read. */
export function useReportReferent(id: string): IdReferentState {
  return rowReferent(
    useLiveRow(reportsList, id),
    (r) => `${r.kind}: ${r.message}`,
  );
}

/** The link to the report's detail pane beside the surface holding the id (`push`). */
export function useReportTarget(): (id: string) => LinkTarget {
  const openPane = useOpenPane();
  return (id) =>
    openPane.to(reportDetailPane, { reportId: id }, { mode: "push" });
}
