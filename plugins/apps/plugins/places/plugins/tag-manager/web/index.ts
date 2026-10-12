import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  TagManagerPanel,
  type TagManagerPanelProps,
} from "./components/tag-manager-panel";
export { TagMark, type TagMarkProps } from "./components/tag-mark";

export default {
  description:
    "The Places tag manager: the one tag tree as an editable table (colour, icon, name, parent, Google types, place count, + Child, Delete) on a floating card the map opens; and TagMark, how a tag shows beside its name everywhere (its tinted icon, else a dot of its colour).",
  contributions: [],
} satisfies PluginDefinition;
