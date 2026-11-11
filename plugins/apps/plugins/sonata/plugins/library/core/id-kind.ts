import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * A library song (`sonata_songs.id`), declared once (`plugins/ids`).
 *
 * - Minted `song-<epochSeconds>-<6>` by `createSongRow`.
 * - `legacyBareUuid`: songs used to be bare uuids; a data migration prefixed
 *   every stored row (`song-<uuid>`), and `parse` / `schema` / `key` upgrade a
 *   bare uuid from an old URL (`/sonata/song/<uuid>`) to the rewritten id.
 * - `seed` is the bundled starters' namespace (`seed-bach-prelude-c-major`, owned by the
 *   MIDI source's seeder). Those ids are fixed natural keys — never minted,
 *   never rewritten — so `seed` is declared as an alias to reserve the prefix.
 */
export const songIdKind = defineIdKind({
  prefix: "song",
  label: "Song",
  aliases: ["seed"],
  legacyBareUuid: true,
});

export type SongId = IdOf<typeof songIdKind>;
