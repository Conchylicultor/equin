import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { reorderConfigContributions } from "./internal/config-registrations";

// Contributed to slot-render by the `slot-middleware` sub-plugin.
export { ReorderListMiddleware } from "./internal/list-middleware";
export { useReorderedEntries } from "./internal/use-reordered-entries";
export { useLayoutOrder } from "./internal/use-layout-order";
export { contributionLabel, entryKey, isNodeData } from "./internal/sorting";
export type {
  ReorderNodeData,
  ReorderState,
  TopLevelEntry,
} from "./internal/sorting";

export default {
  description:
    "Generic reorder primitive: every defineRenderSlot is unconditionally reorderable; use defineMountSlot for headless slots. Applies each slot's committed layout (order, hidden items, spacers, dividers, groups) everywhere slots render; a layout is edited in its config file or the Config pane's reorder-tree field.",
  loadBearing: true,
  // One config_v2 directive per reorderable slot, registered under the slot's
  // DEFINING plugin (via `pluginId`). The descriptor instances are the
  // SAME objects the middleware passes to `useConfig`/`useSetConfig` (reference
  // identity matters — both import the shared `descriptors` map).
  contributions: reorderConfigContributions,
} satisfies PluginDefinition;
