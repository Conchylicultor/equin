import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Contributions } from "@plugins/plugin-meta/plugins/contributions-table/web";
import {
  structureFacetTable,
  structureRowActivation,
} from "./structure-facet-table";

export default {
  description:
    "Aggregated cross-plugin structure-anomaly table in the Studio Contributions view.",
  contributions: [
    Contributions.FacetTable(structureFacetTable),
    Contributions.RowActivation(structureRowActivation),
  ],
} satisfies PluginDefinition;
