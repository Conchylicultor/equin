import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { SONG_CHIP_SURFACES } from "../core";
import {
  songChipLiveRead,
  songChipReferentsServed,
} from "./internal/referent-rows";
import { resolveSongReferent } from "./internal/referent";

export default {
  description:
    "The song id chip's server half (idChipServer): resolves a `song-<id>` to the song's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    // The chip's referent rows, by id — what a live value showing stored
    // text with its chips as titles follows (`songChipLiveRead`).
    ...songChipReferentsServed.declare,
    ...idChipServer({
      kind: songIdKind,
      live: songChipLiveRead,
      surfaces: SONG_CHIP_SURFACES,
      resolve: resolveSongReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
