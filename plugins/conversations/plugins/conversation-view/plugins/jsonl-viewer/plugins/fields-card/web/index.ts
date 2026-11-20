import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { FieldsCard } from "./components/fields-card";
export type { FieldsCardField } from "./components/fields-card";

export default {
  description:
    "Shared appearance for a headline + truncating summary preview + fold-out key/value field list. Used by the queued task-notification card and the native task-notification row so the two never diverge.",
  contributions: [],
} satisfies PluginDefinition;
