import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { baIdKind } from "@plugins/conversations/plugins/before-after/core";
import { resolveBeforeAfterReferent } from "@plugins/conversations/plugins/before-after/server";
import { BEFORE_AFTER_CHIP_SURFACES } from "../core";
import {
  beforeAfterChipLiveRead,
  beforeAfterChipReferentsServed,
} from "./internal/referent-rows";

export default {
  description:
    "The before / after pair id chip's server half (idChipServer): resolves a `ba-<id>` to its pair's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    // The chip's referent rows, by id — what a live value showing stored
    // text with its chips as titles follows (`beforeAfterChipLiveRead`).
    ...beforeAfterChipReferentsServed.declare,
    ...idChipServer({
      kind: baIdKind,
      live: beforeAfterChipLiveRead,
      surfaces: BEFORE_AFTER_CHIP_SURFACES,
      resolve: resolveBeforeAfterReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
