import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  PlayerDisplay,
  PlayerTransport,
  SonataPlayerScope,
  usePlayerView,
} from "@plugins/apps/plugins/sonata/plugins/player/web";
import {
  useLoadDocument,
  useSongDocument,
  type SongIdentity,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

/** The header band's height: what a host's `header` is laid out in. */
export const MINI_PLAYER_HEADER_HEIGHT = 54;
/** The capsule's inset from the box's edges (and from the header band). */
const CAPSULE_INSET = 12;

/**
 * One song in a player of its own — the immersive player scaled down, in
 * Sonata's theme wherever it is hosted (a Files preview, a column beside a
 * conversation): the falling notes fill the box, `header` (if any) floats over
 * their top, and the progression capsule floats in glass under it.
 *
 * Its own `SonataPlayerScope` (keyed per song), so it never shares a cursor or
 * a transport with an open Sonata window. The document is `identity` with its
 * sources' raws: a `file` document persists nothing (every per-song setting
 * reads its default); a `library` one is the song itself, its settings
 * included.
 *
 * `header` is drawn INSIDE the scope, so a control in it (speed, volume) reads
 * and drives this player. So are `children`, which take no place in its
 * layout: a portal into the host's chrome (the Files header's Open in Sonata,
 * which reads the playhead's bar).
 */
export function SonataMiniPlayer({
  identity,
  rawById,
  header,
  children,
}: {
  identity: SongIdentity;
  rawById: Readonly<Record<string, unknown>>;
  header?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  const key =
    identity.kind === "library"
      ? `library:${identity.songId}`
      : `file:${identity.key}`;
  return (
    <Theme
      name={appThemeScope(sonataApp.id)}
      surface="canvas"
      className="h-full"
    >
      {/* One player per song: another song is a fresh player — drawn, played
          and loading afresh — never this one's state carried over. */}
      <SonataPlayerScope key={key}>
        <MiniPlayerBody identity={identity} rawById={rawById} header={header} />
        {children}
      </SonataPlayerScope>
    </Theme>
  );
}

/**
 * Loads the document, and shows ONE loading state until the display has drawn
 * (`usePlayerView().drawn` — its code, its settings and its canvas are all
 * in), only then revealing the notes, the header and the capsule together and
 * starting playback. Laid out (transparent, inert) meanwhile, so the display
 * mounts, measures and draws behind it.
 */
function MiniPlayerBody({
  identity,
  rawById,
  header,
}: {
  identity: SongIdentity;
  rawById: Readonly<Record<string, unknown>>;
  header: ReactNode;
}) {
  const loadDocument = useLoadDocument();
  const { play } = useSession();
  const { drawn } = usePlayerView();
  // One load per player: the scope is keyed per song, and a re-render (a
  // caller building `identity` inline, a hydration re-read) must not reload it.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadDocument(identity, rawById);
  }, [loadDocument, identity, rawById]);

  // Opening a song plays it — once there is something to see play, never
  // under the loading state (the transport would read as playing over an
  // empty body, and the song's lead-in would run out behind it). Once: a
  // display re-drawing does not restart it (the scope is keyed per song). A
  // layout effect, so the reveal and the playing transport paint in the same
  // frame — a passive one lands after whatever work the reveal starts.
  const playedRef = useRef(false);
  useLayoutEffect(() => {
    if (!drawn || playedRef.current) return;
    playedRef.current = true;
    play();
  }, [drawn, play]);

  const { content } = useSongDocument();
  if (content.kind === "failed") {
    return (
      <Placeholder tone="error">
        Failed to compose the song: {String(content.failure.error)}
      </Placeholder>
    );
  }
  return (
    <Overlay
      fill
      // A floor for a host whose body has no definite height (a pane that
      // scrolls its content).
      className="h-full min-h-96"
      above={
        drawn ? null : (
          <Center axis="both" className="h-full">
            <Loading />
          </Center>
        )
      }
    >
      {content.kind === "ready" ? (
        <Clip
          // Held transparent and inert, not `invisible`: a child's own
          // transition (a button's) would fade visibility back in after the
          // rest, revealing the player by stages.
          className={cn(
            "relative isolate h-full bg-background text-foreground",
            !drawn && "opacity-0",
          )}
          inert={!drawn}
        >
          <Placed x="fill" y="fill">
            {/* A column, so the display's filling clip takes the whole box. */}
            <Stack gap="none" className="h-full">
              <PlayerDisplay displayId="piano-roll" />
            </Stack>
          </Placed>
          {header == null ? null : (
            <>
              {/* The notes fade out under the header band, so its title reads
                  on them without a box around it. */}
              <Placed
                x="fill"
                y={{
                  start: 0,
                  size: MINI_PLAYER_HEADER_HEIGHT + CAPSULE_INSET,
                }}
                layer="float"
              >
                <div
                  aria-hidden
                  className="pointer-events-none h-full bg-linear-to-b from-background from-30% to-transparent"
                />
              </Placed>
              <Placed
                x="fill"
                y={{ start: 0, size: MINI_PLAYER_HEADER_HEIGHT }}
                layer="float"
              >
                {header}
              </Placed>
            </>
          )}
          <Placed
            x={{ start: CAPSULE_INSET, end: CAPSULE_INSET }}
            y={{
              start:
                header == null
                  ? CAPSULE_INSET
                  : MINI_PLAYER_HEADER_HEIGHT + CAPSULE_INSET / 3,
            }}
            layer="float"
          >
            <Glass tint="deep">
              <PlayerTransport variant="capsule" />
            </Glass>
          </Placed>
        </Clip>
      ) : null}
    </Overlay>
  );
}
