import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { archiveBarn } from "../core";

export default {
  description:
    "The File Explorer's building on Isle: the archive barn, its doors open on shelves of boxes and scrolls.",
  contributions: [
    Isle.Building({ app: fileExplorerApp, building: archiveBarn }),
  ],
} satisfies PluginDefinition;
