import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { variantRegionServerContribution } from "@plugins/ui/plugins/variant-region/server";
import { treeDisclosure } from "../core";

export default {
  contributions: [variantRegionServerContribution(treeDisclosure)],
} satisfies ServerPluginDefinition;
