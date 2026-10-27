import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { prototypesDir } from "../data-dirs";
import { prototypesFiles } from "../server";

export default {
  description:
    "Prototypes, desktop half: binds the prototypesFiles root to the app's data dir on this computer (apps/prototypes).",
  contributions: [FileRootLocation(prototypesFiles, prototypesDir)],
} satisfies MachinePluginDefinition;
