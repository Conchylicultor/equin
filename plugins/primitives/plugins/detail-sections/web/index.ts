import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { defineDetailSections } from "./internal/define-detail-sections";
export type {
  DefaultOpen,
  DetailSection,
  DetailSections,
  DetailSectionsOptions,
} from "./internal/define-detail-sections";

export default {
  description:
    "Factory for extensible detail-view section slots with built-in Reorder DnD.",
  contributions: [],
} satisfies PluginDefinition;
