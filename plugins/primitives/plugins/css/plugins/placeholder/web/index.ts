import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Placeholder } from "./internal/placeholder";
export type { PlaceholderProps } from "./internal/placeholder";

export default {
  description:
    "Muted text placeholder for loading, empty, and error states. Props: children, tone (muted | error). Declares only block padding: its inline edge is the region's (on the rows' text edge in a row host), so a spot with nothing padding it needs an owner, never an inset on the Placeholder.",
  contributions: [],
} satisfies PluginDefinition;
