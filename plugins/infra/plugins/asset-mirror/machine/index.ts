import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { FileRootLocation } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import { assetMirrorCache } from "../data-dirs";
import { assetMirrorFiles } from "../server";

export default {
  description:
    "The asset mirror, desktop half: binds the assetMirrorFiles root to the machine-wide cache on this computer (cache/asset-mirror), the directory a release bundle seeds.",
  contributions: [FileRootLocation(assetMirrorFiles, assetMirrorCache)],
} satisfies MachinePluginDefinition;
