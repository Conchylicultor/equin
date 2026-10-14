import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

/**
 * One song's playback rollup. Mutable usage data written by the player (not the
 * library): how many times the song has been played and when it was last played.
 * `lastPlayedAt` is a `Date` on both sides (the date field's schema decodes the
 * JSON ISO string back into one). Stored in the `sonata_songs_ext_playback`
 * entity-extension table, which `server/internal/tables.ts` builds from this
 * shape.
 *
 * Both are EXPOSED to every list of songs (the library): each sorts and
 * filters server-side ("Most played", "Recently played", "Unplayed").
 * `playCount` declares its default (0, the column's too), so a never-played
 * song reads 0; `lastPlayedAt` has none, so it reads null until the first play.
 */
export const playbackHistoryShape = defineExtensionShape({
  key: "songId",
  fields: {
    playCount: intField({ label: "Plays", default: 0 }),
    lastPlayedAt: nullable(dateField({ label: "Last played" })),
  },
  exposes: {
    parent: songsEntityRef,
    name: "playback",
    fields: { playCount: {}, lastPlayedAt: {} },
  },
});
