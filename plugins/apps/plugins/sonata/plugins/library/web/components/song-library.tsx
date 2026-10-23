import { useCallback, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { songLibrary, updateSong } from "../../core";
import type { Song } from "../../core";
import { Library } from "../slots";
import { useSongLink } from "../hooks";
import { useSourceCreators } from "../internal/use-source-creators";
import { songLibrarySource } from "../source";
import { formatDuration } from "../format-duration";
import { NowPlayingBar } from "./now-playing-bar";
import { SonataOnboarding } from "./onboarding";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { resolveSongCover } from "../internal/resolve-cover";
import { SongCover } from "../internal/song-cover";

// The icons a card's token line draws before each of the library's own fields.
const composerIcon = symbol("person");
const durationIcon = symbol("timer");
const addedIcon = symbol("calendar-today");

const LIBRARY_VIEW = defineDataView("sonata.library");

/**
 * The Sonata landing surface: the saved-song collection rendered through the
 * `data-view` primitive (gallery of cards + sortable/searchable table). Opening
 * a song hydrates every source that has data for it via the generic
 * `Library.Source` registry (see `useSongLink`) and switches to the player —
 * the library never names MIDI (or any source). Each source's create affordance
 * (`Library.Source.createOption`, a data-view `CreateOption`) is mapped into the
 * DataView's `creators` — rendered as a toolbar "+" menu (N sources). The list
 * reads the live `songLibrary` collection as key-range pages
 * (`source={songLibrarySource}`): sort, filter and search run on the server,
 * and the songs near the ones on screen stay live.
 *
 * There is no bespoke card: the gallery builds the standard `DataCard` from this
 * schema, its picture the song's cover — every `Library.Cover` answer folded by
 * `resolveSongCover` and drawn by `SongCover` over the quiet source-tinted
 * base (the list draws the same cover as its thumbnail). Everything else is
 * declared once and honoured by EVERY view — Play/Delete as
 * `Library.SongActions` contributions (Play the primary verb, over the cover),
 * the currently-loaded ring as `selectedRowId`, and opening a song as
 * `rowActivation` (a link).
 *
 * The fields are derived from the collection: the songs entity's (presented
 * by `songPresentation`), and every field an extension exposes on a song —
 * play count / last played from `playback-history`, tracks from the MIDI
 * source — each in the Sort pill, the Filter pill, and a table column, sorted
 * and filtered on the server; prerecorded orderings are just named sort
 * presets (authored in config) over those fields rather than bespoke toolbar
 * chips.
 */
export function SongLibrary() {
  // Does the library hold any song at all? One row answers it — the first-run
  // onboarding replaces the list only once that is known to be none.
  const anySong = useLive(songLibrary, { limit: 1 });
  const confirmedEmpty = foldResource(anySong, {
    loading: () => false,
    error: () => false,
    ready: (rows) => rows.length === 0,
  });
  const songLink = useSongLink();
  // The background-playing song (if any) — highlights its table row and feeds
  // the now-playing footer below.
  const { currentSongId } = useSonataApp();
  // Write-back for inline cell editing (title / composer) in the table view.
  // Fire-and-forget: the server's `updateSongMeta` write refills that song in
  // the live collection, so the edited cell settles from server truth; a failed
  // write surfaces via the global mutation toast (no local onError).
  const { mutate: saveSong } = useEndpointMutation(updateSong);
  const creators = useSourceCreators();
  // Every source's cover answer, folded per song (the library names none).
  const coverSources = Library.Cover.useContributions();
  const cover = useCallback(
    (song: Song) => ({
      kind: "node" as const,
      node: (
        <SongCover song={song} answer={resolveSongCover(coverSources, song)} />
      ),
    }),
    [coverSources],
  );

  // The list's fields are derived — the songs entity's, its saved-view ids
  // (`duration`, `added`), and every field an extension exposes on a song
  // (plays, tracks, …). What the list itself says of them: the inline-edit
  // write-backs and two cells.
  const overrides = useMemo(
    () =>
      fieldOverrides(songLibrary, {
        title: {
          // Title is NOT NULL — ignore a cleared cell so it reverts to the
          // current value rather than persisting an empty string.
          onEdit: (s, next) => {
            const title = String(next ?? "").trim();
            if (!title) return;
            saveSong({ params: { id: s.id }, body: { title } });
          },
        },
        composer: {
          icon: composerIcon,
          // The raw nullable value, so the inline editor opens from the true
          // value and clearing it stores `null`. No `cell`: the field is
          // editable, so `EditableCell` owns the empty rendering and paints its
          // own italic "Empty" hint — the affordance that invites the edit.
          onEdit: (s, next) => {
            const composer = String(next ?? "").trim();
            saveSong({
              params: { id: s.id },
              body: { composer: composer || null },
            });
          },
        },
        // m:ss over the inherited number cell; the number range filter stays.
        duration: {
          icon: durationIcon,
          cell: (s) => formatDuration(s.duration),
          width: "5rem",
          align: "end",
        },
        added: {
          icon: addedIcon,
          cell: (s) => formatRelativeTime(s.added),
          width: "7rem",
        },
      }),
    [saveSong],
  );

  return (
    <Column
      fill
      className="h-full"
      body={
        // Confirmed-empty (ready, no song) → the first-run onboarding
        // takeover (hero + source cards). Anything else → the DataView, which
        // owns its loading skeleton and its errors: a loading or failed
        // library never flashes the onboarding.
        confirmedEmpty ? (
          <SonataOnboarding />
        ) : (
          <DataView<Song>
            source={songLibrarySource}
            overrides={overrides}
            views={["gallery", "list", "table"]}
            defaultView="gallery"
            storageKey={LIBRARY_VIEW}
            // The song's cover: the card's picture, the list's thumbnail.
            cover={cover}
            // The one per-row action set, rendered by every view: Play/Pause
            // the primary verb (over the cover; at rest while it plays) and
            // Delete on hover. Highlight the background-playing row.
            itemActions={Library.SongActions}
            selectedRowId={currentSongId ?? undefined}
            // The "Library" title is owned by the enclosing `PaneChrome` (the
            // pane header), so the DataView omits its own to avoid a duplicate.
            // Per-source create affordances (e.g. MIDI Import, New Chord Grid),
            // mapped from the `Library.Source` registry into the data-view "+"
            // menu. The library stays source-agnostic — it threads an opaque
            // `createOption` and never names MIDI.
            creators={creators}
            rowActivation={songLink}
            emptyState={<>No songs match.</>}
          />
        )
      }
      footer={<NowPlayingBar />}
    />
  );
}
