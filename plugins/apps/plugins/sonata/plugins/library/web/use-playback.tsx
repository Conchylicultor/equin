import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  foldResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useLoadDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import type { SongHydration } from "./hydrate-sources";
import { SongHydrator } from "./song-hydrator";
import { openSongImperative } from "./open-song";

interface SongRef {
  id: string;
  title: string;
}

/** Ask the surface's background-play host to play a song. */
type RequestPlay = (song: SongRef) => void;

const BackgroundPlayContext = createContext<RequestPlay | null>(null);

/**
 * The surface's background-play host, contributed as a `Sonata.Provider` so
 * it wraps the whole Sonata surface (inside its player scope): it owns the ONE
 * pending play (`pendingPlay`) and renders the host that hydrates it, then
 * loads and plays it. A row's Play only asks — so a play in flight survives the
 * row unmounting (scrolled out of the virtual window, a view or filter switch)
 * and finishes for the surface's lifetime. The newest request replaces an
 * older one (the host is keyed by song).
 */
export function BackgroundPlayProvider({ children }: { children: ReactNode }) {
  const [pendingPlay, setPendingPlay] = useState<SongRef | null>(null);
  const settle = useEventCallback(() => setPendingPlay(null));
  return (
    <BackgroundPlayContext.Provider value={setPendingPlay}>
      {children}
      {pendingPlay === null ? null : (
        <PlayWhenHydrated
          key={pendingPlay.id}
          song={pendingPlay}
          onSettled={settle}
        />
      )}
    </BackgroundPlayContext.Provider>
  );
}

/**
 * Background playback for the library: play a song in place (no navigation).
 * `togglePlaySong` asks the surface's {@link BackgroundPlayProvider} for the
 * song, which hydrates every registered source live, then loads it into the
 * surface's player (`useLoadDocument`, which makes it the app's
 * `currentSongId`) and arms `requestPlayOnLoad`, so playback starts as soon
 * as the recomposed score is ready. Because the player scope (and with it the
 * audio engine) is mounted above the pane router, the song keeps playing
 * while the user stays on the gallery/table.
 *
 * `togglePlaySong` is play/pause-aware: clicking the already-current song
 * toggles it (resume/pause from the live cursor, no reload); clicking a
 * different song loads + auto-plays it from the top. Stable identity
 * (`useEventCallback`) so it can be passed to memoized rows; the returned
 * `currentSongId`/`isPlaying` are reactive so callers re-render their icon.
 */
export function useSonataPlayback(): {
  togglePlaySong: (song: SongRef) => void;
  currentSongId: string | null;
  isPlaying: boolean;
} {
  const { currentSongId } = useSonataApp();
  const { isPlaying, play, stop } = useSession();
  const requestPlay = useContext(BackgroundPlayContext);
  if (requestPlay === null) {
    throw new Error(
      "useSonataPlayback must be used within the Sonata surface (BackgroundPlayProvider, a Sonata.Provider)",
    );
  }

  const togglePlaySong = useEventCallback((song: SongRef) => {
    if (currentSongId === song.id) {
      if (isPlaying) stop();
      else play();
      return;
    }
    requestPlay(song);
  });
  return { togglePlaySong, currentSongId, isPlaying };
}

/**
 * Hydrates one asked-for song and acts once: plays it, or — a source still
 * preparing it, or a read that failed — opens its pane, which renders that
 * Body or that failure rather than playing a score composed without it. Waits
 * for the deferred tier first: the sources are a contributed set, most of
 * them deferred, and a song hydrated from part of it would play incomplete.
 */
function PlayWhenHydrated({
  song,
  onSettled,
}: {
  song: SongRef;
  onSettled: () => void;
}): ReactElement | null {
  const deferredComplete = useDeferredLoadComplete();
  if (!deferredComplete) return null;
  return (
    <SongHydrator songId={song.id}>
      {(hydration) => (
        <PlayOnReady song={song} hydration={hydration} onSettled={onSettled} />
      )}
    </SongHydrator>
  );
}

/** What an answered hydration makes the host do. */
type PlayStep =
  { kind: "open" } | { kind: "play"; rawMap: Record<string, unknown> };

function PlayOnReady({
  song,
  hydration,
  onSettled,
}: {
  song: SongRef;
  hydration: ResourceResult<SongHydration>;
  onSettled: () => void;
}): null {
  const loadDocument = useLoadDocument();
  const { requestPlayOnLoad } = useSession();
  // Acts once: the answer may re-render (a live source change) before the
  // host unmounts.
  const actedRef = useRef(false);
  const next = foldResource<ResourceResult<SongHydration>, PlayStep | null>(
    hydration,
    {
      loading: () => null,
      error: () => ({ kind: "open" }),
      // Waiting for the song's own source's content: not an answer yet.
      ready: (h) =>
        h.kind === "awaiting-owner"
          ? null
          : h.pending.length > 0
            ? { kind: "open" }
            : { kind: "play", rawMap: h.rawMap },
    },
  );
  useEffect(() => {
    if (next === null || actedRef.current) return;
    actedRef.current = true;
    onSettled();
    if (next.kind === "open") {
      openSongImperative(song);
      return;
    }
    loadDocument({ kind: "library", songId: song.id }, next.rawMap);
    requestPlayOnLoad();
  }, [next, song, onSettled, loadDocument, requestPlayOnLoad]);
  return null;
}
