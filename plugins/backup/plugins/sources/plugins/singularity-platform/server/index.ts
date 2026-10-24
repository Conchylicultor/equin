import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { BackupSource } from "@plugins/backup/server";
import { singularityPlatformSourceConfig } from "../shared/config";
import { assembleSingularityPlatform } from "./internal/assemble-singularity-platform";

export default {
  description:
    "Backs up equin platform files (auth, database config) into the backup archive.",
  contributions: [
    ConfigV2.Register({ descriptor: singularityPlatformSourceConfig }),
    BackupSource({
      id: "singularity-platform",
      name: "equin platform",
      assemble: assembleSingularityPlatform,
    }),
  ],
} satisfies ServerPluginDefinition;
