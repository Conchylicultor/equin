# track-mixer

Per-track view-state for the Sonata player: each track of the open song gets a
**categorical color**, a **mute** toggle (silences it in the audio scheduler),
a **hide** toggle (drops its notes from the piano-roll), an **instrument**
override (the timbre it sounds with), and a **volume** (its fader position in
the mix). The compact `Sonata.Section` panel
("Tracks", area `player`) lists every track with its name (MIDI track name →
instrument hint → `Track N`), a functional instrument picker, and note count,
plus a per-song reset.

## Design

- **State is DB-persisted per (song, track)** in `sonata_track_view` — a plain
  1:many table (compound PK `(songId, trackId)`, FK-cascade on song delete), not
  an entity-extension (those are 1:1). `color` and `instrument` are nullable:
  null `color` means "use the palette default for the track's index"; null
  `instrument` means "auto" — derive the timbre from the track's GM program
  (`TrackMeta.gmProgram`), else the default instrument. `muted`/`hidden` default
  to false and `volume` to 1 so an absent row reads as audible + visible at the
  level it was recorded.
- **Volume is a linear gain multiplier, not dB and not a percentage** — 1 unity,
  0 silent, 2 is +6 dB. It goes straight into a Web Audio `GainNode.gain`, so
  any other unit would put a conversion between the persisted number and the
  thing it controls. The panel is what renders it as a percentage.
- **Mute and `volume: 0` are different mechanisms, deliberately.** Mute removes
  the track's notes upstream, so a muted track has no channel in the engine at
  all — no sample load, no scheduling. Volume 0 is a fader position on a channel
  that keeps existing and keeps being scheduled, so raising it again is instant;
  folding it into the audible set would make every fader-to-zero cut every other
  track's ringing notes.
- **Two "customized" questions, two flags.** `customized` is "any override at
  all" and drives the reset affordance (which deletes the row). The instrument
  picker asks the narrower `instrumentCustomized` (`row.instrument != null`) —
  a row exists as soon as the track is muted or its fader moved, and reading
  that as an instrument override would make the picker stop showing "Auto".
- **Instrument resolution.** `useTrackMixerEntries` reads the registered timbres
  generically via `SonataAudio.Instrument.useContributions()` (never names a
  contributor) and resolves each track's effective instrument id with the
  precedence: a non-null override that still matches a registered id → the
  contribution whose `gmProgram` equals the track's program → the `default`
  contribution (else the first). The picker writes the override (or `null` to
  reset to auto); the audio engine consumes the resolved map to route each
  track's notes to its own voice manager.
- **One song's overrides, one value, multiple consumers.** `trackViews =
  liveValue("sonata-track-view", { schema: z.array(TrackViewRowSchema), params:
  ["songId"] })` is the song's rows, served by `serveValue({ source: "db",
  unbounded: { reason }, loader })` (at most one row per track of that song; a
  value, not a collection, because the key is the composite `(songId,
  trackId)`). This plugin owns the song's track views as a per-song setting of
  the loaded song, `trackViewSetting` (`web/track-view-setting.ts`, a
  `defineSongSetting` key: pending until the rows are read, pending again
  whenever another song is loaded), and registers it with the shell
  (`SonataDocument.SongSetting`, with the headless `TrackViewObserver`, mounted afresh
  for each loaded song), which reads the rows for that song and writes them once
  settled. The shell never reads the value — it only waits, generically, on
  every registered setting — so no frame draws or plays the song with default
  track views (a muted track audible) or the previous song's while they load.
  Every hook here reads the setting and is itself **pending-aware**
  (`SongSetting<…>`): the panel reads it; the **piano-roll** imports `useTrackColorMap` +
  `useHiddenTrackIds` to color and filter notes; the **audio engine** imports
  `useMutedTrackIds` to drop muted tracks' notes, `useTrackInstrumentMap` to
  route each track's notes to its resolved timbre, and `useTrackVolumeMap` to
  set each track's fader gain; each handles the pending arm (nothing drawn,
  nothing scheduled, a loading state). The narrow hooks all derive from
  `useTrackMixerEntries`, which joins `score.tracks` (order → default color, GM
  program → instrument) with the persisted overrides and a per-track note
  tally.
- **Writes are fire-and-forget, but ordered.** The UI never reads the response
  — state refreshes via the `trackViews` push the upsert/reset's commit
  triggers. Every write still goes through the song's send lane
  (`enqueueResourceWrite(trackViews, { songId }, …)`), because these are
  last-writer-wins upserts: sent as bare concurrent fetches, a loaded backend
  can apply an older fader position after a newer one and silently keep the
  wrong level. The lane departs a song's writes in the order they were issued;
  writes for different songs touch different rows and need no order.
- **The upsert addresses many tracks at once.** Its body carries `trackIds`
  (a single-track edit passes `[trackId]`) and the handler writes every row in
  one transaction — so a whole-arrangement flip is one commit and one push. The
  barrel exports one write for other plugins, `setTracksActive(songId,
  trackIds, active)`: hidden + muted together, returning the promise so a caller
  swapping sound layers (the **chord-mode** plugin deactivating the original
  tracks before its chord tracks appear) can sequence on it.
- **Synthesia colors, with a white-key / black-key pair per track.** `palette.ts`
  holds the **base** (white-key) color per slot — the first two sampled
  pixel-exact from Synthesia (blue `#87aacf`, green `#a2e55b`); the rest extend
  the set in the same register. The base is what the mixer swatch shows and what
  the keyboard lights with, cycled by track index. Each base also has a darker,
  slightly-more-saturated **accidental** partner (`accidentalColor`): exact for the
  built-in Synthesia colors, derived by a shared darken+saturate transform for
  any other (incl. user-picked) base, so naturals vs accidentals always read
  distinctly — Synthesia's convention. The piano-roll resolves the right shade
  per note (`NoteVisual.fillExpr`); FX keep the undarkened base via `colorExpr`.
  Colors are explicit hexes now (not theme tokens), so they no longer re-skin
  with the active theme — matching Synthesia exactly is the point.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Compact per-track control panel for the Sonata player: categorical color, mute (audio), and hide (piano-roll) per track, with name / instrument / note count. State persists per (song, track) and registers with the song document as a per-song setting (SonataDocument.SongSetting, settled by a headless observer), so the player waits for it. Exposes color/hidden/muted hooks consumed by the piano-roll and audio engine. Persists per-(song, track) view overrides (color / instrument / muted / hidden / volume) and serves them per song, consumed by the piano-roll, the audio scheduler, and the track-mixer panel.
- Web:
  - Contributes:
    - `SonataDocument.SongSetting` "track-view-sync" → `TrackViewObserver`
    - `Sonata.Section` "Tracks" → `TrackMixerPanel`
  - Uses: 40 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/sonata/document` ×8
    - `primitives/css/spacing` ×2
    - `primitives/css/text` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/live-state` ×2
    - `primitives/optimistic-mutation` ×2
    - `primitives/overlay/floating-action` ×2
    - `primitives/search` ×2
    - `apps/sonata/audio/instruments.SonataAudio`
    - `apps/sonata/session.useSession`
    - `apps/sonata/shell.Sonata`
    - `infra/endpoints.fetchEndpoint`
    - `network/live.useLive`
    - `primitives/css/color-picker.SwatchGrid`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/slider.Slider`
    - `primitives/css/yield.yieldClass`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `ui/icons.Icon`
  - Exports (types): `TrackMixerEntry`
  - Exports (values):
    - `accidentalColor`
    - `setTracksActive`
    - `useHiddenTrackIds`
    - `useMutedTrackIds`
    - `useTrackColorMap`
    - `useTrackInstrumentMap`
    - `useTrackMixerEntries`
    - `useTrackVolumeMap`
- Server:
  - Contributes: `resource.declare` "sonata-track-view"
  - Uses:
    - `apps/sonata/library._songs`
    - `database.db`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveValue`
  - DB schema: `plugins/apps/plugins/sonata/plugins/track-mixer/server/internal/tables.ts`
  - Exports (values): `_trackView`
  - Resources: `sonata-track-view` (push, unbounded: one song's per-track view overrides — at most one row per track of that song)
  - Routes:
    - `POST /api/sonata/songs/:songId/track-view`
    - `DELETE /api/sonata/songs/:songId/track-view`
- Core:
  - Uses:
    - `apps/sonata/library.songIdKind`
    - `fields.FieldsRecord`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/text/config.textField`
    - `ids.idKindField`
    - `infra/entities.wireSchema`
  - Exports (types): `TrackViewRow`
  - Exports (values): `TrackViewRowSchema`
- Cross-plugin:
  - Imported by:
    - `apps/sonata/audio/engine`
    - `apps/sonata/notation`
    - `apps/sonata/piano-keyboard`
    - `apps/sonata/piano-roll`
    - `apps/sonata/rich/chord-mode`
    - `apps/sonata/rich/rhythm-controls`

<!-- AUTOGENERATED:END -->
