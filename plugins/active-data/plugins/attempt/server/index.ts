import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { attemptIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { ATTEMPT_CHIP_SURFACES } from "../core";
import {
  attemptChipLiveRead,
  attemptChipReferentsServed,
} from "./internal/referent-rows";
import { resolveAttemptReferent } from "./internal/referent";

export default {
  description:
    "The attempt id chip's server half (idChipServer): resolves an `att-<id>` to its task's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    // The chip's referent rows, by id — what a live value showing stored
    // text with its chips as titles follows (`attemptChipLiveRead`).
    ...attemptChipReferentsServed.declare,
    ...idChipServer({
      kind: attemptIdKind,
      live: attemptChipLiveRead,
      surfaces: ATTEMPT_CHIP_SURFACES,
      resolve: resolveAttemptReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
