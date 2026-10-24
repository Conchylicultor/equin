import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { BackupSource } from "@plugins/backup/server";
import { configSourceConfig } from "../shared/config";
import { assembleConfig } from "./internal/assemble-config";

export default {
  description: "Backs up equin config files into the backup archive.",
  contributions: [
    ConfigV2.Register({ descriptor: configSourceConfig }),
    BackupSource({
      id: "config",
      name: "Config",
      assemble: assembleConfig,
    }),
  ],
} satisfies ServerPluginDefinition;
