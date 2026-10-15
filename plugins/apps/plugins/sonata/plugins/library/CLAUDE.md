# library

## Navigation (the Sonata panes live here)

Sonata navigation is URL-driven via the pane router — this plugin owns both
panes (it is the natural owner: it already holds `useSongLink`, the
`Library.Source` registry, and contributes `Sonata.Home`; the shell can't own
them without a `shell → library` import that would cycle with the existing
`library → shell` dependency on `useSonataApp`).

- `sonataLibraryPane` — index pane at bare `/sonata` (`appIndex: true`,
  standard chrome titled "Library"). Renders the gallery via
  `Sonata.Home` inside `PaneChrome`.
- `sonataPlayerPane` — player pane at `/sonata/song/:songId;bar;view`. Both
  are keyed (named) views of the song, absent by default: `;bar=12` opens it
  with the playhead at that bar (`sonataSongLink(id, bar)`), and `;view` is the
  display lens (`…;view=notation`, absent for the default lens) — the surface
  wraps its chrome in the player's `PlayerDisplayBinding`, so the header's
  display switcher writes it in place and a reload, bookmark or shared link
  reopens the same lens. Its own header
  slot (`sonataPlayerPane.Actions`) IS the player's header — ← Library, the song
  title as the pane's title item, then the tools: the speed wheel, metronome,
  transpose, volume, the spread (zoom) wheel and, far right, the display
  switcher — rendered by `PaneChrome` as one overflow-collapsing row. Playback
  is the transport strip at the body top, above the display (`PlayerTransport`:
  play / pause, the scrubber, loop — the `SonataPlayer.Transport` slot). **This plugin's barrel is where every other Sonata plugin reaches
  that header**: it exports `sonataPlayerPane`, and a control is contributed as
  `sonataPlayerPane.Actions({ id, component })`. Which side of the row an item
  lands on is the slot's reorder config
  (`config/apps/sonata/library/sonata-player.actions.jsonc`), not a field on the
  contribution.
  Carries the optimistic title in `input`; its `resolve` hook
  (`useSonataPlayerResolve`) hydrates every `Library.Source`'s raw for the song
  and loads it (`useLoadDocument({ kind: "library", songId }, rawMap)`) — so
  direct nav / reload restores it — and gates on the song existing. A song
  already loaded (playing in the background, reopened from the now-playing bar)
  is NOT reloaded: a reload would rebuild its timeline and the session's content
  reset would stop and rewind it. The surface composes the player parts
  (`PlayerTransport`, `PlayerDisplay`) with the `SectionPane`.

`useSongLink` opens the player with `openPane(sonataPlayerPane, { songId },
{ mode: "root", hint: { title } })`. The ← Library button calls `clearRoute()`
(empty route → the index pane), which also works for deep-linked players. The
shell mounts `<FullPane/>`, which paints the active pane full-surface.

## Create affordances (`Library.Source.createOption`)

Each input source contributes its "add a song" affordance as a plain-data
`createOption: CreateOption` (the data-view create type) on its `Library.Source`
contribution — **not** a React component. `SongLibrary` maps every source's
`createOption` into the `DataView`'s `creators` prop, which renders them as a
toolbar "+" menu (N sources → menu, not a trailing card). The library stays
source-agnostic: it threads an opaque `s.createOption` and never names MIDI.

Because a `CreateOption.onSelect` is plain data (no component, no hooks), the
open-after-create step can't use the `useSongLink` hook. Sources call
`openSongImperative(song)` instead — the imperative twin exported from this
plugin's web barrel (`open-song.ts`), which writes to the live pane store via the
imperative `openPane` (mirroring `useSongLink`'s exact `mode:"root"` + `input`
call). `useSongLink` is kept for `SongLibrary`'s `rowActivation`, which runs
inside a component where the caller-aware context store is correct.

## One surface, no bespoke card

The library has NO custom card component. The gallery builds the shared
`DataCard` from the same derived field schema the table uses, plus a `leading`
music-note block (`viewOptions.gallery.leading`). Everything a card wants is
declared once on the `<DataView>` and honoured by both views:

| Affordance | Where it is declared |
|---|---|
| Play / Pause, Delete | `Library.SongActions` contributions (Play carries `zone: "persistent"`, so it is painted at rest) |
| Ring on the loaded song | `selectedRowId={currentSongId}` |
| Opening a song | `onRowActivate` |
| Anything per-song another plugin knows | a field its entity extension exposes on the songs entity (`defineExtensionShape({ exposes })`) |

Which fields the CARD shows is authored config, not code — `visibleFields` on
the `cards` row of `config/apps/sonata/library/sonata.library.jsonc`. Leave it
unauthored and every exposed field stacks another caption row.

## The section column (`SectionPane`)

`Sonata.Section` is a
[detail-sections](../../../../../primitives/plugins/detail-sections/CLAUDE.md)
slot — read that first; it owns the card chrome, the persisted per-section open
state, and the `useAvailable` gate. Sonata-specific on top of it:

- `web/components/section-pane.tsx` owns only the **column**: the
  collapse-to-rail toggle, the scroll body, and two `area`-filtered zones
  (`"editor"` above `"player"`). Each section is painted by the primitive's
  `SonataSectionItem`.
- **A collapsed card's body is unmounted**, so per-song work that must outlive
  the panel lives in a headless `Sonata.Effect` — hence the chord-grid / Ultimate
  Guitar `*PersistObserver`s and `rhythm-controls`' `RhythmObserver`.
- The shell exports the shared `useAvailable` gates `useHasChords` /
  `useHasDerivedChord` / `useHasVoicedChords`.

## The song list (`songLibrary`)

`songLibrary` (`core/resources.ts`, key `"sonata.songs"`) is a `liveCollection`
over the songs entity (`from: songsEntityRef` — `entityRef("sonata_songs",
songFields)`, which the server table is built from), declared by FIELDS — H
100, M 500, default order `added desc` — read by the library DataView as live
key-range pages through `songLibrarySource` (`web/source.ts`, searching title
and composer). Served by `songLibraryServed`, which compiles at boot once the
`LiveColumns.Expose` contributions are collected.

- **Fields.** `title`, `composer`, `source` are the entity's (`pick`; labels on
  `songFields`, title `primary`); `duration` and `added` are the list's own
  fields over `durationSec` / `createdAt` (bound by the server's `columns`) —
  their ids are the persisted vocabulary (saved views, presets). The row
  carries `id` beside them (`carry`). How the entity's fields present (widths,
  the `source` options read live from the `SonataDocument.Source` registry) is
  `songPresentation` (`web/internal/presentation.tsx`); the list's own
  inline-edit write-backs and the two cells are `fieldOverrides` in
  `SongLibrary`. A test pins the derived ids (`core/resources.test.ts`).
- **Exposed fields.** Other plugins add fields to every row — the library
  names none of them. Each exposes them from its extension of the songs entity
  (`defineExtensionShape({ exposes })` + `LiveColumns.Expose(ext)`):
  playback-history's `playCount` / `lastPlayedAt`, the MIDI source's
  `trackCount` / `sourceMissing`. A row carries them under
  `$columns[<extension table>]` (`Song` is the collection's row type), and the
  list derives them, so it sorts and filters by them on the server — "Most
  played", "Recently played" and "Unplayed" keep their meaning (a never-played
  song reads the field's declared default, `playCount = 0`). A play refills
  exactly that song in the tuples that read the join.
- **Readers.** `SongLibrary` (the DataView; a `useLive(songLibrary, { limit: 1
  })` probe decides the first-run onboarding — settled with no row — and
  otherwise the DataView owns its skeleton and errors); `useCurrentSong`, the
  player title (`useSongTitle`) and its resolve gate (`useSonataPlayerResolve`)
  each read ONE row with `useLiveRow(songLibrary, id)`, whose rows carry
  `$columns` too.
- **Behaviour under a live source.** Nulls sort last in both directions (the
  keyset rule; the nullable sortable columns are `composer`,
  `lastPlayedAt` and `trackCount`), an enum sort or group
  (`source`, the cards view's sections) reads in stored-value order, a section's
  count is exact only once a later section has started in the loaded rows or
  the scroll has read to the end (a library past one window, 100 songs, shows
  its last loaded section as `n+` until then).
- **Custom columns sort and filter server-side.** `songLibrary.columnScope` is
  the library DataView's id (`sonata.library`, asserted at mount), so a
  user-defined custom column binds as `custom.<id>` (the `custom` scoped column
  set — P3 of `research/2026-09-29-global-scoped-change-routing.md`), which
  lifted P2's accepted regression.

## Song title ownership

`sonata_songs.title` has exactly **one** client-side owner: this plugin's
`songLibrary` collection. There is no shell-context mirror of it. Anything that
needs the open song's title reads it through `useCurrentSong()` (the canonical
row for `currentSongId`, one `useLiveRow` point read, preserving the `status`
arms (loading / error / ready)), and the title is *edited* in exactly one place — the inline
`SongTitle` field, which is the player pane's TITLE node
(`title: { component: SongTitle }` on its `Pane.define`, `web/components/song-title-field.tsx`) and
patches `PATCH /api/sonata/songs/:id`
via `updateSong`. Mirroring the `PageHeader` pattern, the loading and error arms
gate the mount so `useEditableField` only ever seeds from a ready title, and an
empty/whitespace-only draft is never persisted (re-mounting re-seeds from the
canonical value). Source editors (chord-grid, ultimate-guitar) no longer write
the title — a chord-grid save endpoint physically cannot carry one.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Source-agnostic song library landing for Sonata. Renders the gallery of saved songs (via Sonata.Home) and opens a song into the player by collecting every source's raw through the Library.Source registry. Sources contribute persistence/hydration + their own add affordances. Persists source-agnostic Sonata song rows (generic metadata) and serves the `sonata.songs` live collection (sortable and filterable by every field an extension exposes on the songs entity). Per-source raw lives in each source's own entity-extension; sources create songs via the exported `createSongRow` helper.
- Web:
  - Slots:
    - `Library.Source`
    - `Library.SongActions`
    - `sonataLibraryPane.Actions`
    - `sonataPlayerPane.Actions`
  - Slot contributors:
    - `Library.Source` ← `apps.sonata.sources.chord-grid`
    - `Library.Source` ← `apps.sonata.sources.midi`
    - `Library.Source` ← `apps.sonata.sources.musicxml`
    - `Library.Source` ← `apps.sonata.sources.ultimate-guitar`
    - `Library.Source` ← `apps.sonata.transcription`
    - `Library.SongActions` ← `apps.sonata.library`
    - `sonataLibraryPane.Actions` ← `primitives.pane`
    - `sonataPlayerPane.Actions` ← `apps.sonata.audio.engine`
    - `sonataPlayerPane.Actions` ← `apps.sonata.audio.metronome`
    - `sonataPlayerPane.Actions` ← `apps.sonata.library`
    - `sonataPlayerPane.Actions` ← `apps.sonata.piano-roll`
    - `sonataPlayerPane.Actions` ← `apps.sonata.transport-bar`
    - `sonataPlayerPane.Actions` ← `apps.sonata.transpose`
    - `sonataPlayerPane.Actions` ← `primitives.pane`
  - Contributes:
    - `IdKinds.Kind` "song|seed"
    - `FieldPresentation.Register` "entity:sonata_songs"
    - `Sonata.Home` "library" → `SongLibrary`
    - `sonataPlayerPane.Actions` "back" → `BackToLibrary`
    - `sonataPlayerPane.Actions` "display-picker" → `DisplayPicker`
    - `sonataPlayerPane.Actions` "panels" → `PanelsToggle`
    - `Library.SongActions` "play" → `PlaySongAction`
    - `Library.SongActions` "delete" → `DeleteSongAction`
    - `Pane.Register` "sonata-library"
    - `Pane.Register` "sonata-player"
  - Uses: 65 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/pane` ×10
    - `network/live` ×6
    - `primitives/data-view` ×6
    - `apps/sonata/player` ×5
    - `primitives/css/ui-kit` ×5
    - `apps/sonata/document` ×4
    - `apps/sonata/shell` ×4
    - `primitives/css/spacing` ×2
    - `primitives/latest-ref` ×2
    - `primitives/live-state` ×2
    - `apps/sonata/session.useSession`
    - `ids.IdKinds`
    - `infra/endpoints.useEndpointMutation`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/column.Column`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/line.Line`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.SegmentedControl`
    - `primitives/editable-field.useEditableField`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.linkProps`
    - `primitives/loading.Loading`
    - `primitives/persistent-draft.useDraft`
    - `primitives/relative-time.formatRelativeTime`
    - `ui/icons.Icon`
  - Exports (types): `SourceHydration`
  - Exports (values):
    - `Library`
    - `openSongImperative`
    - `sonataLibraryPane`
    - `sonataPlayerPane`
    - `sonataSongLink`
    - `useCurrentSong`
    - `useSectionPaneCollapsed`
    - `useSongLink`
- Server:
  - Contributes:
    - `ids.kind` "song|seed"
    - `resource.declare` "sonata.songs"
    - `resource.declare` "sonata.songs:groups"
    - `resource.declare` "sonata.songs:rows"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/attachments.Attachments`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
  - DB schema:
    - `plugins/apps/plugins/sonata/plugins/library/server/internal/schema-attachments.ts`
    - `plugins/apps/plugins/sonata/plugins/library/server/internal/tables.ts`
  - Exports (types):
    - `CreateSongRowInput`
    - `UpdateSongMetaInput`
  - Exports (values):
    - `_songs`
    - `createSongRow`
    - `songAttachments`
    - `updateSongMeta`
  - Resources:
    - `sonata.songs` (keyed, window)
    - `sonata.songs:groups` (push)
    - `sonata.songs:rows` (keyed, point)
  - Routes:
    - `DELETE /api/sonata/songs/:id`
    - `PATCH /api/sonata/songs/:id`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `primitives/pane.defineRoute`
  - Exports (types):
    - `Song`
    - `SongId`
    - `UpdateSongBody`
  - Exports (values):
    - `deleteSong`
    - `sonataPlayerRoute`
    - `songIdKind`
    - `songLibrary`
    - `SongSchema`
    - `songsEntityRef`
    - `updateSong`
- Cross-plugin:
  - Imported by:
    - `active-data/song`
    - `apps/sonata/audio/engine`
    - `apps/sonata/audio/metronome`
    - `apps/sonata/piano-roll`
    - `apps/sonata/playback-history`
    - `apps/sonata/rich/chord-mode`
    - `apps/sonata/rich/key-mode`
    - `apps/sonata/rich/rhythm-controls`
    - `apps/sonata/rich/swing`
    - `apps/sonata/sources/chord-grid`
    - `apps/sonata/sources/midi`
    - `apps/sonata/sources/midi/file-preview`
    - `apps/sonata/sources/musicxml`
    - `apps/sonata/sources/ultimate-guitar`
    - `apps/sonata/sources/ultimate-guitar/alignment`
    - `apps/sonata/track-mixer`
    - `apps/sonata/transcription`
    - `apps/sonata/transport-bar`
    - `apps/sonata/transpose`
  - Extended by:
    - `apps/sonata/sources/chord-grid` (table `library_ext_chord_grid`)
    - `apps/sonata/rich/chord-mode` (table `library_ext_chord_mode`)
    - `apps/sonata/rich/key-mode` (table `library_ext_key_auto_detect`)
    - `apps/sonata/sources/midi` (table `library_ext_midi`)
    - `apps/sonata/sources/musicxml` (table `library_ext_musicxml`)
    - `apps/sonata/playback-history` (table `library_ext_playback`)
    - `apps/sonata/rich/rhythm-controls` (table `library_ext_rhythm`)
    - `apps/sonata/rich/swing` (table `library_ext_swing`)
    - `apps/sonata/transcription` (table `library_ext_transcription`)
    - `apps/sonata/transpose` (table `library_ext_transpose`)
    - `apps/sonata/sources/ultimate-guitar/alignment` (table `library_ext_ug_alignment`)
    - `apps/sonata/sources/ultimate-guitar` (table `library_ext_ultimate_guitar`)

<!-- AUTOGENERATED:END -->
