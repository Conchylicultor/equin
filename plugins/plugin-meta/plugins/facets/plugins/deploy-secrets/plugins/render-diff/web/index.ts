import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web";
import {
  deploySecretsToComparable,
  type DeploySecretsData,
} from "@plugins/plugin-meta/plugins/facets/plugins/deploy-secrets/core";

export default {
  description: "Diff renderer for the deploy-secrets facet (PR review).",
  contributions: [
    PluginChangesSlots.DiffRenderer({
      facetId: "deploy-secrets",
      label: "Deploy secrets",
      toComparable: (data) =>
        deploySecretsToComparable(data as DeploySecretsData),
    }),
  ],
} satisfies PluginDefinition;
