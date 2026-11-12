import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { RankReorderProvider } from "./internal/rank-reorder-provider";
export type {
  RankReorderProviderProps,
  RankSortableGroups,
} from "./internal/rank-reorder-provider";
export type { RankDragPreview, RankReseatDest } from "./internal/drag-preview";
export {
  useRankDragState,
  useRankGroupDropTarget,
  useRankNewGroupTarget,
  useRankSortableGroup,
} from "./internal/rank-drag-context";
export type { RankSortableGroupControls } from "./internal/rank-drag-context";
export type { RankReorderItem } from "./internal/resolve-sortable-drop";
export { useRankSortableItem } from "./internal/use-rank-sortable-item";
export type { RankSortableItemControls } from "./internal/use-rank-sortable-item";
export { RankReorderDndContext } from "./internal/rank-reorder-dnd-context";
export type { RankReorderDndContextProps } from "./internal/rank-reorder-dnd-context";
export { useRankReorderItem } from "./internal/use-rank-reorder-item";
export type { RankReorderItemControls } from "./internal/use-rank-reorder-item";

export default {
  description:
    "Rank-based drag-reorder primitive. Flat lists and grids: a sortable RankReorderProvider (one SortableContext, the dragged row follows the pointer and its group's rows slide, drops resolved to a Rank via computeFlatReorder, group-by aware; with onReseat + slideAcrossGroups a row dragged into another group is previewed there so its rows slide, group headers / empty bands take anchorless drops, an optional new-group target, and sortable whole-group blocks) and useRankSortableItem per row. The tree: RankReorderDndContext + useRankReorderItem (indicator-line before/after droppables and a drag chip). Depends only on rank + dnd-kit.",
  contributions: [],
} satisfies PluginDefinition;
