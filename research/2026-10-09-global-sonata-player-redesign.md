# Sonata song-player redesign — implementation plan

## Context

The Sonata song player grew card by card: a right panel of up to 12 bordered, chevroned cards with dense captions, a top bar whose view options live in a floating HUD chip, and a scrubber without chords. Over 10 iterations of prototype **proto-1791407620-ij8o** (`~/.singularity/apps/prototypes/proto-1791407620-ij8o/index.html`, defaults `keyboard=2-octaves`, `keys=same-ratio`) the user settled the target:

- **Right panel**: a flat *inspector* (sections divided by rules, no cards, no chevrons; header click still collapses) with: Chord grid · Ultimate Guitar · Recording · Tracks · Progression · Current chord · Chord list · Accompaniment · Current key · Circle of fifths.
- **One keyboard shape**: every readout keyboard is a 2-octave window whose keys keep the same proportion at any width (a narrower keyboard is shorter, never squashed); Current key's scale keyboard is the one single-octave exception.
- **New capabilities**: an alignment-progress section with Cancel/Re-align/Retry; global, user-saveable groove presets applying both hands at once; the key's diatonic chords as a stacked list; a chord lane on the timeline.
- **Top bar**: back icon, chord lane on the scrubber, `Speed · Metronome · Transpose · Volume │ Zoom`. (Title+composer and the view-menu were dropped by the user.)

User decisions (2026-10-09): **no composer line under the title and no view-menu change** (the view switcher and the HUD View/FX chips stay as they are); keep **Cancel** (needs a supervised-job infra change); key flags on the scrubber become **tick + tooltip**; inspector chrome is **Sonata-only**; Current chord shows **confidence inline, drops beats**; Current key **keeps** source badge, relative key and scale note names visibly.

`S` = `plugins/apps/plugins/sonata/plugins`, `ALIGN` = `S/sources/plugins/ultimate-guitar/plugins/alignment`, `RC` = `S/rich/plugins/rhythm-controls`.

## Design

### 1. Panel chrome — a declared, pane-level variant
- `DetailSectionsOptions` gains `chrome: "card" | "inspector"` (default `card`), set **once by the slot owner** in `defineDetailSections(...)`; sections can't choose. Primitive paints both, so the "no ad-hoc chrome" intent holds (doc comment + `detail-sections/CLAUDE.md` updated).
- `SectionHeaderRow` (`plugins/primitives/plugins/css/plugins/row/web/internal/section-header-row.tsx`): disclosure `"lead" | "trailing" | "none"`; `none` keeps click + aria, draws no chevron; collapsed label muted.
- `SectionCard` (`plugins/primitives/plugins/section-card/web/internal/section-card.tsx`): `variant: "card" | "inspector"`; inspector = plain `<section>` + bottom rule, full-width hover header ~44px, same `rail-x-lg pb-lg` body. New exhibit `section-card/inspector-region`.
- `defineDetailSections` also returns `SectionStack` (owns gap/inset per chrome). `S/shell/web/slots.ts`: `{ chrome: "inspector" }`, export `SonataSectionStack`. `S/library/web/components/section-pane.tsx` uses it; panel width → ~368px; the in-panel collapse row moves to a top-bar **Panels** toggle (`useSectionPaneCollapsed()` wraps the existing `useDraft("sonata.section-pane.collapsed")`).

### 2. Keyboard — proportion owned by the plane
- `PitchPlane` (`S/score/core/pitch-plane.ts`) gains `span` (key-widths) and `aspect` (w/h at natural proportion); `PitchLayout.proportion(low, high)` in `S/pitch-layout/core/{geometry,piano,janko}.ts` (piano `WHITE_KEY_LENGTH = 4.4`, janko `PAD_HEIGHT_RATIO ≈ 0.9`). Drop the `"chip"` fixed height so it can't be used.
- `Keyboard` (`S/primitives/plugins/keyboard/web/internal/keyboard.tsx`): required `sizing: "fill" | "proportional"`; proportional = `width:100%`, `aspect-ratio: plane.aspect`, `max-width: plane.span × MAX_KEY_PX (24)`. No measuring; skins unchanged (drawn already measures). Roll gutter, piano-keyboard, Chord app piano-card → `fill`.
- New plugin `S/rich/plugins/readout-keyboard/`: core `READOUT_WINDOW = {60..83}`, `fitVoicings(voicings)` (moved from chord-readout's `fitToWindow`; joint octave shift, widen by whole octaves); web `useReadoutPlane`, `ReadoutKeyboard`, `KeyboardCaption({lead, trail, current})`.

### 3. Theory (`S/theory/core`)
- `diatonicChords(key, { sevenths? }): DiatonicChord[]` (`{degree, chord: ChordData, numeral}`), natural minor for minor keys, quality via `CHORD_TEMPLATES`, spelled via `makeKeySpeller`. Hoist the major/minor scale consts shared with `roman.ts`.
- `chordVoicing(chord)`: root position, rotated so a slash bass is lowest.

### 4. Sections
- **Chord grid** (`S/sources/plugins/chord-grid/web`): `parseGrid` returns token spans (`chord|degree|hold|group-open|group-close|comment|key-directive|key-value|invalid`, invalid decided by the same `expand` that fills `skipped`) + `bars`. New primitive `plugins/primitives/plugins/syntax-highlight/plugins/overlay-textarea` (`OverlayTextarea`, underlay `<pre>` sizes the box → auto-grow; extracted from page/code-block's pattern, code-block migration = follow-up task). Below: `N chords` / `N bars` badges, destructive `Skipped: …`, ghost **Syntax ▾** legend (`useDraft`). No counts/prose in the field.
- **Ultimate Guitar** (`.../ultimate-guitar/web/loader.tsx`): new shared `S/primitives/plugins/source-line` (`SourceLine({title, badge?, subtitle?, action, children?})`): title / muted artist / Replace → inline URL + Load.
- **Recording** (`ALIGN/web`, `S/recording/web`): no header summary. Body: video (+ "Not synced" overlay badge) → volume row (mute, slider, number; **sync-offset control removed**, config stays in Settings) → **AlignmentStatus** → `SourceLine` (video title + match chip, channel muted, Replace) → inline **VideoReplace** (editable URL + Use, candidate rows with thumbnail + outcome chip, hover "open on YouTube" link, Search again).
  - AlignmentStatus controls: working → Cancel; aligned/out-of-date → Re-align; failed (retryable) / cancelled → Retry; weak/needs-video → Try another (opens Replace); no-video → Find a video.
  - **Stage bar**: Find a video → Analyse the audio → Align the sheet; done segments full, current segment an indeterminate CSS shimmer (no timer), label names the step (incl. "video 2 of 3"). No % — nothing reports one honestly.
- **Tracks** (`S/track-mixer/web/components/track-mixer-panel.tsx`): theme refresh only (swatch halo, type scale, instrument chip hover, divided rows); hover fader + eye unchanged.
- **Progression** (`chord-progression.tsx`): app layout, no colour; header action **C / I / C·I** label-mode cycler (`ChordLabelModeAction` exported by `S/rich/plugins/chord-label/web`).
- **Current chord** (`S/rich/plugins/chord-readout`): big symbol; beside it numeral (primary) over short quality (`dom7`); **confidence shown inline** (e.g. `92%` muted) when present; beats dropped. **Inversions** toggle in header actions; on → one `ReadoutKeyboard` per inversion under a `KeyboardCaption` ("1st … C♯m7/E"), shared plane.
- **Chord list** (`S/rich/plugins/chord-list`): keep ChordBox degree colours, now-ring, click-to-play+seek; grid `3.25rem 1fr 1.5rem`, smaller box/×N; `ReadoutKeyboard`.
- **Current key** (`S/rich/plugins/key-readout`): big key name + **relative key** + **source badge** (From MIDI/tab/grid · Auto-detected) + **scale note names** (kept visible); single-octave keyboard (`usePitchGeometry(60,71)`, capped 168px) with dots via `renderKey` (tonic primary); **Chords** toggle → 7 `KeyboardCaption`+`ReadoutKeyboard` rows from `diatonicChords`, current root highlighted. Auto-detect stays in header.
- **Accompaniment**: new plugin `S/rich/plugins/accompaniment` owns one `Sonata.Section` (`id: "accompaniment"`), composing named parts from chord-mode (`ChordModeRow`, `useChordModeAvailable`), rhythm-controls (`GrooveSwitch` in header, `RhythmControls`), voicing-controls (`VoicingControls`). A fixed composite, not an open set → direct barrel imports, no slot. Those three stop contributing sections. `config/apps/sonata/shell/section.jsonc`: replace `chord-mode`/`rhythm`/`voicing` with `accompaniment`.
- **Groove presets** (`RC`): global config_v2 `sonata.groove-presets` (`listField`, `stableIdentity`, items `{name, chord, bass: RhythmPattern, chordFigurationId, bassFigurationId}`; seeds default, bossa-nova, pop-ballad, son-clave, stride, waltz using real `RHYTHMS` ids) — precedent: data-view sort/filter presets. Per-song `groovePresetId` column on `sonata_songs_ext_rhythm` (**migration**), carried by `setRhythmEndpoint`, optimistic overlay so "edited" never flickers. Pure `grooveEquals` / `grooveSummary` / `presetGroove` (tested). Hook `useGroovePresets()` (save/update/remove, updater+ref pattern from `use-sort-presets.ts`). UI: preset button (+ `edited` + Save) → menu (rows with hand summary, delete on hover, "Save current as a preset…"); circle; per hand `[pattern][rhythm][⋯ rotate/steps]`; voice-leading + octave.
- **Circle of fifths**: unchanged.

### 5. Alignment backend
- `ALIGN/core/internal/row.ts`: phase enum → `searching|waiting|fetching|installing|analysing|aligning`; status + `cancelled` (text columns — no migration). Move `MAX_TRIES_PER_RUN` to core.
- `plugins/infra/plugins/audio-analysis/server/internal/ensure.ts`: `onPhase?(p)` awaited (waiting → fetching → installing → analysing; never on cache hit).
- `ALIGN/server/internal/job.ts` writes phases live; `decide.ts` treats `cancelled` as idle (a sheet edit does not restart it); `routes.ts` realign also resumes an auto walk; new `POST …/alignment/cancel` (409 unless working): upsert `cancelled`, reset `trying` candidates, `cancelSupervisedJobByLock`.
- Supervised-job infra (`plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/`): `cancelledAt` on `supervised_job_runs` (**migration**), `cancelSupervisedJobByLock(job, input)`, ledger treats a cancelled run as `done` (no dead-letter/alert), `SupervisedJobEndedMeta.cancelled`; `onEnded` re-writes `cancelled` and skips re-enqueue.
- Web: `ALIGN/web/internal/recording-state.ts` → `working {progress: AlignProgress}` + `cancelled`; pure `alignProgress(row)`; delete `recordingStateSummary`; tests updated.

### 6. Top bar
- **Back** = `IconButton` (title unchanged).
- **View switcher**: unchanged (dropped by the user); HUD View/FX chips stay.
- **Chord lane**: new plugin `S/progress/plugins/chords` → `SonataProgress.Marker`; band `LANE_ABOVE_Y` exported from scrubber `rail-geometry.ts`; labels via `formatChordLabel` + `useChordDisplayMode` (follows transpose); current chip via `useCursorSelector` + memoised chips (no per-frame renders); pointer-transparent (click/drag scrubs). Key flags (`S/progress/plugins/keys`) → tick + `title` tooltip.
- **Zoom/order**: `SpreadWheel` hidden unless display = piano-roll; row-aware divider (`plugins/reorder/plugins/editor/web/internal/items.tsx` `DividerReorderItem` vertical in a row; legend + divider CLAUDE.md); `config/apps/sonata/library/sonata-player.actions.jsonc` → back, title, spacer, speed, metronome, transpose, volume, divider, spread, display-picker, panels toggle.

## Execution — phased fan-out

All agents work in this worktree on **file-disjoint** packages; agents do not run `./equin build`. Between phases the orchestrator runs `./equin build` (background) + `./equin check`, fixes integration fallout, then launches the next phase. Generated files (registries, plugin docs, order files, migrations) are settled only by build. The two migrations are generated in separate phases (no snapshot fork).

**Phase 0 (orchestrator)** — update the prototype: Current chord confidence inline (no beats); Current key relative key + source badge + scale names visible.

**Phase 1 (parallel)**
| WP | Scope | Model |
|---|---|---|
| P1 Chrome | §1 files incl. `S/shell/web/slots.ts`, `section-pane.tsx`, `library/web/index.ts` + new panels-toggle component | Opus |
| P2 Keyboard proportion | §2 plane/layout/Keyboard + `fill` call sites + mechanical `sizing` on 3 readouts | Opus |
| P3 Theory | §3 + tests | Sonnet |
| P4 Chord grid | overlay-textarea primitive + chord-grid parse/loader/css | Opus |
| P5 SourceLine + UG | §4 UG | Sonnet |
| P6 Tracks | track-mixer-panel only | Sonnet |
| P7 Progression | chord-progression + chord-label `ChordLabelModeAction` | Sonnet |
| R1 Job cancel | supervised-job infra (**migration #1**) + tests | Opus |
| R2 onPhase | audio-analysis ensure | Sonnet |
| R5 Recording video | `S/recording/web` + e2e `video-sync.ts` | Sonnet |
| R7 Part exports | chord-mode + voicing-controls stop contributing sections, export rows | Sonnet |
| T1 Back icon | back button + e2e `song-switch.ts` (composer dropped) | Sonnet |
| T3 Chord lane | new `S/progress/plugins/chords`, scrubber geometry, key flags | Opus |
| T4b Row divider | reorder editor divider + legend | Opus |

**Phase 2 (parallel)** — P8 readout-keyboard plugin (Sonnet; needs P2) · R3 alignment core+server+cancel endpoint (Opus; R1, R2) · R6a groove-preset data (**migration #2**, Opus) · T4a bar order + zoom gating (Sonnet; T4b, P1 toggle).

**Phase 3 (parallel)** — P9 Current chord · P10 Chord list · P11 Current key (Sonnet; P3, P8) · R4 alignment web (Opus; R3, P5) · R6b rhythm UI + preset picker (Sonnet; R6a).

**Phase 4** — R8 Accompaniment plugin + `section.jsonc` (Sonnet; R6b, R7) → verification pass (Sonnet).

**All implementation agents run on Opus** (user decision, 2026-10-09); the Model column records the original estimate only.

Each WP prompt carries: its files, the exact prototype functions/CSS to match, the interfaces it consumes/exports (names above), and its acceptance check.

## Verification
- After each phase: `./equin build` then `./equin check` (type-check, boundary-rules, plugin-boundaries, eslint, migrations-in-sync, plugins-doc-in-sync).
- Tests: `./equin test plugins/apps/plugins/sonata/plugins/theory plugins/apps/plugins/sonata/plugins/pitch-layout plugins/apps/plugins/sonata/plugins/sources plugins/apps/plugins/sonata/plugins/rich plugins/infra/plugins/jobs/plugins/supervised-job plugins/primitives/plugins/css/plugins/row`.
- Visual: `compare-diff.ts --name proto-1791407620-ij8o --options keyboard=2-octaves,keys=same-ratio` and screenshots of a UG song (recording states), a chord-grid song, a MIDI song (chord mode) at 1440 and 900 px; other detail-section panes (task detail, deploy) unchanged.
- Behaviour: Cancel during alignment ends `cancelled` with no report filed; Retry resumes; groove preset apply/save/update/delete persists across reload and songs; chord lane highlights during playback with no per-frame commits (render-loop detector quiet); updated e2e: `S/recording/e2e/video-sync.ts`, `plugins/apps/plugins/sonata/e2e/song-switch.ts`.

## Open risks
- Same-proportion keys make inversion/diatonic stacks tall (~106px per keyboard at 336px); tune `MAX_KEY_PX` / `WHITE_KEY_LENGTH` on screenshots.
- `OverlayTextarea` caret/IME drift; fallback = plain textarea with chips + legend.
- A user-pasted video has no title/channel (not a candidate) → shows "YouTube video ‹id›"; oEmbed lookup is a possible follow-up.
