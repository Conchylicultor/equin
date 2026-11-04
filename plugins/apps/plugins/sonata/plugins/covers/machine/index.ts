import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { scoreCoverCacheDir } from "../data-dirs";
import { scoreCoverFiles } from "../server";

export default {
  description:
    "Sonata covers, desktop half: binds the scoreCoverFiles root to the host-global cover cache on this computer (cache/sonata-covers).",
  contributions: [FileRootLocation(scoreCoverFiles, scoreCoverCacheDir)],
} satisfies MachinePluginDefinition;
