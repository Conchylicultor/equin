import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ReorderNodes } from "@plugins/reorder/plugins/node-types/web";
import { spacerNodeType } from "./internal/node-type";

export default {
  description:
    "Spacer reorder node type: a blank draggable gap (leaf), with an 'Add Spacer' insert affordance.",
  contributions: [
    ReorderNodes.NodeType({ nodeType: spacerNodeType, companion: true }),
  ],
} satisfies PluginDefinition;
