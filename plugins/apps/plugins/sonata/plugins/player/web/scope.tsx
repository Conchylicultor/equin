import type { ReactNode } from "react";
import {
  CursorStoreProvider,
  PlaybackSession,
  SonataSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  SongDocumentProvider,
  SongSettingsMount,
  songIdentityKey,
  useSongDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { SonataPlayer } from "./slots";
import { PlayerViewProvider, usePlayerView } from "./view";

/**
 * The one composition root of a Sonata player — everything a surface needs to
 * load a song and play it, isolated per mount (two Sonata windows, or the app
 * beside a file preview, never share a cursor, a document or a transport):
 *
 *   cursor store > song document > playback session (+ its
 *   `SonataSession.Provider` wrappers) > player view
 *
 * plus the per-session effects (`SonataSession.Effect`: the audio engine, the
 * live player, the metronome) and, for a library song, the per-song setting
 * observers, and — while a `PlayerDisplay` is shown — the per-player
 * `SonataPlayer.Effect`s (the keyboard transport). Load into it with `useLoadDocument()`; compose the parts
 * (`PlayerDisplay`, `PlayerTransport`, `PlayerTime`) inside it.
 *
 * The stores wrap from the OUTSIDE because the components below read them in
 * their own bodies (the session writes the cursor; the document composer reads
 * the loaded song) — a component cannot use a store its own JSX provides.
 */
export function SonataPlayerScope({ children }: { children: ReactNode }) {
  return (
    <CursorStoreProvider>
      <SongDocumentProvider>
        <DocumentSession>
          <PlayerViewProvider>
            {children}
            <SonataSession.Effect.Mount />
            <ShownEffects />
            <SongSettingsMount />
          </PlayerViewProvider>
        </DocumentSession>
      </SongDocumentProvider>
    </CursorStoreProvider>
  );
}

/**
 * The playback session over the loaded document's content, its playhead kept
 * under the loaded song's identity (restored only into that song).
 */
function DocumentSession({ children }: { children: ReactNode }) {
  const { identity, content } = useSongDocument();
  return (
    <PlaybackSession
      content={content}
      keepAs={identity === null ? null : songIdentityKey(identity)}
    >
      {children}
    </PlaybackSession>
  );
}

/** The per-player effects, mounted once while the player is shown. */
export function ShownEffects() {
  const { shown } = usePlayerView();
  return shown ? <SonataPlayer.Effect.Mount /> : null;
}
