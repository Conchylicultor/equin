import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { folderPeekPane } from "./panes";

export { folderPeekPane, useFolderPeekTarget } from "./panes";

export default {
  description:
    "A host folder browsed as a side pane through the Files browser (tree, path bar, Up, a file previewed beside it): the folder/<dir>[/<open file>] pane, homed in Files and opened beside any surface — useFolderPeekTarget(dir) is its link — with Expand opening Files at the pane's location.",
  slots: { "folder-peek": folderPeekPane },
  contributions: [Pane.Register({ pane: folderPeekPane })],
} satisfies PluginDefinition;
