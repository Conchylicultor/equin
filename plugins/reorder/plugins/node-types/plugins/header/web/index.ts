import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ReorderNodes } from "@plugins/reorder/plugins/node-types/web";
import { headerNodeType } from "./internal/node-type";

export default {
  description:
    "Header reorder node type: the one container type — a labeled, collapsible box rendering its pre-rendered members. Owns the label/collapsed payload schema; collapse toggles via onPatch.",
  contributions: [
    ReorderNodes.NodeType({ nodeType: headerNodeType, companion: true }),
  ],
} satisfies PluginDefinition;
