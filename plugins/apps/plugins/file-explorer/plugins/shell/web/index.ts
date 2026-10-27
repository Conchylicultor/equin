import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { fileExplorerApp } from "../core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { FileExplorerLayout } from "./components/file-explorer-layout";
import { FilesMark } from "./components/files-mark";
import { filesTheme } from "./internal/theme";
import { FileExplorer } from "./slots";

export {
  FileExplorer,
  type FolderPlace,
  type Place,
  type RoutePlace,
  type PlaceGroup,
  type PlacesSource,
  type PlacesState,
} from "./slots";

export default {
  description:
    "App shell for Files (the file explorer): registers the /files app entry with its outline-folder mark, contributes the app's own theme (files: the prototype's zinc palette, blue accent, Lucide icons and metrics), lays the Places sidebar beside one full-surface browser pane, and defines the FileExplorer.Sidebar / Toolbar / Places slots.",
  contributions: [
    Apps.App({
      app: fileExplorerApp,
      mark: FilesMark,
      component: FileExplorerLayout,
    }),
    ThemeEngine.Theme(filesTheme),
  ],
  slots: FileExplorer,
} satisfies PluginDefinition;
