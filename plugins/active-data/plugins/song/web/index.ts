import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { SONG_CHIP_SURFACES } from "../core";
import { useSongTarget, useSongReferent } from "./internal/presenter";

export default {
  description:
    "Renders a bare `song-<id>` in a transcript or a page as the generic id chip (the song's title) that opens it in Sonata's player, and presents the song id kind to the id registry.",
  contributions: [
    ...idChip({
      presenter: {
        kind: songIdKind,
        icon: symbol("music-note"),
        useReferent: useSongReferent,
        useTarget: useSongTarget,
      },
      surfaces: SONG_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
