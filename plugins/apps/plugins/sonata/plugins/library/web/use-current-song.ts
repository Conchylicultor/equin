import { type LiveRowResult, useLive } from "@plugins/network/plugins/live/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { songLibrary, type Song } from "../core";

/**
 * The canonical row for the song loaded in the app's player — the one the
 * player pane shows, or that plays in the background from the library: one
 * point read of the live `songLibrary` collection. `loading` while it loads,
 * `error` (with the row as last seen, as `stale`) when the read failed;
 * `found: false` when no song is loaded (determinate at once — nothing is
 * read), or the loaded id is no longer a song (deleted). THE read path for the open song's title — the shell context
 * deliberately keeps no copy.
 *
 * Neither `loading` nor `error` is ever collapsed into "no song": callers
 * branch on `status`, so an inline-editable title is only ever seeded from a
 * ready row.
 */
export function useCurrentSong(): LiveRowResult<Song> {
  const { currentSongId } = useSonataApp();
  return useLive(songLibrary, { id: currentSongId });
}
