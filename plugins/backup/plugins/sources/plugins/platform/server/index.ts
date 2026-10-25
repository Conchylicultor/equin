import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { BackupSource } from "@plugins/backup/server";
import { PLATFORM_SOURCE_ID, platformSourceConfig } from "../shared/config";
import { assemblePlatform } from "./internal/assemble-platform";

export default {
  description:
    "Backs up equin platform files (auth, database config) into the backup archive.",
  contributions: [
    ConfigV2.Register({ descriptor: platformSourceConfig }),
    BackupSource({
      id: PLATFORM_SOURCE_ID,
      name: "equin platform",
      assemble: assemblePlatform,
    }),
  ],
} satisfies ServerPluginDefinition;
