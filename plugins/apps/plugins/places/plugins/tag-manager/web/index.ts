import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  TagManagerPanel,
  type TagManagerPanelProps,
} from "./components/tag-manager-panel";

export default {
  description:
    "The Places tag manager: the one tag tree as an editable table (colour, icon, name, parent, Google types, place count, + Child, Delete, Shade children) on a floating card the map opens, written through the tag-tree engine.",
  contributions: [],
} satisfies PluginDefinition;
