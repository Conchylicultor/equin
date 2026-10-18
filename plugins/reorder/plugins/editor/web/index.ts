import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ReorderEditor, sortableIdsOf } from "./internal/reorder-editor";
export { ReorderItemChrome, RestoreButton } from "./internal/items";
export type { ReorderEditorProps } from "./internal/types";

export default {
  description:
    "Presentational drag-and-drop reorder editor: a self-contained ReorderEditor (list, hide/restore, inserts), the item chrome that dresses a reorder item box in edit mode, and the restore/insert popover. Display-only — no config_v2, catalog, or tree-format knowledge. Edit side only: the in-app layout editor (reorder.edit-mode) and the Config pane's reorder-tree field.",
  contributions: [],
} satisfies PluginDefinition;
