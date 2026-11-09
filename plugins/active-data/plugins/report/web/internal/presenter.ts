import { useLive } from "@plugins/network/plugins/live/web";
import {
  paneTarget,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { reportsList } from "@plugins/reports/core";
import { reportDetailPane } from "@plugins/debug/plugins/reports/web";
import type { IdReferentState } from "@plugins/ids/web";

/** A report's chip title — its kind and one-line message — from the by-id row read. */
export function useReportReferent(id: string): IdReferentState {
  return rowReferent(
    useLive(reportsList, { id }),
    (r) => `${r.kind}: ${r.message}`,
  );
}

/** The report's detail pane. */
export function useReportPane(id: string): PaneTarget {
  return paneTarget(reportDetailPane, { reportId: id });
}
