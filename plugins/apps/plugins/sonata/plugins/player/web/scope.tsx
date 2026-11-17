import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CursorStoreProvider,
  PlaybackSession,
  SonataSession,
  sessionRelays,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  SongDocumentProvider,
  SongSettingsMount,
  documentRelays,
  songIdentityKey,
  useSongDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  useForegroundMusic,
  useMusicSource,
} from "@plugins/music/plugins/background/web";
import {
  KeepScopeAt,
  useKeepScope,
} from "@plugins/primitives/plugins/kept-state/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  RelayCapture,
  RelayProvide,
  type RelayLink,
} from "@plugins/primitives/plugins/scope/plugins/context-relay/web";
import { useRenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { SonataPlayer } from "./slots";
import { PlayerViewProvider, usePlayerView } from "./view";
import {
  attachInstance,
  detachInstance,
  dropBackground,
  instanceLink,
  registerControls,
  type MusicHand,
} from "./internal/instances";
import { useIsBackground } from "./instance-music";

/** The background music service's name for Sonata's music. */
export const SONATA_MUSIC_SOURCE = "sonata";

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
 * Two halves: the PLAYBACK (everything up to the session's effects) and the
 * VIEW (the player view and what the host renders). Without `instance` both
 * live here, and the song ends with the scope (a file preview). With
 * `instance` the playback is a page-level instance (`internal/instances.ts`)
 * raised at this place's render origin and the view attaches to it, its
 * contexts relayed (`context-relay`), so the song outlives the view.
 *
 * The stores wrap from the OUTSIDE because the components below read them in
 * their own bodies (the session writes the cursor; the document composer reads
 * the loaded song) — a component cannot use a store its own JSX provides.
 */
export function SonataPlayerScope({
  instance,
  effects = null,
  children,
}: {
  /**
   * Makes the playback outlive the view: the place it belongs to (the tab the
   * Sonata app renders in) — a view coming back there finds the same
   * playback, at the same place, still playing.
   */
  instance?: string;
  /** Effects that run with the playback, wherever it is (the app's effects that must follow the song). */
  effects?: ReactNode;
  children: ReactNode;
}) {
  if (instance !== undefined) {
    return (
      <AttachedView instanceKey={instance} effects={effects}>
        {children}
      </AttachedView>
    );
  }
  return (
    <Playback instanceKey={null} effects={effects}>
      <ViewHalf>{children}</ViewHalf>
    </Playback>
  );
}

/** The view half: the player view, its shown effects, and the host's children. */
function ViewHalf({ children }: { children: ReactNode }) {
  return (
    <PlayerViewProvider>
      {children}
      <ShownEffects />
    </PlayerViewProvider>
  );
}

/** Which playback instance the calling code runs in (`null`: a local scope). */
const InstanceKeyContext = createContext<string | null>(null);

/** The playback half, with `children` inside its session. */
function Playback({
  instanceKey,
  effects,
  children,
}: {
  instanceKey: string | null;
  effects: ReactNode;
  children: ReactNode;
}) {
  return (
    <CursorStoreProvider>
      <SongDocumentProvider>
        <DocumentSession>
          <InstanceKeyContext.Provider value={instanceKey}>
            {children}
            <SonataSession.Effect.Mount />
            <SongSettingsMount />
            <MusicLink instanceKey={instanceKey} />
            {effects}
          </InstanceKeyContext.Provider>
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

/** Every context the view reads from the playback, relayed to it. */
function CaptureForView({ link }: { link: RelayLink }) {
  const wrappers = SonataSession.Provider.useContributions();
  const relays = [
    ...sessionRelays,
    ...documentRelays,
    ...wrappers.flatMap((w) => w.relays),
  ];
  return <RelayCapture link={link} relays={relays} />;
}

/**
 * A view attached to its playback instance: raises the instance at this
 * place's render origin (under this place's keep scope, so its kept playhead
 * and tempo stay this place's), and renders the view inside the instance's
 * relayed contexts — a loading state until it first captured them.
 */
function AttachedView({
  instanceKey: key,
  effects,
  children,
}: {
  instanceKey: string;
  effects: ReactNode;
  children: ReactNode;
}) {
  const origin = useRenderOrigin();
  const keepPath = useKeepScope();
  const music = useMusicSource(SONATA_MUSIC_SOURCE, { shown: false });
  const musicRef = useLatestRef<MusicHand>(music);
  const effectsRef = useLatestRef(effects);
  const [link, setLink] = useState(() => instanceLink(key));

  useLayoutEffect(() => {
    const hand: MusicHand = {
      adopt: () => musicRef.current.adopt(),
      release: () => musicRef.current.release(),
    };
    const attached = attachInstance(
      key,
      (into, onGone) =>
        origin.raise(
          <KeepScopeAt path={keepPath}>
            <Playback instanceKey={key} effects={effectsRef.current}>
              <CaptureForView link={into} />
            </Playback>
          </KeepScopeAt>,
          { onGone },
        ),
      hand,
    );
    setLink(attached);
    return () => detachInstance(key, hand);
  }, [key, origin, keepPath]);

  return (
    <RelayProvide link={link} fallback={<Loading variant="spinner" />}>
      <ViewHalf>{children}</ViewHalf>
    </RelayProvide>
  );
}

/**
 * The playback's place in the background music service:
 *
 *  - in front (a local scope, or an instance a view shows), a song starting
 *    is real music — it pauses the service's music nobody sees, and every
 *    other browser tab's (`useForegroundMusic`); music beside it on the
 *    desktop mixes;
 *  - as the page's background instance, it is what the service plays: the
 *    service drives it (`setBackgroundPlaying`, from the music button, or
 *    another tab starting music), it tells the service when it stops or
 *    starts on its own (a song's end), and it goes once the service no
 *    longer holds it.
 */
function MusicLink({ instanceKey }: { instanceKey: string | null }) {
  const { isPlaying, play, stop } = useSession();
  const background = useIsBackground(instanceKey);
  const music = useMusicSource(SONATA_MUSIC_SOURCE, { shown: false });
  useForegroundMusic(isPlaying && !background);

  const isPlayingRef = useLatestRef(isPlaying);
  const playRef = useLatestRef(play);
  const stopRef = useLatestRef(stop);
  useLayoutEffect(() => {
    if (instanceKey === null) return;
    return registerControls(instanceKey, {
      isPlaying: () => isPlayingRef.current,
      setPlaying: (next) => {
        if (next && !isPlayingRef.current) playRef.current();
        if (!next && isPlayingRef.current) stopRef.current();
      },
    });
  }, [instanceKey]);

  // The song stopped or started on its own while in the background: the
  // service follows (edge-triggered, so the two never fight).
  const wasPlaying = useRef(isPlaying);
  const musicRef = useLatestRef(music);
  useEffect(() => {
    if (wasPlaying.current === isPlaying) return;
    wasPlaying.current = isPlaying;
    if (!background) return;
    if (isPlaying) musicRef.current.resume();
    else musicRef.current.pause();
  }, [isPlaying, background]);

  // The service let go (stopped, another source played): the instance goes.
  const isCurrent = music.isCurrent;
  useEffect(() => {
    if (instanceKey !== null && background && !isCurrent) {
      dropBackground(instanceKey);
    }
  }, [instanceKey, background, isCurrent]);
  return null;
}

/**
 * The playback instance the calling code runs in, `null` in a local scope —
 * for an app effect that publishes about its instance (its song's title).
 */
export function usePlaybackInstanceKey(): string | null {
  return useContext(InstanceKeyContext);
}
