import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { reorderConfigContributions } from "./internal/config-registrations";
import "./styles.css";

// Contributed to slot-render by the `slot-middleware` sub-plugin.
export { ReorderListMiddleware } from "./internal/dnd-list-middleware";
export { ReorderItemMiddleware } from "./internal/dnd-item-middleware";
export { ReorderLayoutContext } from "./internal/reorder-layout";
export type { ReorderLayout } from "./internal/reorder-layout";
export { useReorderedEntries } from "./internal/use-reordered-entries";
export { isNodeData } from "./internal/sorting";
export type {
  ReorderNodeData,
  ReorderState,
  TopLevelEntry,
} from "./internal/sorting";

export default {
  description:
    "Generic reorder primitive: every defineRenderSlot is unconditionally reorderable; use defineMountSlot for headless slots. DnD is automatic via middleware.",
  loadBearing: true,
  // One config_v2 directive per reorderable slot, registered under the slot's
  // DEFINING plugin (via `pluginId`). The descriptor instances are the
  // SAME objects the middleware passes to `useConfig`/`useSetConfig` (reference
  // identity matters — both import the shared `descriptors` map).
  contributions: reorderConfigContributions,
} satisfies PluginDefinition;
