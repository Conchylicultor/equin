import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { reorderConfigContributions } from "./internal/config-registrations";
import { ReorderSlots } from "./slots";

// Contributed to slot-render by the `slot-middleware` sub-plugin.
export { ReorderListMiddleware } from "./internal/list-middleware";
export { ReorderItemMiddleware } from "./internal/item-middleware";
export { ReorderSlots } from "./slots";
export type {
  ReorderAreaEditor,
  ReorderAreaEditorProps,
  ReorderAreaWrites,
  ReorderRegime,
} from "./internal/editor-contract";
export { ReorderLayoutContext } from "./internal/reorder-layout";
export type { ReorderLayout } from "./internal/reorder-layout";
export { useReorderedEntries } from "./internal/use-reordered-entries";
export { contributionLabel, entryKey, isNodeData } from "./internal/sorting";
export type {
  ReorderNodeData,
  ReorderState,
  TopLevelEntry,
} from "./internal/sorting";

export default {
  description:
    "Generic reorder primitive: every defineRenderSlot is unconditionally reorderable; use defineMountSlot for headless slots. Applies each slot's committed layout everywhere slots render; editing a layout (drag, hide, insert) is the opt-in ReorderSlots.AreaEditor, mounted beside an area's items only while edit mode is on.",
  loadBearing: true,
  slots: ReorderSlots,
  // One config_v2 directive per reorderable slot, registered under the slot's
  // DEFINING plugin (via `pluginId`). The descriptor instances are the
  // SAME objects the middleware passes to `useConfig`/`useSetConfig` (reference
  // identity matters — both import the shared `descriptors` map).
  contributions: reorderConfigContributions,
} satisfies PluginDefinition;
