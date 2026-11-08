import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import { BUILD_RUN_CHIP_SURFACES } from "../core";
import { resolveBuildRunReferent } from "./internal/referent";

export default {
  description:
    "The build-run id chip's server half (idChipServer): resolves a `build-<id>` to `Build <short commit>` for the id registry and for model-read text.",
  contributions: [
    ...idChipServer({
      kind: buildRunIdKind,
      surfaces: BUILD_RUN_CHIP_SURFACES,
      resolve: resolveBuildRunReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
