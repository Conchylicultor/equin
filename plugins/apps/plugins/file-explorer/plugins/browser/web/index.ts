import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  filesBrowserAtLegacyPane,
  filesComputerAtLegacyPane,
  filesFolderPane,
  filesHomePane,
  filesPreviewPane,
} from "./panes";
import { FileBrowserSlots } from "./slots";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { filesDocumentTheme } from "./internal/theme";
import { fileEntryPresentation } from "./internal/presentation";
import { CopyPathAction, ExtractAction } from "./components/row-actions";

export { FileBrowser, type FileBrowserProps } from "./components/file-browser";
export { PreviewPane } from "./components/preview-pane";
export { FileBrowserSlots, type ExplorerLensItem } from "./slots";
export type { ExplorerNavigator } from "./internal/navigator";
export { useExplorerDir } from "./internal/explorer-dir";
export {
  useFolderPathSource,
  useHomeDir,
  useHostPathSource,
  type HomeDir,
  type PathBarSystem,
} from "./internal/host-path-source";
export {
  useExplorerSystem,
  useHomeSystem,
  type ExplorerSystem,
  type ExplorerSystemState,
  type HomeSystemState,
} from "./internal/explorer-system";
export {
  useExplorerFileTarget,
  useFileHostPath,
  type FileHostPath,
} from "./internal/file-target";
export {
  filesFolderPane,
  filesHomePane,
  filesPreviewPane,
  locationOf,
  locationParams,
  useExplorerLocation,
  useExplorerFolderTarget,
  useLocationNavigator,
  useOpenInFiles,
  type LocationParams,
} from "./panes";

export default {
  description:
    "The file explorer's browser over any file system this host serves (the computer's disk, the browser's storage; useExplorerSystem says what `~` is there and what it can do, useHomeSystem which one Files opens on): <FileBrowser/> (toolbar with back / forward / up, the system's path bar and a filter; the folder as a lazily-listed DataView tree with Name / Modified / Size; a status bar; the selected file previewed beside it, or handed to fileTarget; its FileBrowserSlots seams — RowActions, a row's hover actions (its own: Extract here on an archive, Copy path in the ⋯ menu), and Lens, hide-rule toggles and a file's git context), and the /files routes it runs under — a Miller row of a folder column (/files/browse/<folder>[;fs=<system>], the bare /files forwarding to the home system's home) and the open file's preview column beside it (…/preview/<open file>, pushed and closed so it slides in and out while the listing stays mounted; the old /files/<fs>/at/<folder>[/<open file>] forwards), so every location is a link and back / forward are the browser history; moves (drag onto a folder) and the other operations are offered only where the system has them; useExplorerFileTarget names any file's place there (its folder, the file previewed) as a pane's Expand target; useFileHostPath + useHostPathSource let any surface draw a file's place as the same host path bar. Contributes the files-document sub-theme the preview's page wears (28/32/48px inset, 14px on 1.6, a 24px heading).",
  slots: {
    "files-home": filesHomePane,
    "files-at": filesFolderPane,
    "files-preview": filesPreviewPane,
    "files-computer-at": filesComputerAtLegacyPane,
    "files-browser-at": filesBrowserAtLegacyPane,
    lens: FileBrowserSlots.Lens,
    "row-actions": FileBrowserSlots.RowActions,
  },
  contributions: [
    Pane.Register({ pane: filesHomePane }),
    Pane.Register({ pane: filesFolderPane }),
    Pane.Register({ pane: filesPreviewPane }),
    Pane.Register({ pane: filesComputerAtLegacyPane }),
    Pane.Register({ pane: filesBrowserAtLegacyPane }),
    ThemeEngine.SubTheme(filesDocumentTheme),
    fileEntryPresentation,
    FileBrowserSlots.RowActions({ id: "extract", component: ExtractAction }),
    FileBrowserSlots.RowActions({ id: "copy-path", component: CopyPathAction }),
  ],
} satisfies PluginDefinition;
