import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Contributions } from "@plugins/plugin-meta/plugins/contributions-table/web";
import { deploySecretsFacetTable } from "./deploy-secrets-facet-table";

export default {
  description:
    "Aggregated deploy-secrets table in the Studio Contributions view.",
  contributions: [Contributions.FacetTable(deploySecretsFacetTable)],
} satisfies PluginDefinition;
