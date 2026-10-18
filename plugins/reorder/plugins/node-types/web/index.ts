import { ReorderNodes } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ReorderNodes } from "./slots";
export { useReorderNodeTypes } from "./internal/use-node-types";
export { RemoveNodeButton } from "./components/remove-node-button";

export default {
  description:
    "Reorder node-type registry: owns the reorder.node-type slot and the useReorderNodeTypes() read hook. Slot owner only — contributes no node types itself.",
  contributions: [],
  slots: ReorderNodes,
} satisfies PluginDefinition;
