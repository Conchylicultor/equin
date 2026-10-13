import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type { WithContributedColumns } from "@plugins/network/plugins/live/core";
import { SongSchema, type SongRow } from "./schemas";

/**
 * The song library: `sonata_songs` as a live collection, read by the library
 * DataView as live key-range pages and by the player one row at
 * a time (`useLiveRow`). No placeholder: a window or row not loaded yet is
 * `loading`, never `[]` / not-found.
 *
 * `contributed: true` — other plugins add columns to every row, which the list
 * sorts and filters by like its own: playback-history's play count and
 * last-played, the MIDI source's track count and file-missing flag. The
 * library names none of them (each contributor declares a `liveColumns` handle
 * in its core and serves it from its server); a row carries them under
 * `$columns`, read through the contributor's handle.
 *
 * `filterable` / `sortable` are what the library's own fields lower to (a
 * field whose id is not its column binds it: `duration` → `durationSec`,
 * `added` → `createdAt`).
 *
 * `columnScope` is the library DataView's id (`defineDataView("sonata.library")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side (`custom.<column id>`).
 */
export const songLibrary = liveCollection("sonata.songs", {
  row: SongSchema,
  id: "id",
  filterable: {
    title: liveText(),
    composer: liveText(),
    source: liveText(),
    durationSec: liveNumber(),
    createdAt: liveInstant(),
  },
  sortable: ["title", "composer", "source", "durationSec", "createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  contributed: true,
  columnScope: "sonata.library",
});

/** A song as the library reads it: its row, plus every contributor's columns (`$columns`). */
export type Song = WithContributedColumns<SongRow>;
