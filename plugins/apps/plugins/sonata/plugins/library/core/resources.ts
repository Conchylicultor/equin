import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { songsEntityRef } from "./schemas";

/**
 * The song library: `sonata_songs` as a live collection, read by the library
 * DataView as live key-range pages and by the player one row at
 * a time (`useLiveRow`). No placeholder: a window or row not loaded yet is
 * `loading`, never `[]` / not-found.
 *
 * Declared by FIELDS: the list's fields are the songs entity's (`pick`) and
 * two of its columns under the ids the library's saved views name them by
 * (`duration` → `durationSec`, `added` → `createdAt`, bound by the server).
 * Every field another plugin's extension EXPOSES on the songs entity folds in
 * too — playback-history's play count and last-played, the MIDI source's
 * track count and file-missing flag — sorted and filtered like the library's
 * own; the library names none of them.
 *
 * `columnScope` is the library DataView's id (`defineDataView("sonata.library")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side (`custom.<column id>`).
 */
export const songLibrary = liveCollection("sonata.songs", {
  from: songsEntityRef,
  pick: ["title", "composer", "source"],
  fields: {
    duration: floatField({ label: "Length" }),
    added: dateField({ label: "Added" }),
  },
  carry: { pick: ["id"] },
  id: "id",
  sortable: ["title", "composer", "source", "duration", "added"],
  default: { orderBy: [["added", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: "sonata.library",
});

/** A song as the library reads it: its row, plus every exposed field (`$columns`). */
export type Song =
  typeof songLibrary extends LiveRowsCollection<infer R> ? R : never;
