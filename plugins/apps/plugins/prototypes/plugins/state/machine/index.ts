import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { adoptLegacyTrashWarmup } from "./internal/legacy-trash";

export default {
  description:
    "Per-instance prototype state, desktop half: (main only) the adoption of the old _trash/<id>/ folders an older delete moved there — each back into the tree, recorded deleted in this instance's DB.",
  register: [adoptLegacyTrashWarmup],
} satisfies MachinePluginDefinition;
