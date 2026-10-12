import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PROTOTYPE_CHIP_SURFACES } from "../core";
import { usePrototypeTarget, usePrototypeReferent } from "./internal/presenter";

export default {
  description:
    "Renders raw `proto-<id>` strings inline as clickable chips (the generic id chip: the mock's title) that open the mock in the prototype-detail pane, and presents the prototype id kind to the id registry. Models emit the bare id, no tag wrapping needed.",
  contributions: [
    ...idChip({
      presenter: {
        kind: protoIdKind,
        icon: symbol("dashboard-customize"),
        useReferent: usePrototypeReferent,
        useTarget: usePrototypeTarget,
      },
      surfaces: PROTOTYPE_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
