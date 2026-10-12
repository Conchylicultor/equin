import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { BUILD_RUN_CHIP_SURFACES } from "../core";
import { useBuildRunReferent, useBuildRunTarget } from "./internal/presenter";

export default {
  description:
    "Renders a bare `build-<id>` in a transcript as the generic id chip (`Build <short commit>`) that opens the build's run-detail pane, and presents the build-run id kind to the id registry.",
  contributions: [
    ...idChip({
      presenter: {
        kind: buildRunIdKind,
        icon: symbol("build"),
        useReferent: useBuildRunReferent,
        useTarget: useBuildRunTarget,
      },
      surfaces: BUILD_RUN_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
