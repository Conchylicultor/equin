import { Contributions } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Contributions } from "./slots";
export { defineFacetTable, defineRowActivation } from "./facet-table";
export { PluginChip } from "./components/plugin-chip";
export type {
  ContributionsFacetTable,
  ContributionsRowActivation,
  FacetTableEntry,
  ContributionsRowActivationContext,
} from "./facet-table";

export default {
  description:
    "Registry for the Studio Contributions aggregated-table surface: FacetTable + RowActivation slots and factories.",
  contributions: [],
  slots: Contributions,
} satisfies PluginDefinition;
