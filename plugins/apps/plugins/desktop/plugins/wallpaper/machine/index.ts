import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { desktopDir } from "@plugins/apps/plugins/desktop/data-dirs";
import { importWallpaperUrl } from "../core";
import { desktopFiles } from "../server";
import { handleImportUrl } from "./internal/handle-import-url";

export default {
  description:
    "Floating desktop wallpaper, desktop half: binds the wallpaper store's file root to the desktop app's data dir on this computer (apps/desktop), and imports a wallpaper from a link (an SSRF-guarded download — needsMachine, a browser host has no such fetch).",
  contributions: [FileRootLocation(desktopFiles, desktopDir)],
  httpRoutes: {
    [importWallpaperUrl.route]: handleImportUrl,
  },
} satisfies MachinePluginDefinition;
