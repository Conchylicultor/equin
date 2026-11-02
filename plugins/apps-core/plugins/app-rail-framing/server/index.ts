import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { variantRegionServerContribution } from "@plugins/ui/plugins/variant-region/server";
import { appRailFraming } from "../core";

export default {
  contributions: [variantRegionServerContribution(appRailFraming)],
} satisfies ServerPluginDefinition;
