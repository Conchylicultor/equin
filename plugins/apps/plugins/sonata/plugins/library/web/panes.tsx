import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import {
  Pane,
  PaneChrome,
  PaneHeaderCell,
  type,
  type Hint,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  matchResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  useLibrarySong,
  useLoadDocument,
  useSongDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { barStartBeat } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import {
  PlayerDisplay,
  PlayerDisplayBinding,
  PlayerTransport,
} from "@plugins/apps/plugins/sonata/plugins/player/web";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Glass } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/glass/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { sonataPlayerRoute, songIdKind, songLibrary } from "../core";
import type { SongHydration } from "./hydrate-sources";
import { SongHydrator } from "./song-hydrator";
import { SonataLibrarySurface } from "./components/library-surface";
import { SongTitle } from "./components/song-title-field";
import { SectionDock } from "./components/section-pane";
import { useSectionPaneCollapsed } from "./components/panels-toggle";
import { PlayerHeader } from "./components/player-header";
import { useDockReserve } from "./internal/dock-motion";
import {
  CAPSULE_MARGIN,
  CAPSULE_MAX_WIDTH,
  CAPSULE_TOP,
  PANEL_RESERVE,
  RAIL_RESERVE,
} from "./internal/player-geometry";
import { formatBarParam, parseBarParam } from "./bar-param";

// Panes are declared first so their types are known before the component bodies
// reference them. The component identifiers below are hoisted function
// declarations, so the forward reference is safe at runtime.

/**
 * The library index pane — Sonata's landing surface at bare `/sonata`.
 * `appIndex` marks it as the app's index pane (the empty route resolves here
 * via `useIndexMatch`). Standard chrome with a "Library" title; the
 * `Sonata.Home` gallery owns its scroll inside the chrome's single `PaneScroll`.
 */
export const sonataLibraryPane = Pane.define({
  title: "Library",
  route: defineRoute({ id: "sonata-library", segment: "" }),
  app: sonataApp,
  appIndex: true,
  component: SonataLibraryBody,
});

function SonataLibraryBody(): ReactElement {
  return (
    <PaneChrome pane={sonataLibraryPane} inset="content">
      <SonataLibrarySurface />
    </PaneChrome>
  );
}

/**
 * The player pane at `/sonata/song/:songId;bar;lens` — a real URL that survives
 * reload and back/forward. Both keyed params are views of the song, absent by
 * default: `;bar=12` opens it with the playhead parked at that bar (see
 * {@link SonataPlayerSurface}; build such a link with
 * {@link sonataSongLink}), and `;lens=notation` is the display lens on screen,
 * absent for the default lens — bound to the player by
 * {@link SonataPlayerSurface}. Named rather than positional, so neither can be
 * read as the other: `/sonata/song/<id>;bar=12;lens=notation`. Opened with `mode:"root"` so each open replaces the route
 * with a single full-surface pane (a fresh instance, hence a remount). The
 * optimistic `title` rides in `hint` purely as a DISPLAY value for `title.text`
 * (the browser-tab / tab-strip label before the song's live row settles) —
 * it is NOT a data source: the header title and every consumer read the
 * canonical row from `songLibrary`. The surface hydrates every source for the song,
 * on direct navigation / reload too (see {@link SongLoader}).
 */
export const sonataPlayerPane = Pane.define({
  route: sonataPlayerRoute,
  app: sonataApp,
  // Display-only optimistic label for `title.text` (tab/document title) before the
  // song's row settles. Structurally unwritable: `Hint.pick` hands it back
  // only alongside the canonical value, and it is never persisted. The title is
  // library-owned (`songLibrary`); the shell keeps no mirror.
  hint: type<{ title: string }>(),
  useResolve: useSonataPlayerResolve,
  component: SonataPlayerSurface,
  // Title: `text` (tab/document title) is the canonical song name from its live
  // library row (reflects renames), falling back to the optimistic hint
  // carried at open time while it loads. Self-contained — the player scope
  // is unavailable at the tab-surface level where it runs. The header paints
  // `component` instead: the inline-editable title, mounted inside the pane so
  // it may read app context.
  title: { useText: useSongTitle, component: SongTitle },
  // Main surface: aux panes opened to the right never steal the tab title.
  titleOwner: true,
});

/**
 * The app-rooted link to a library song in the player, optionally at a bar —
 * the one spelling of the player URL for a caller outside the app (a file
 * preview's "Open in Sonata").
 */
export function sonataSongLink(songId: string, bar?: number): string {
  return sonataPlayerRoute.link(
    sonataApp,
    bar === undefined ? { songId } : { songId, bar: formatBarParam(bar) },
  );
}

/** Canonical song title from its live library row, or the optimistic open hint. */
function useSongTitle(
  { songId: songIdParam }: { songId: string },
  hint: Hint<{ title: string }>,
): string | undefined {
  // `key` upgrades a pre-rewrite bare-uuid URL to the stored `song-<uuid>`.
  const song = useLiveRow(songLibrary, songIdKind.key(songIdParam));
  // `canonical` stays `undefined` until the row settles — precisely what
  // `pick` reads as "not known yet", so the hint shows through in the meantime
  // and is superseded the instant the real row (and any rename) arrives. A
  // failed read offers its last-seen row (`stale`), else the hint stays.
  const canonical = foldResource(
    mapRow(song, (row) => row?.title),
    {
      loading: () => undefined,
      error: (_error, stale) => stale,
      ready: (title) => title,
    },
  );
  return hint.pick("title", canonical);
}

/**
 * Resolve hook: gate the pane on the song's row existing. Hydration itself runs
 * in the surface ({@link SongLoader}), which can render what it finds.
 */
function useSonataPlayerResolve({
  songId: songIdParam,
}: {
  songId: string;
  bar?: string;
}): ResolveResult {
  // `key` upgrades an old bare-uuid link (`/sonata/song/<uuid>`, from before
  // the `song-` rewrite) so it resolves.
  return resolveRow(useLiveRow(songLibrary, songIdKind.key(songIdParam)));
}

/**
 * Where the playhead was last placed for a song shown in this pane: by the
 * load intent armed with a load ({@link SongLoader}), or by a direct seek
 * ({@link useBarSeek}). Lets the bar seek tell a bar CHANGE on the loaded song
 * (seek now) from the bar a load already honours.
 */
type PlacedForRef = { current: string | null };

/**
 * A bar change on the song already loaded here (`;bar=3` → `;bar=9` in place)
 * reloads nothing, so no content reset runs to honour a load intent: seek
 * directly. The bar a load armed is already placed (see {@link PlacedForRef}),
 * so this never fights the reset; a URL that drops its bar leaves the playhead
 * where it is. A song opened while already loaded (playing in the background
 * from the library, or reopened from the now-playing bar) seeks to the URL's
 * bar, if it names one.
 */
function useBarSeek(
  songId: string,
  bar: number | undefined,
  hydrated: boolean,
  placedForRef: PlacedForRef,
): void {
  const { seekTo, score } = useSession();
  const { content } = useSongDocument();
  const ready = hydrated && content.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const key = placementKey(songId, bar);
    if (placedForRef.current === key) return;
    placedForRef.current = key;
    if (bar !== undefined) seekTo(barStartBeat(score, bar));
  }, [ready, songId, bar, score, seekTo, placedForRef]);
}

/** Identifies where the playhead was placed for: a song, at a bar or its start. */
function placementKey(songId: string, bar: number | undefined): string {
  return `${songId}@${bar ?? "start"}`;
}

/**
 * Loads a song once every source answered ({@link SongHydrator}), and shows
 * what stands before that: loading, a failed read, or — a source has content
 * for the song that is not ready yet (a transcription still running) — that
 * source's Body, loading NOTHING: never a score composed without it. Mounted
 * only while the song is not the loaded one, so a live source change on a
 * song already loaded (playing) never reloads it: reloading would re-hydrate
 * its sources into a new timeline, and the session's content reset would stop
 * it and rewind to the lead-in. Its document is current (source edits write
 * into it).
 *
 * Opens at the URL's bar: armed in the same turn as the load, so the
 * session's content reset — which parks the playhead at the timeline origin
 * otherwise — parks it at the bar instead. The bar's beat is read off the NEW
 * score (its meter map), which only the reset has.
 */
function SongLoader({
  songId,
  bar,
  hydration,
  placedForRef,
}: {
  songId: string;
  bar: number | undefined;
  hydration: ResourceResult<SongHydration>;
  placedForRef: PlacedForRef;
}): ReactNode {
  const loadDocument = useLoadDocument();
  const { requestSeekOnLoad } = useSession();
  const barRef = useLatestRef(bar);
  // One load per mount: the loader unmounts once the document is this song,
  // and a re-render before that (the seek intent's own state) must not load
  // it a second time.
  const loadedRef = useRef(false);
  const ready = foldResource(hydration, {
    loading: () => null,
    error: () => null,
    ready: (h) =>
      h.kind === "hydrated" && h.pending.length === 0 ? h.rawMap : null,
  });
  useEffect(() => {
    if (ready === null || loadedRef.current) return;
    loadedRef.current = true;
    const target = barRef.current;
    if (target !== undefined) {
      requestSeekOnLoad((loaded) => barStartBeat(loaded, target));
    }
    placedForRef.current = placementKey(songId, target);
    // The song id travels WITH its content: loading it hands the song's
    // settings over in the same write (see `useLoadDocument`).
    loadDocument({ kind: "library", songId }, ready);
  }, [ready, songId, loadDocument, requestSeekOnLoad, barRef, placedForRef]);

  return matchResource(hydration, {
    loading: () => <Loading />,
    error: (error) => (
      <PaneChrome pane={sonataPlayerPane}>
        <Inset pad="lg">
          <ResourceErrorInline
            error={error}
            refetch={hydration.refetch}
            variant="block"
          />
        </Inset>
      </PaneChrome>
    ),
    ready: (h) =>
      // Loading into the player (the pane swaps to it once the document is
      // this song's), or waiting for the song's own source's content.
      h.kind === "awaiting-owner" || h.pending.length === 0 ? (
        <Loading />
      ) : (
        // A source is still preparing this song: show its Body in place of
        // the player, so an unfinished song is never mistaken for an empty
        // score. The song loads once the source is ready (its read changes).
        <PaneChrome pane={sonataPlayerPane}>
          <Inset pad="lg">
            <Stack direction="col" gap="lg">
              {h.pending.map(({ sourceId, label, Body }) => (
                <Stack key={sourceId} direction="col" gap="sm">
                  <Text variant="label" tone="muted">
                    {label}
                  </Text>
                  <Body songId={songId} />
                </Stack>
              ))}
            </Stack>
          </Inset>
        </PaneChrome>
      ),
  });
}

/**
 * The player surface: until the song is the loaded one, its hydration
 * ({@link SongLoader}); once it is, the immersive player ({@link
 * ImmersivePlayer}) bound to the URL's display lens. The toolbar's controls
 * (the display switcher, the speed wheel, metronome, transpose, volume, the
 * spread wheel, full screen) are contributions to `sonataPlayerPane.Actions`
 * — where each lands in the pill is the slot's reorder config.
 *
 * Also places the playhead at the URL's `;bar`: with the load, or — when only
 * the bar changed on the song already loaded — by a direct seek. A malformed
 * bar value is no bar ({@link parseBarParam}); a bar past the song's end
 * clamps to its last bar.
 */
function SonataPlayerSurface(): ReactElement {
  const params = sonataPlayerPane.useParams();
  const setParams = sonataPlayerPane.useSetParams();
  // The URL's id as stored: `key` upgrades an old bare-uuid link
  // (`/sonata/song/<uuid>`, from before the `song-` rewrite) so it resolves.
  const songId = songIdKind.key(params.songId);
  const bar = parseBarParam(params.bar);
  const loadedSong = useLibrarySong();
  // Hydrated exactly when the loaded document is this song: after its load,
  // or at once for a song already loaded. Another song still loaded while
  // this one hydrates is not this song's content.
  const hydrated =
    loadedSong.kind === "library" && loadedSong.songId === songId;
  // The sources are an open contributed set, and most of them load in the
  // deferred tier: hydrating before that tier settles reads an incomplete
  // set, and the loaded song then never re-hydrates (a loaded song is kept).
  // So a deep link waits for the tier, as any reader of a contributed set
  // does.
  const deferredComplete = useDeferredLoadComplete();
  const placedForRef = useRef<string | null>(null);
  useBarSeek(songId, bar, hydrated, placedForRef);

  if (!hydrated) {
    if (!deferredComplete) return <Loading />;
    return (
      <SongHydrator songId={songId}>
        {(hydration) => (
          <SongLoader
            songId={songId}
            bar={bar}
            hydration={hydration}
            placedForRef={placedForRef}
          />
        )}
      </SongHydrator>
    );
  }
  return (
    // The display lens lives in the URL's `;lens`: the binding wraps the whole
    // surface, so the header's picker and the body's display both read and
    // write it. A pick rewrites the address in place (no remount); the default
    // lens drops the key so the bare song URL stays the canonical one.
    <PlayerDisplayBinding
      displayId={params.lens ?? null}
      onDisplayChange={(lens) =>
        setParams({
          songId,
          ...(params.bar !== undefined && { bar: params.bar }),
          ...(lens !== null && { lens }),
        })
      }
    >
      <ImmersivePlayer />
    </PlayerDisplayBinding>
  );
}

/**
 * The immersive player: the active display fills the window and everything
 * else floats over it — the header band (back, the title, the toolbar pill),
 * the progression capsule centred over the notes, and the section dock at the
 * right edge. Only the dock takes room: the display's content (and the
 * capsule) keep to the part of the window the dock leaves — the rail's narrow
 * strip, or the open panel's width — so the panel sits beside the notes, never
 * over them. The display itself gets the whole window as its `cover`d box, so
 * a bleeding display's ground (the roll's grid) runs under the dock.
 *
 * The pane draws its own header (`PlayerHeader`) in place of `PaneChrome`'s
 * bar, because its top chrome is not a row above the body but a band floating
 * over it.
 */
function ImmersivePlayer() {
  const [collapsed] = useSectionPaneCollapsed();
  // Eased on the dock's clock, so the notes (and the capsule over them) give
  // way as the panel unfolds instead of jumping.
  const right = useDockReserve(collapsed ? RAIL_RESERVE : PANEL_RESERVE);
  return (
    <Clip className="relative isolate h-full bg-background text-foreground">
      {/* The whole window: a display that bleeds (the piano roll) runs its
          ground and grid under the dock, keeping its notes beside it. */}
      <Placed x="fill" y="fill">
        {/* A column, so the display's filling clip takes the whole height. */}
        <Stack gap="none" className="h-full">
          <PlayerDisplay cover={{ right }} />
        </Stack>
      </Placed>

      <Placed x="fill" y={{ start: 0 }} layer="float">
        <PlayerHeader
          tools={
            <sonataPlayerPane.Actions.Render controlSize="lg">
              {(item) => <PaneHeaderCell {...item} />}
            </sonataPlayerPane.Actions.Render>
          }
        />
      </Placed>

      {/* The progression: play, the timeline, the loop — centred over the
          notes, as wide as they allow up to its max. */}
      <Placed
        x={{
          center: `calc((100% - ${right}px) / 2)`,
          size: `min(${CAPSULE_MAX_WIDTH}px, calc(100% - ${right + 2 * CAPSULE_MARGIN}px))`,
        }}
        y={{ start: CAPSULE_TOP }}
        layer="float"
      >
        <Glass tint="deep">
          <PlayerTransport variant="capsule" />
        </Glass>
      </Placed>

      <SectionDock />
    </Clip>
  );
}
