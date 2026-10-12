# rhythm-controls

The **Rhythm Circle** surface for Sonata: a per-song, editable rhythm necklace
that gives a chord grid real groove. A left hand (bass) and a right hand (chords)
each strike an onset pattern; the two rings can run at independent subdivision
counts to form a polyrhythm, and the whole necklace spins one revolution per bar
with the playhead.

## Design

- **Per-song, DB-persisted** in `sonata_songs_ext_rhythm` (an `entity-extensions`
  1:1 side-table; an absent row reads as disabled). One row holds `enabled`,
  both hands' `RhythmPattern`s as jsonb, their figuration ids, their
  `HandVoicing`s as jsonb (`bassVoicing` / `chordVoicing`: on/off, octave,
  voice-leading, octave doubling — column defaults are today's sound), and the groove
  preset it was applied from (see *Groove presets*). Both patterns are remembered even while
  disabled, so re-enabling restores the groove rather than resetting. It is
  served as a lookup-only collection, `rhythms = liveCollection("sonata-rhythm",
  { row, id: "songId" })` + `serveCollection(rhythms, { from: songRhythm })`
  (minting `sonata-rhythm:rows` alone; the jsonb patterns bind through the
  extension's decoded columns); the observer and `useGroove` each read the open
  song's row with `useLiveRow(rhythms, songId)`. Clones the `transpose` plugin's
  side-table shape verbatim.
- **The shell defines the setting, this plugin registers it.** The score
  pipeline (`reVoiceChords`) lives in the load-bearing shell, which can't import
  a feature plugin (cycle), so the shell defines `grooveSetting` (its
  `score-settings.ts`): a per-song setting of the loaded song, pending until its
  groove is read, and pending again whenever another song is loaded, so one
  song's groove never leaks into the next. This plugin registers it
  (`SonataDocument.SongSetting`, with the headless `RhythmObserver`, mounted afresh for
  each loaded song), which writes that song's settled groove: `null` (block
  chords) when the row is absent or `enabled` is false. Dependency arrow stays
  feature → shell.
- **Pending is a state, in the controls too.** `useGroove()` is `pending` until
  both the setting and the song's row have settled; the body and the header switch
  render a loading state meanwhile, never the default patterns standing in for
  the song's own. Once settled, an absent row is a song never configured, whose
  patterns really are the defaults.
- **A part, not a section.** This plugin contributes no `Sonata.Section`: the
  Accompaniment section composes its two exported parts — `GrooveSwitch` (the
  on/off `Switch`, in the section header so it stays reachable while the
  section is collapsed) and `RhythmControls` (the body). Both read one shared
  `useGroove()` hook, so the header switch and the open body can never drive
  different grooves. The applicability gate (does the song document voice this
  song's chords?) is the composing section's. While the groove is off the body
  renders nothing — the switch is the whole control.
- **The body, top to bottom.** The groove preset picker
  (`groove-preset-picker.tsx`; see *Groove presets*), the rhythm circle, then
  one expanded `HandBlock` per hand (right hand first). Its header: a colour
  chip that turns the hand on/off (off folds the block to its header, and the
  engine strikes nothing for it — a preset can be one-handed), the hand's name
  and its track's name. Below: a Pattern select (the figuration — *what*), a
  Rhythm select (the necklace — *when*; "Custom" once the necklace no longer
  strikes its rhythm's own onsets), then a two-column grid of the hand's dials
  — Octave, Voice-leading, Rotate, Steps (1–48), Octave doubling.
- **A hand wears its track's colour.** Each hand plays on a generated track
  (`hands.ts`: right → `CHORD_TRACK` "Chords", left → `CHORD_BASS_TRACK`
  "Bass"); `useHandTracks()` reads its name and colour from the track mixer
  (the swatch's `accidentalColor` shade), so the chip, the ring on the circle
  and the mixer swatch are one colour, and recolouring the track recolours the
  hand. An off hand's ring is drawn in the muted foreground.
- **The circle spins for free.** The panel derives a bar grid from
  `bars(score)` + `scoreEndBeat(score)` (existing `score/core` exports, time-sig
  aware) and drives `RhythmCircle.setPhase()` imperatively from the transport
  cursor via `cursor.subscribe(...)` — ZERO React renders per frame (the same
  idiom the scrubber's progress bar uses). It never calls `useCursorBeat()` and
  owns no `requestAnimationFrame` loop.
- **Optimistic edits.** A bead toggle / preset / rotation / subdivision change
  computes the next pattern with the pure `rhythm/core` ops, sets the shell store
  optimistically (instant playback + circle), and calls `useSaveRhythm()` to
  persist. That write is a `useEndpointMutation`, not a discarded
  `void fetchEndpoint(...)`: a rhythm edit is user-triggered, so a failed save
  surfaces as the global error toast rather than silently losing the groove until
  the next reload. The live-state push then re-affirms server truth;
  the observer re-affirms on the next push. Preset selection SNAPS the ring's
  subdivision count to the preset's native length; the subdivision stepper
  proportionally ADAPTS the pattern (the Rhythm select then reads "Custom").

## Groove presets

- **Global, in config_v2.** `groovePresetsConfig` (`shared/groove-presets.ts`,
  name `groove-presets`) is one `listField` of saved grooves — `{ name, chord,
  bass, chordFigurationId, bassFigurationId, chordVoicing, bassVoicing }`, each
  pattern / voicing a `jsonField` validated by the same `RhythmPatternSchema` /
  `HandVoicingSchema` as the row and the endpoint (a preset saved before the
  voicings existed heals to the defaults). The
  list is `stableIdentity`: a song's `groovePresetId` is a durable key into it,
  so every row (seeds included) carries an explicit `id`. Seeds (`default`,
  `bossa-nova`, `pop-ballad`, `son-clave`, `stride`, `waltz`, and the
  one-handed `walking-bass` (left only) and `harp` (right only)) are built from
  the real `RHYTHMS` / figuration ids. Registered on both runtimes
  (`ConfigV2.Register` / `ConfigV2.WebRegister`).
- **Per-song provenance, not state.** The row's nullable `groovePresetId` (sent
  by every `setRhythmEndpoint` write) records which preset the groove was last
  applied from. Whether the groove is "edited" is DERIVED —
  `!grooveEquals(groove, preset)` — never stored, so a bead toggle needs no
  bookkeeping and a preset edited elsewhere just reads as edited. A deleted
  preset leaves a dangling id: treat an id not in the list as no preset.
- **The picker.** A full-width button naming the selected preset ("Custom" for
  none or a dangling id), marked `edited` with a ghost Save (`update`) while
  the groove differs from it. Its menu (a `ControlPanelPopover`): one row per
  preset, the whole row draggable to reorder the list (`move`) — name,
  `grooveSummary`, the selected one highlighted (`ControlPanel.Row selected`),
  hover-revealed actions: a Reset on a built-in preset whose saved content has
  left its seed (`seedGroovePreset`; derived, never stored — restores the seed,
  and re-applies it to a song still in step with the preset) and a delete
  (deleting this song's own preset commits `presetId: null`) — and a
  footer "Save current as a preset…" that turns into a name field + Save
  (`save`, then commit the new id). Apply commits `presetGroove(p)`.
- **Pure helpers** (`shared/groove.ts`, tested): `grooveEquals` compares what a
  groove sounds like (both hands' subdivisions + effective onsets, figuration
  ids and voicings), ignoring provenance and how a rotation is spelt;
  `grooveSummary` ("Block · Root–fifth", right hand first, an off hand "—"); `presetGroove` (a
  preset as `GrooveFields`, the preset as its `presetId`).
- **`useGroove().presetId` never flickers.** The patterns' optimistic home is
  the shell's `grooveSetting`, but the preset id is this plugin's column, so
  `commit` also writes a module-level per-song overlay (`web/pending-preset.ts`,
  shared by the body and the header switch) that the row's push confirms by
  carrying the SAME id. Without it, Apply would measure the new content against
  the old preset until the push and flash "edited".
- **`useGroovePresets()`** — `ResourceResult<{ presets, save(name, from) → id,
  update(id, from), remove(id) }>` over `useConfigResult` (loading is a state,
  never the seeds standing in). Writes are an optimistic overlay with the
  updater + forward-written ref pattern of data-view's `useSortPresets`, so
  back-to-back writes in one tick both land.

## The generic circle

The necklace itself is the domain-agnostic
`sonata/plugins/primitives/plugins/rhythm-circle` primitive — it speaks only
plain numbers and imports nothing from Sonata. This plugin feeds it
already-effective onsets (`effectiveOnsets(pattern)`, rotation applied) and maps
`onToggleOnset`'s effective index straight back through `toggleOnset(pattern, i)`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata accompaniment part: the per-song groove. Exports its on/off switch (GrooveSwitch) and its body (RhythmControls: a groove preset picker, a left-hand (bass) and right-hand (chords) onset necklace that spins with the playhead, and one expanded block per hand: on/off chip in its track's colour, pattern, rhythm, octave, voice-leading, rotate, steps, octave doubling) for the Accompaniment section to compose; contributes no section of its own. Persists the groove per song and feeds the song document's score pipeline as a per-song setting (SonataDocument.SongSetting) settled by a headless observer. Owns the global groove presets (config sonata groove-presets: useGroovePresets) and the per-song preset provenance useGroove carries. Owns the sonata_songs_ext_rhythm side-table: per-song rhythm groove (enabled + a bass and a chord RhythmPattern, figuration and HandVoicing + the groove preset it was applied from). Serves it as a per-song lookup collection. Server registration of the global groove-presets config.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "groove-presets"
    - `SonataDocument.SongSetting` "rhythm-sync" → `RhythmObserver`
  - Uses: 54 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×10
    - `apps/sonata/document` ×7
    - `primitives/live-state` ×6
    - `apps/sonata/primitives/rhythm-circle` ×3
    - `config_v2` ×3
    - `primitives/sortable-list` ×3
    - `apps/sonata/session` ×2
    - `apps/sonata/track-mixer` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/spacing` ×2
    - `infra/endpoints.useEndpointMutation`
    - `network/live.useLiveRow`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/switch.Switch`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/loading.Loading`
    - `primitives/overlay/tooltip.WithTooltip`
    - `ui/icons.Icon`
  - Exports (types):
    - `Groove`
    - `GrooveContent`
    - `GrooveFields`
    - `GroovePreset`
    - `GroovePresetsController`
    - `GrooveState`
    - `RhythmGroove`
  - Exports (values):
    - `grooveEquals`
    - `grooveSummary`
    - `GrooveSwitch`
    - `presetGroove`
    - `RhythmControls`
    - `useGroove`
    - `useGroovePresets`
    - `useSaveRhythm`
- Server:
  - Contributes:
    - `resource.declare` "sonata-rhythm:rows"
    - `ConfigV2.Register` "groove-presets"
  - Uses:
    - `apps/sonata/library._songs`
    - `config_v2.ConfigV2`
    - `infra/endpoints.implement`
    - `infra/entity-extensions.defineExtension`
    - `network/live.serveCollection`
  - DB schema: `plugins/apps/plugins/sonata/plugins/rich/plugins/rhythm-controls/server/internal/tables.ts`
  - Entity extension of: `apps/sonata/library` (table `sonata_songs_ext_rhythm`)
  - Exports (values): `songRhythm`
  - Resources: `sonata-rhythm:rows` (keyed, point)
  - Routes: `POST /api/sonata/songs/:id/rhythm`
- Cross-plugin:
  - Imported by: `apps/sonata/rich/accompaniment`

<!-- AUTOGENERATED:END -->
