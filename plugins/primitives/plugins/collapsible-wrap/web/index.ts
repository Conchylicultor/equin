import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { CollapsibleWrap } from "./internal/collapsible-wrap";
export type { CollapsibleWrapProps } from "./internal/collapsible-wrap";

export default {
  description:
    "Wraps overflowing children to multiple lines, clamped to N rows by default with a chevron toggle to reveal the rest.",
  contributions: [],
} satisfies PluginDefinition;
