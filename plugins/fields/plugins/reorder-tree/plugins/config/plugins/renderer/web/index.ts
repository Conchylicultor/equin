import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/config_v2/plugins/fields/web";
import { reorderTreeSample } from "@plugins/fields/plugins/reorder-tree/plugins/config/core";
import { ReorderTreeRenderer } from "./components/reorder-tree-renderer";

export default {
  description:
    "Reorder-tree field type: the Config pane renderer (the drag-and-drop layout editor over a slot's tree, for config-v2.fields.renderer) and its gallery sample.",
  contributions: [
    Fields.Renderer(ReorderTreeRenderer),
    Fields.Sample(reorderTreeSample),
  ],
} satisfies PluginDefinition;
