import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { fileExplorerDir } from "@plugins/apps/plugins/file-explorer/data-dirs";
import { documentsFiles } from "../server";

export default {
  description:
    "Documents, desktop half: binds the documentsFiles root to Files' data dir on this computer (apps/file-explorer).",
  contributions: [FileRootLocation(documentsFiles, fileExplorerDir)],
} satisfies MachinePluginDefinition;
