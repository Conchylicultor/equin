import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { readPrototypeTitle } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { PROTOTYPE_CHIP_SURFACES } from "../core";

export default {
  description:
    "The prototype id chip's server half (idChipServer): resolves a `proto-<id>` to its prototype's title for the id registry and for model-read text (so a task description holding the id is titled after the mock), and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    ...idChipServer({
      kind: protoIdKind,
      // Prototypes live on disk (the host-global prototypes dir), not in Postgres.
      tables: [],
      surfaces: PROTOTYPE_CHIP_SURFACES,
      resolve: readPrototypeTitle,
    }),
  ],
} satisfies ServerPluginDefinition;
