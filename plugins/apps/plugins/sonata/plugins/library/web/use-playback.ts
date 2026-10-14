import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useLoadDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { Library } from "./slots";
import { hydrateSources } from "./hydrate-sources";
import { openSongImperative } from "./open-song";

/**
 * Background playback for the library: play a song in place (no navigation) by
 * hydrating every registered source's raw, loading it into the surface's player
 * (`useLoadDocument` — which makes it the app's `currentSongId`), then arming
 * `requestPlayOnLoad` so playback starts as soon as the recomposed score is ready. Because the player
 * scope (and with it the audio engine) is mounted above the pane router, the
 * song keeps playing while the user stays on the gallery/table.
 *
 * `togglePlaySong` is play/pause-aware: clicking the already-current song
 * toggles it (resume/pause from the live cursor, no reload); clicking a
 * different song loads + auto-plays it from the top. Stable identity
 * (`useEventCallback`) so it can be passed to memoized rows; the returned
 * `currentSongId`/`isPlaying` are reactive so callers re-render their icon.
 */
export function useSonataPlayback(): {
  togglePlaySong: (song: { id: string; title: string }) => void;
  currentSongId: string | null;
  isPlaying: boolean;
} {
  const { currentSongId } = useSonataApp();
  const { isPlaying, requestPlayOnLoad, play, stop } = useSession();
  const loadDocument = useLoadDocument();
  const sources = Library.Source.useContributions();

  const togglePlaySong = useEventCallback(
    (song: { id: string; title: string }) => {
      if (currentSongId === song.id) {
        if (isPlaying) stop();
        else play();
        return;
      }
      void (async () => {
        const { rawMap, pending } = await hydrateSources(sources, song.id);
        // A source still preparing this song: open the pane (which renders its
        // Body) rather than play a score composed without it.
        if (pending.length > 0) {
          openSongImperative(song);
          return;
        }
        loadDocument({ kind: "library", songId: song.id }, rawMap);
        requestPlayOnLoad();
      })();
    },
  );

  return { togglePlaySong, currentSongId, isPlaying };
}
