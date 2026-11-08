import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { eventSourceIdKind } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { EVENT_SOURCE_CHIP_SURFACES } from "../core";
import { resolveEventSourceReferent } from "./internal/referent";

export default {
  description:
    "The event-source id chip's server half (idChipServer): resolves an `evs-<id>` to the source's name for the id registry and for model-read text.",
  contributions: [
    ...idChipServer({
      kind: eventSourceIdKind,
      surfaces: EVENT_SOURCE_CHIP_SURFACES,
      resolve: resolveEventSourceReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
