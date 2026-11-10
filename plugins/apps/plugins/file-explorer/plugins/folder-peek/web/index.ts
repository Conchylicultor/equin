import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { folderPeekPane } from "./panes";

export {
  folderPeekPane,
  folderLocationParams,
  useFolderPeekTarget,
} from "./panes";

export default {
  description:
    "A folder of any browsable file system browsed as a side pane through the Files browser (the browser's header — back / forward / up, the path bar as the title, the filter, the toggles — as the pane header; tree, a file previewed beside it): the folder/<dir>[/<open file>][;fs=<system>] pane (no ;fs: the computer's disk), homed in Files and opened beside any surface — useFolderPeekTarget()(fs, dir) is its link, folderLocationParams(fs, dir) its params — with Expand opening Files at the pane's location.",
  // No `slots`: the pane borrows the browser's FileBrowserHeader, declared
  // there — declaring it here too would name one slot twice.
  contributions: [Pane.Register({ pane: folderPeekPane })],
} satisfies PluginDefinition;
