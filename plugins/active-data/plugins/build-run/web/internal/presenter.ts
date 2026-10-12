import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import { buildHistory } from "@plugins/build/core";
import { buildDetailPane } from "@plugins/build/web";
import type { IdReferentState } from "@plugins/ids/web";
import { buildRunTitle } from "../../core";

/**
 * A build run's chip title from the by-id row read. `build.history` is scoped
 * to THIS backend's namespace, so a run another checkout made reads as missing
 * and the chip falls back to the raw id — which is the truth here.
 */
export function useBuildRunReferent(id: string): IdReferentState {
  return rowReferent(useLiveRow(buildHistory, id), buildRunTitle);
}

/** The link to the build's run-detail pane beside the surface holding the id (`push`). */
export function useBuildRunTarget(): (id: string) => LinkTarget {
  const openPane = useOpenPane();
  return (id) => openPane.to(buildDetailPane, { runId: id }, { mode: "push" });
}
