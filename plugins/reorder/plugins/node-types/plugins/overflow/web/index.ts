import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ReorderNodes } from "@plugins/reorder/plugins/node-types/web";
import { overflowNodeType } from "./internal/node-type";

export default {
  description:
    "Overflow reorder node type: a container whose authored members all relocate behind one ⋯ panel, via AdaptiveBar.Collapsed — each rendering the form it declared, so a plain action becomes a labelled row and a richer widget stays itself, one live instance either way. In edit mode it is a labelled inline box so the bucket stays draggable. Owns the label payload schema.",
  contributions: [
    ReorderNodes.NodeType({ nodeType: overflowNodeType, companion: true }),
  ],
} satisfies PluginDefinition;
