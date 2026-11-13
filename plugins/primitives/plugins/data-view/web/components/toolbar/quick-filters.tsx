import { Fragment, type ReactNode } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import type { QuickFilter } from "../../../core";
import { useDataViewControls } from "../controls/controls-context";
import { PillDivider } from "./pills-toolbar";
import {
  activeQuickOption,
  applyQuickOption,
} from "../../internal/quick-filter";

/**
 * The surface's quick filters (`DataViewProps.quickFilters`): one segmented
 * control each, over the active view's filter — the selected option read off
 * it (none selected when it holds a rule no option names), a pick written
 * through the same `setFilter` the Filter panel uses. Reads the controls
 * context, so it renders wherever the toolbar's controls do (the band, the
 * compact fold's panel, a hosted frame's options, a section's `⋯`).
 *
 * `layout: "row"` (a band's pill) parts the groups with the pill divider, so
 * two segmented controls never read as one strip of chips; `"column"` (a
 * panel, each group on its own line) needs none.
 */
export function QuickFilters({
  quickFilters,
  layout,
}: {
  quickFilters: readonly QuickFilter[];
  layout: "row" | "column";
}): ReactNode {
  const { filter, fields } = useDataViewControls();
  return quickFilters.map((qf, i) => {
    // A quick filter on a field the schema lacks would write rules nothing
    // runs: an authoring mistake, said where it is made.
    if (!fields.some((f) => f.id === qf.fieldId))
      throw new Error(
        `DataView quick filter "${qf.id}" names field "${qf.fieldId}", which the surface's schema does not declare.`,
      );
    return (
      <Fragment key={qf.id}>
        {layout === "row" && i > 0 ? <PillDivider /> : null}
        <SegmentedControl
          label={qf.label}
          options={qf.options}
          value={activeQuickOption(filter.filter, qf)}
          onChange={(id) => {
            const option = qf.options.find((o) => o.id === id);
            if (option === undefined)
              throw new Error(`Quick filter "${qf.id}" has no option "${id}".`);
            filter.setFilter(applyQuickOption(filter.filter, qf, option));
          }}
        />
      </Fragment>
    );
  });
}
