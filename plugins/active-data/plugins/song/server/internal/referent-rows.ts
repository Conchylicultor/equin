import { serveCollection } from "@plugins/network/plugins/live/server";
import { followedReferent } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { songChipReferents } from "../../core";

/** `song-chip.referents` over the `sonata_songs` table: its `id` and `title` columns. */
export const songChipReferentsServed = serveCollection(songChipReferents, {
  from: _songs,
});

/** A live value's read of a `song-…` chip: the song's row, by the key the token names. */
export const songChipLiveRead = followedReferent(songChipReferentsServed, {
  idOf: (token) => songIdKind.key(token),
  referentOf: (row) => ({ found: true, title: row.title }),
});
