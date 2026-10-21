import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { variantRegionServerContribution } from "./define-variant-region-server";

export default {
  portable: true,
} satisfies ServerPluginDefinition;
