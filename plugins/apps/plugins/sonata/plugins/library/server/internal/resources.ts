import { serveCollection } from "@plugins/network/plugins/live/server";
import { songLibrary } from "../../core/resources";
import { _songs } from "./tables";

// The song library, served off `sonata_songs`. Its rows reach the songs
// entity, so every extension exposing fields of it (`LiveColumns.Expose` —
// playback-history's plays, the MIDI source's tracks and file-missing flag)
// joins in LEFT, 1:1 on the song id, and its writes refill exactly the songs
// they key — as `value` in a tuple that only projects them, `membership` in
// one that sorts or filters by them.
//
// `duration` and `added` are the library's ids for two columns of the table
// (the ids its saved views name), bound here.
export const songLibraryServed = serveCollection(songLibrary, {
  from: _songs,
  columns: {
    duration: (j) => j.base.durationSec,
    added: (j) => j.base.createdAt,
  },
});
