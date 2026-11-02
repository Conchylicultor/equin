import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { variantRegionServerContribution } from "@plugins/ui/plugins/variant-region/server";
import { sidebarFraming } from "../core";

export default {
  contributions: [variantRegionServerContribution(sidebarFraming)],
} satisfies ServerPluginDefinition;
