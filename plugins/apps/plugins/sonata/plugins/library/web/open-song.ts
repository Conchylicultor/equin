import { useCallback } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { sonataPlayerPane } from "./panes";
import { requestPlayOnOpen } from "./play-on-open";

/** Open a song into the player, starting it — bound where it was made ({@link useOpenSong}). */
export type OpenSong = (song: { id: string; title: string }) => void;

/**
 * The imperative counterpart to {@link useSongLink}: an opener for a song,
 * bound to the surface the calling component renders in, for an open with no
 * control to spread a link onto — a source's create affordance once its song
 * is made (handed it as `SourceContext.openSong`), a dialog that imports one,
 * the background-play host when a song cannot play in place. Mirrors
 * `useSongLink`'s open: `mode: "root"` replaces the route with the player, the
 * optimistic title rides in the hint, and the song starts playing once it
 * loads.
 *
 * A hook, never a free function: bound here, the open lands in the tab set the
 * caller is in — inside an embedded app (the website's live demo) that is the
 * embed's, where a free open would have driven the page around it.
 */
export function useOpenSong(): OpenSong {
  const openPane = useOpenPane();
  return useCallback(
    (song) => {
      requestPlayOnOpen(song.id);
      openPane(
        sonataPlayerPane,
        { songId: song.id },
        { mode: "root", hint: { title: song.title } },
      );
    },
    [openPane],
  );
}
