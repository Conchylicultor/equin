import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { filesAtPane, filesHomePane } from "./panes";
import { FileBrowserSlots } from "./slots";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { filesDocumentTheme } from "./internal/theme";
import { CopyPathAction, ExtractAction } from "./components/row-actions";

export { FileBrowser, type FileBrowserProps } from "./components/file-browser";
export { FileBrowserSlots, type ExplorerLensItem } from "./slots";
export type { ExplorerNavigator } from "./internal/navigator";
export { useExplorerDir } from "./internal/explorer-dir";
export { useHomeDir, type HomeDir } from "./internal/host-path-source";
export {
  filesAtPane,
  filesHomePane,
  useExplorerLocation,
  useExplorerFolderTarget,
} from "./panes";

export default {
  description:
    "The file explorer's browser: <FileBrowser/> (toolbar with back / forward / up, the host path bar and a filter; the folder as a lazily-listed DataView tree with Name / Modified / Size; a status bar; the selected file previewed beside it, or handed to fileTarget; its FileBrowserSlots seams — Fields, extra tree columns, RowActions, a row's hover actions (its own: Extract here on an archive, Copy path in the ⋯ menu), and Lens, hide-rule toggles and a file's git context), and the /files routes it runs under — the home index and /files/at/<folder>[/<open file>], so every location is a link and back / forward are the browser history. Contributes the files-document sub-theme the preview's page wears (28/32/48px inset, 14px on 1.6, a 24px heading).",
  slots: {
    "files-home": filesHomePane,
    "files-at": filesAtPane,
    fields: FileBrowserSlots.Fields,
    lens: FileBrowserSlots.Lens,
    "row-actions": FileBrowserSlots.RowActions,
  },
  contributions: [
    Pane.Register({ pane: filesHomePane }),
    Pane.Register({ pane: filesAtPane }),
    ThemeEngine.SubTheme(filesDocumentTheme),
    FileBrowserSlots.RowActions({ id: "extract", component: ExtractAction }),
    FileBrowserSlots.RowActions({ id: "copy-path", component: CopyPathAction }),
  ],
} satisfies PluginDefinition;
