import { Tree } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TreeRowActions, treeRowTrailing } from "./internal/tree-row-actions";
export type { RowMenu, TreeRowActionsProps } from "./internal/tree-row-actions";
export {
  groupFoldAction,
  TreeRootAdd,
  TreeToolbar,
} from "./internal/tree-toolbar";
export type { TreeToolbarProps } from "./internal/tree-toolbar";
export { TreeRowChrome } from "./internal/tree-row-chrome";
export type { TreeRowChromeProps } from "./internal/tree-row-chrome";
export { TreeLeading } from "./internal/tree-leading";
export type { TreeLeadingProps } from "./internal/tree-leading";
export { TreeDropZones } from "./internal/tree-drop-zones";
export type { TreeDropZonesProps } from "./internal/tree-drop-zones";
export { treeRowGestures } from "./internal/tree-row-gestures";
export { TreeChildPlaceholder } from "./internal/tree-child-placeholder";
export { treeRowIndentStyle } from "./internal/tree-indent";
export { useTreeModel } from "./internal/use-tree-model";
export type {
  TreeModel,
  TreeModelArgs,
  TreeModelContext,
} from "./internal/use-tree-model";
export { useTreeKeyboard } from "./internal/use-tree-keyboard";
export { TreeDisclosureToggle } from "./internal/tree-disclosure-toggle";
export type { TreeDisclosureToggleProps } from "./internal/tree-disclosure-toggle";
export { Tree } from "./slots";
export type { TreeDisclosureContribution } from "./slots";
export {
  useTreeRow,
  TreeProvider,
  useTreeContext,
  useOptionalTreeContext,
  useOptionalRowControls,
  useRowControls,
  RowControlsProvider,
} from "./internal/use-tree-row";
export type { RowControls, TreeContextValue } from "./internal/use-tree-row";
export type { TreeItem } from "./internal/types";

export { useFlatExpandAll } from "./internal/use-flat-expand-all";
export type {
  UseFlatExpandAllReturn,
  FlatExpandAll,
} from "./internal/use-flat-expand-all";

export default {
  description:
    "Tree hierarchy utilities (buildTree, isDescendant, resolveDropParent), the tree model (useTreeModel: flattened visible lines, DnD, lazy children, keyboard) and the tree-row pieces a renderer composes (TreeRowChrome, TreeLeading, useTreeRow, TreeRowActions, TreeToolbar) — drawn by data-view's nested table.",
  contributions: [],
  slots: Tree,
} satisfies PluginDefinition;
