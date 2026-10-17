import { useCallback } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { LiveArm } from "@plugins/network/plugins/live/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  useOpenPane,
  type OpenPaneFn,
} from "@plugins/primitives/plugins/pane/web";
import type { RunRow } from "../../core";

/**
 * Where a run of `arm` goes when clicked, in every list of runs: its detail
 * pane, as a link (`openPane.to(…)`), so middle- and ⌘-click open the run in a
 * browser tab. `link` receives the surface's own `openPane`, so the arm
 * navigates from the surface the row is rendered in rather than always at the
 * root. An arm with no detail surface registers none, and its rows simply do
 * not activate — the honest behaviour, not a click that quietly does nothing.
 *
 * It is data-view's `CollectionRowActivation` over the arm (a Meta-DataView
 * dispatches each row to its own source), typed by the run row.
 */
export function runLinks(
  arm: LiveArm<RunRow, FieldsRecord, string>,
  link: (run: RunRow, ctx: { openPane: OpenPaneFn }) => LinkTarget,
): Contribution {
  function useRunLink(): (row: unknown) => LinkTarget {
    const openPane = useOpenPane();
    return useCallback(
      (row: unknown) => link(row as RunRow, { openPane }),
      [openPane],
    );
  }
  return DataViewSlots.CollectionRowActivation({
    id: "open",
    owner: arm,
    useActivation: useRunLink,
  });
}
