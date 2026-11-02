import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { defineExtension } from "./internal/define-extension";
export type {
  EntityExtension,
  ExtensionIndexBuilders,
  ExtensionMeta,
} from "./internal/define-extension";
export { EntityExtensions } from "./internal/entity-extensions";

export default {
  description:
    "Lets sub-plugins attach typed DB fields to a parent's entity table via 1:1 side-tables. Each consumer owns its <parent>_ext_<name> table; FK CASCADE on parent delete.",
  loadBearing: true,
} satisfies ServerPluginDefinition;
