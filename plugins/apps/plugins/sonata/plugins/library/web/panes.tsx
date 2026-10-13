import { type ReactElement, useEffect, useRef } from "react";
import {
  Pane,
  PaneChrome,
  type,
  type Hint,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
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
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { sonataPlayerRoute, songIdKind, songLibrary } from "../core";
import { Library } from "./slots";
import { SonataLibrarySurface } from "./components/library-surface";
import { SongTitle } from "./components/song-title-field";
import { SectionPane } from "./components/section-pane";
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
    <PaneChrome pane={sonataLibraryPane}>
      <SonataLibrarySurface />
    </PaneChrome>
  );
}

/**
 * The player pane at `/sonata/song/:songId;bar;view` — a real URL that survives
 * reload and back/forward. Both keyed params are views of the song, absent by
 * default: `;bar=12` opens it with the playhead parked at that bar (see
 * {@link useSonataPlayerResolve}; build such a link with
 * {@link sonataSongLink}), and `;view=notation` is the display lens on screen,
 * absent for the default lens — bound to the player by
 * {@link SonataPlayerSurface}. Named rather than positional, so neither can be
 * read as the other: `/sonata/song/<id>;bar=12;view=notation`. Opened with `mode:"root"` so each open replaces the route
 * with a single full-surface pane (a fresh instance, hence a remount). The
 * optimistic `title` rides in `hint` purely as a DISPLAY value for `title.text`
 * (the browser-tab / tab-strip label before the song's live row settles) —
 * it is NOT a data source: the header title and every consumer read the
 * canonical row from `songLibrary`. `useResolve` hydrates every source for the song on
 * direct navigation / reload (see {@link useSonataPlayerResolve}).
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
 * Resolve hook: hydrate every registered source's raw for `songId` and gate the
 * pane on the song existing. Lifted out of `useSongLink` so hydration also runs
 * on direct navigation / reload (a deep-linked `/sonata/song/<id>`), not only on a
 * library click. Source-agnostic: a source with no data for the song returns
 * `undefined` and is skipped.
 *
 * Also places the playhead at the URL's `;bar`: with the load (a seek-on-load
 * intent the session's content reset honours), or — when only the bar changed
 * on the song already loaded — by a direct seek. A malformed bar value is no
 * bar ({@link parseBarParam}); a bar past the song's end clamps to its last bar.
 */
function useSonataPlayerResolve({
  songId: songIdParam,
  bar: barParam,
}: {
  songId: string;
  bar?: string;
}): ResolveResult {
  // The URL's id as stored: `key` upgrades an old bare-uuid link
  // (`/sonata/song/<uuid>`, from before the `song-` rewrite) so it resolves.
  const songId = songIdKind.key(songIdParam);
  const song = useLiveRow(songLibrary, songId);
  const sources = Library.Source.useContributions();
  // The sources are an open contributed set, and most of them load in the
  // deferred tier: hydrating before that tier settles reads an incomplete set,
  // and the loaded song then never re-hydrates (the effect below keeps a song
  // that is already loaded). So a deep link waits for the tier, as any reader
  // of a contributed set does.
  const deferredComplete = useDeferredLoadComplete();
  const loadDocument = useLoadDocument();
  const { requestSeekOnLoad, seekTo, score } = useSession();
  const { content } = useSongDocument();
  const loadedSong = useLibrarySong();
  const loadedSongRef = useLatestRef(loadedSong);
  const bar = parseBarParam(barParam);
  const barRef = useLatestRef(bar);
  // The (song, bar) the playhead was last placed for — by the load intent armed
  // with a load, or by a direct seek. Lets the bar effect below tell a bar
  // CHANGE on the loaded song (seek now) from the bar a load already honours.
  const placedForRef = useRef<string | null>(null);

  useEffect(() => {
    // The song is already loaded — playing in the background from the library,
    // or reopened from the now-playing bar: show it as it is. Reloading would
    // re-hydrate its sources into a new timeline, and the session's content
    // reset would stop it and rewind to the lead-in. Its document is current
    // (source edits write into it), and the bar effect below honours a URL bar.
    const loaded = loadedSongRef.current;
    if (loaded.kind === "library" && loaded.songId === songId) {
      placedForRef.current = placementKey(songId, undefined);
      return;
    }
    if (!deferredComplete) return;
    let cancelled = false;
    void (async () => {
      const rawMap: Record<string, unknown> = {};
      await Promise.all(
        sources.map(async (s) => {
          const raw = await s.hydrate(songId);
          if (raw !== undefined) rawMap[s.sourceId] = raw;
        }),
      );
      if (cancelled) return;
      // Open at the URL's bar: armed in the same turn as the load, so the
      // session's content reset — which parks the playhead at the timeline
      // origin otherwise — parks it at the bar instead. The bar's beat is read
      // off the NEW score (its meter map), which only the reset has.
      const target = barRef.current;
      if (target !== undefined) {
        requestSeekOnLoad((loaded) => barStartBeat(loaded, target));
      }
      placedForRef.current = placementKey(songId, target);
      // The song id travels WITH its content: loading it hands the song's
      // settings over in the same write (see `useLoadDocument`).
      loadDocument({ kind: "library", songId }, rawMap);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    songId,
    sources,
    deferredComplete,
    loadDocument,
    requestSeekOnLoad,
    barRef,
    loadedSongRef,
  ]);

  // Hydrated exactly when the loaded document is this song: after the load
  // above, or at once for a song already loaded. Another song still loaded
  // while this one hydrates is not this song's content.
  const hydrated =
    loadedSong.kind === "library" && loadedSong.songId === songId;
  const ready = hydrated && content.kind === "ready";

  // A bar change on the song already loaded here (`;bar=3` → `;bar=9`
  // in place) reloads nothing, so no content reset runs to honour a load
  // intent: seek directly. The bar a load armed is already placed (see
  // `placedForRef`), so this never fights the reset; a URL that drops its bar
  // leaves the playhead where it is.
  useEffect(() => {
    if (!ready) return;
    const key = placementKey(songId, bar);
    if (placedForRef.current === key) return;
    placedForRef.current = key;
    if (bar !== undefined) seekTo(barStartBeat(score, bar));
  }, [ready, songId, bar, score, seekTo]);
  // Not known yet until BOTH the hydration effect above has completed and the
  // song's row has settled — a loading row is never read as "no such song" (a
  // not-found flash on a deep link whose hydration beat the read).
  if (!hydrated) return { status: "pending" };
  return resolveRow(song);
}

/** Identifies where the playhead was placed for: a song, at a bar or its start. */
function placementKey(songId: string, bar: number | undefined): string {
  return `${songId}@${bar ?? "start"}`;
}

/**
 * The player surface. The pane's OWN header carries identity and tools: the
 * song title is the pane title (an inline-editable node, since it needs the
 * loaded row), and ← Library, the speed wheel, metronome, transpose, volume,
 * the spread wheel and the display switcher are contributions to
 * `sonataPlayerPane.Actions` — where each lands in the row is the slot's
 * reorder config. The surface body is the player's transport strip
 * (`PlayerTransport`, body top: play / pause, the scrubber, loop), its active
 * display (`PlayerDisplay`), and the collapsible `SectionPane`.
 */
function SonataPlayerSurface(): ReactElement {
  const params = sonataPlayerPane.useParams();
  const setParams = sonataPlayerPane.useSetParams();
  return (
    // The display lens lives in the URL's `;view`: the binding wraps the whole
    // chrome, so the header's picker and the body's display both read and
    // write it. A pick rewrites the address in place (no remount); the default
    // lens drops the key so the bare song URL stays the canonical one.
    <PlayerDisplayBinding
      displayId={params.view ?? null}
      onDisplayChange={(view) =>
        setParams({
          songId: songIdKind.key(params.songId),
          ...(params.bar !== undefined && { bar: params.bar }),
          ...(view !== null && { view }),
        })
      }
    >
      {/* The player bar IS the pane header — one slot, title included. The
          full-width Transport progress strip stays OUT of it, in the body top
          (the first child below), and the display + Section panels fill the
          rest. The body is a single `h-full` column under the chrome's inert
          `PaneScroll`. */}
      <PaneChrome pane={sonataPlayerPane}>
        <Column
          fill
          scrollBody={false}
          className="h-full bg-background text-foreground"
          header={
            /* Transport strip: play / pause, the progression bar, loop (the
               SonataPlayer.Transport contributions, in its reorder order).
               Renders nothing when no contributor is present. */
            <PlayerTransport />
          }
          body={
            /* Main area: the active display + free-floating Section panels. */
            <Stack
              direction="row"
              gap="none"
              align="stretch"
              className="h-full"
            >
              <PlayerDisplay />

              {/* Free-floating panels (current-chord readout, controls, …),
                collapsible to a thin rail. */}
              <SectionPane />
            </Stack>
          }
        />
      </PaneChrome>
    </PlayerDisplayBinding>
  );
}
