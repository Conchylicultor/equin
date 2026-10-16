import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { SONG_CHIP_SURFACES } from "../core";
import { resolveSongReferent } from "./internal/referent";

export default {
  description:
    "The song id chip's server half (idChipServer): resolves a `song-<id>` to the song's title for the id registry and for model-read text, and registers the page-editor inline token so a page block holding the chip stays agent-readable.",
  contributions: [
    ...idChipServer({
      kind: songIdKind,
      tables: [_songs],
      surfaces: SONG_CHIP_SURFACES,
      resolve: resolveSongReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
