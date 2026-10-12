import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type {
  ContributionsFacetTable,
  ContributionsRowActivation,
} from "./facet-table";

export const Contributions = {
  /**
   * Per-facet aggregated cross-plugin table — the Contributions view's sole contribution slot.
   * Each facet contributes one declarative table; the Contributions host iterates
   * contributions generically (facet-blind), slicing `node.facets[facetId]` for
   * every plugin.
   */
  FacetTable: defineSlot<ContributionsFacetTable>({
    docLabel: (t) => t.label,
  }),
  /**
   * Per-facet row drill-down, keyed by `facetId`. Contributed by the app-side
   * owner of the target pane so a facet renderer (meta) never imports an app
   * pane — decoupling "what a row shows" (FacetTable) from "what activating it
   * does".
   */
  RowActivation: defineSlot<ContributionsRowActivation>({
    docLabel: (r) => r.facetId,
  }),
};
