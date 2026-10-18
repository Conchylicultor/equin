# notation

A third `SonataPlayer.Display` lens (beside `piano-roll` and `songsheet`): standard
**sheet-music notation**. It engraves the fully-composed `Score` (transpose,
key inference and spelling already applied by the shell) as a **part → staff →
voice** system — clefs, key/time signatures, barlines, accidentals, rests and
ties — and follows playback with a moving playhead, an active-note highlight,
per-system auto-scroll, and click-to-seek.

## Model: part → staff → voice

The pure converter (`convert.ts`) builds the score in three nested layers, then
the engraver lays them out:

- **Parts** — one per instrument group. The `staffLayout` config chooses the
  mapping: `grand` merges every track onto a single treble/bass grand staff;
  `perTrack` gives each track its own part (one staff, or a grand staff when the
  track's range straddles the split pitch by ≥16 semitones); `auto` groups tracks
  by **instrument** — a per-track key of `gmProgram` (else `instrumentHint`, else
  the track id so unknown instruments never merge). Each `auto` group becomes one
  part. A group of exactly **two** tracks is a two-handed part: a grand staff
  where each track owns one staff (higher-sounding track on top, each staff's
  clef from its own track's median pitch). So a solo piano imported as
  right-hand / left-hand tracks keeps every note on its own hand's staff — a
  right-hand note below middle C is not moved to the bass staff. A group of one
  track, or three or more, pools its notes into one part split by `splitPitch`.
  A true ensemble of distinct instruments stays one part per instrument. If `auto`
  yields exactly one group it renders identically to `grand`; multiple groups use
  the per-part staff/grand-staff + bracket logic. Parts are ordered top→bottom by
  descending mean pitch. >1 part → the system is wrapped in a `bracket`; a
  grand-staff part is joined by a `brace`. `grand` always pitch-splits (it is
  the explicit "merge everything" mode), even for two hand tracks.
- **Staves** — a part owns 1 staff (clef by median pitch) or 2 (treble/bass split
  by `splitPitch`). Every measure carries the same staff shape so the engraver
  stacks/connects uniformly; an empty staff in a bar becomes a whole-measure rest.
- **Voices** — each staff's notes are partitioned into independent melodic lines
  by `voices.ts` (`partitionVoices`). Explicit `Note.voice` numbers are honored
  verbatim; otherwise voices are inferred (interval-graph greedy coloring with a
  pitch-coherence tiebreak), capped at `maxVoicesPerStaff` (default 2, classical
  max 4). A 2-voice staff opposes stems (upper up, lower down). Because a voice
  never staggered-overlaps, the existing run/quantize/decompose machinery —
  **run per voice** — produces clean tied chords with **no re-articulation by
  construction**: a held note in one voice isn't in another voice's note-set, so
  a neighbour's onset can't re-strike it. `separateVoices=false` collapses each
  staff to a single voice (the v1 look).

## Renderer: VexFlow (scoped here)

The engraving is drawn with **VexFlow** (`vexflow`), declared as this plugin's
own dependency — mirroring how `piano-roll` scopes `pixi.js` to itself rather
than hoisting a renderer to the shell. Hand-rolled SVG engraving (beaming,
accidental placement, stems, ledger lines, rest glyphs, collision avoidance) is a
research problem; VexFlow does it to a professional standard.

**Fixed paper palette.** The staff is always engraved as black ink on a white
page (the `PAPER` constant in `notation.tsx`), deliberately independent of the
app theme (light/dark) *and* the active color preset — real sheet music is
monochrome print, so a tinted or light-on-dark staff reads as a bug, not a skin.
The only accent is the active-note highlight + playhead (a single fixed hue with
strong contrast on white). Because colors are constant, a theme change no longer
invalidates the engraving.

## Rhythm: adaptive subdivision (tuplets, grace notes, sub-16ths)

The converter does **not** use one fixed 1/16 grid. `web/internal/rhythm.ts`
decides a subdivision **per window** from that window's true note **onsets** (not
offsets — a release is articulation-noise that would mislabel ordinary rhythms
as tuplets). A greedy largest-first scan walks the bar: at each beat-aligned
position it first tries **multi-beat tuplet windows** (2 or 4 real beats,
power-of-two aligned) and, failing that, falls back to a **base 1-beat window**.
A base window is a 16th grid by default, a 32nd grid when onsets sit on 32nd
positions, or a sub-beat tuplet (ratios 3 / 5 / 6 / 7 / 12 — eighth-triplet,
quintuplet, sixteenth-sextuplet, septuplet, 32nd-triplet) when a tuplet grid
*strictly* explains the onsets better than any binary grid. Multi-beat windows
claim a tuplet **only for odd ratios** (3 / 5 / 7): an even ratio over a
2^k-beat window (6 or 12 over 2 beats) decomposes into two per-half-window
tuplets — the simpler reading the per-beat scan already produces — so it is
never grouped as one multi-beat tuplet. `inSpace` (VexFlow `notes_occupied`) is
`largestPow2AtMost(num)`: 3→2, 5→4, 6→4, 7→4, 12→8 (the standard 3:2, 5:4, 6:4,
7:4, 12:8 conventions). `buildBarStaff` expands the plan into a **variable** cell
grid; runs inside a tuplet window are decomposed in notated in-space beats
(`len / inSpace` per cell, general over multi-beat windows) and tagged with a
tuplet id (consecutive same-id tickables → one VexFlow `Tuplet`), while
`EngTickable.beat/.beats` stay in **real** beats so playhead/seek are unaffected.

`web/internal/grace.ts` is a pre-pass (ahead of voicing) that lifts **grace
notes** out of the stream and attaches each to its principal. A grace is a short
note squeezed *immediately* against a real note — detection walks backward from
each principal collecting a chain of short notes each within half a 32nd of the
next, so a metrically-spaced 32nd (a full 0.125 beat away) never reads as an
ornament. The engraver renders them as a VexFlow `GraceNoteGroup` modifier
(slashed acciaccatura for a lone grace; beamed + slurred for a group).

## Shape (the hard part is pure + tested)

The genuinely hard half — turning polyphonic, beat-based `Score` data into clean
measures — is a **pure, unit-tested** pipeline, kept renderer-free:

- `web/internal/durations.ts` — `decomposeDuration(beats)` splits a beat-length
  into VexFlow notation pieces (`1.5` → one dotted quarter; `1.25` → a quarter
  tied to a sixteenth; down to 32nds), the vocabulary the engraver and rests draw.
- `web/internal/rhythm.ts` — `planWindows(onsets, barStart, barEnd)` → the
  per-beat subdivision plan (16th / 32nd / triplet / sextuplet). Pure + tested.
- `web/internal/grace.ts` — `extractGraces(notes)` → principal-only `mainNotes`
  plus graces keyed by principal id. Pure + tested.
- `web/internal/voices.ts` — `partitionVoices(notes, opts)` splits a staff's
  notes into ordered independent voices (explicit-voice honored first, else
  inferred). Pure + unit-tested.
- `web/internal/convert.ts` — `convert(score, opts)` → an `EngraveModel`:
  ordered measures of `staves` (each a clef + voices of chords/rests/ties), the
  `parts` layout, key/time-signature metadata, and optional chord symbols. Bars
  come from `bars()`; per voice, notes are quantized to a 1/16 grid and walked in
  Q-steps (a *run* = a span where the sounding set is constant) so chords, rests
  and ties fall out by construction.
- `web/components/engrave.ts` — split into two phases so systems can be windowed:
  - `planEngraving(model, width)` — **pure** layout (no Renderer, no
    DOM, safe in a `useMemo`): runs Pass 1 (measure each measure's minimum width,
    then discards the single-use VexFlow voices) + Pass 2 (greedy line-break),
    computes per-system geometry (`top`, `staffTops`, `boxHeight`, `pitch`,
    `scale`, `startBeat`) and
    the cross-system tie sets (`tieIn`/`tieOut`, keyed `"si:vi"`). Returns an
    `EngravePlan` (all coordinates rebased so each system box starts at y=0).
    Heights vary per system: `web/internal/staff-extent.ts` reads how far each
    staff's ink reaches past its lines (ledger-line notes, stems, tuplet
    numbers, chord symbols) straight from the model's keys, and the plan spaces
    the staves and sizes the box from that — so a high or low passage is never
    clipped by its SVG or drawn into the neighbouring staff. The virtualizer
    takes each system's `pitch` as its exact row size.
  - `drawSystem(host, plan, systemIndex, colors)` — draws ONE system into its own
    `<svg>` (rebuilding fresh voices), returning that system's `{ anchors, notes }`.
- `web/internal/anchors.ts` — `playheadPath(onsets, measures)`: a system's
  beat→x path for the playhead — one point per onset beat at its leftmost x
  (never going back), pulled halfway (`NOTE_PULL`) toward the measure's
  constant-speed position, ending on the closing barline. Engraving does not
  space notes by time, so a playhead pinned to the noteheads goes, stops, goes;
  the blend keeps its speed above half the measure's average while staying
  within half a gap of each note. Pure + tested.
- `web/components/notation-system.tsx` — `<NotationSystem>`: one windowed system
  row. Draws itself in a layout effect and registers its `{ anchors, notes }`
  into a shared `Map<systemIndex, …>` ref (unregisters + clears its SVG on
  unmount), so the parent's imperative playhead reads it with zero React renders.
- `web/components/notation.tsx` — the Display component: measures width via
  `useElementSize`, builds the `plan` in a `useMemo`, **windows** the systems via
  `useVirtualRows` (only near-viewport systems create SVG DOM), and drives the
  playhead + highlight **imperatively** (`useCursorApi().subscribe`, zero
  re-render per frame) from the plan geometry + the drawn-system registry,
  auto-scrolling the active system via `virtualizer.scrollToIndex`.

`capabilities: []` — a reading view that owns its own overlay; it publishes no
shell `Projection`, so the falling-notes overlays / pitch-axis correctly don't
mount here. Config (`config_v2`, registered on web + server): `staffLayout`
(enum auto/grand/perTrack), `separateVoices` (bool), `showChordSymbols` (bool),
`splitPitch` (int, the treble/bass MIDI split). The component drops hidden tracks
(via the `track-mixer` `useHiddenTrackIds` hook) and passes per-track metadata to
`convert` — names (track-mixer override else the score track name) for labels,
plus `gmProgram`/`instrumentHint` from the score's own `tracks` for the `auto`
instrument grouping — while `convert` itself stays pure.

## Resolved (was v1 caveats)

- **True multi-voice + per-track staves.** Each staff is partitioned into
  independent voices with opposed stems; a held note under a moving line stays
  put (no re-articulation) by construction. Tracks map onto staves per
  `staffLayout`; `perTrack` brackets one staff/grand-staff per track.
- **Tuplets, grace notes, sub-16ths** (was the 1/16-grid caveat). Sub-beat
  tuplets (3 / 5 / 6 / 7 / 12) and multi-beat tuplets (a quarter-note triplet
  over 2 beats, a half-note triplet over 4 beats) engrave with a bracket +
  number; 32nd notes engrave; grace notes engrave as acciaccaturas / grace
  groups. See the *Rhythm* section. The `seed-rhythm-etude` bundled starter
  demonstrates these — bar 1 eighth-triplets, bar 2 a 32nd run, bar 3 graces,
  bar 4 a two-beat quarter-triplet + a quintuplet.
- **Virtualized systems + cross-system ties** (was the eager-render + dropped-tie
  caveats). Engraving is split into a **pure** `planEngraving` (all-systems
  layout + measurement, run in a `useMemo`) and a per-system `drawSystem` that
  paints one system into its own `<svg>`. `<NotationSystem>` rows are **windowed**
  via `useVirtualRows`, so on a long score only the near-viewport systems create
  SVG DOM (off-screen systems unmount and leave nothing behind). A tie spanning a
  system break is now drawn as two VexFlow **hanging ties** — a stub off the right
  edge of the ending system's last note and a matching stub in from the left edge
  of the next system's first note — each local to its own system, so the two need
  never be mounted together. The boundary predicate mirrors the in-system tie
  chain exactly (same `"si:vi"` voiceKey, skip if either side is a rest).

## Remaining caveats / follow-ups

- **Display-voice cap.** A staff shows at most `maxVoicesPerStaff` voices
  (default 2, ≤4). Beyond the cap, an overflow line merges into the nearest-pitch
  voice — re-articulation can reappear only at that dense spot. Configurable later.
- **Treble/bass clefs only.** No alto/tenor C-clefs (viola etc. a follow-up).
- **Tuplet scope.** Sub-beat tuplet *windows* (ratios 3 / 5 / 6 / 7 / 12) plus
  **multi-beat** tuplet windows — a quarter-note triplet over 2 beats and a
  half-note triplet over 4 beats — the latter restricted to **odd** ratios on
  power-of-two-aligned windows (an even ratio decomposes into two per-half-window
  tuplets). **Nested** tuplets are still unsupported (a follow-up), and a tuplet
  still may not span a barline.
- **Grace notes are heuristic.** The Score IR has no grace flag, so a grace is
  inferred (a short note chained hard against a principal). Leading graces only;
  trailing/hanging graces are dropped.
- **Pass 1 still measures every measure.** Line-break needs every measure's
  minimum width, so `planEngraving` still runs VexFlow *measurement* (no draw)
  over the whole score. Lighter than draw and windowed away from the draw path;
  a follow-up could estimate widths cheaply then refine if huge scores show jank.
- **Songsheet still eager.** `songsheet` renders all systems at once too, but as
  plain React lines (cheap); virtualize only if it ever shows jank.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata Display: standard staff notation. Engraves the score as a grand staff (treble + bass) with clefs, key/time signatures, barlines, accidentals and rests, following playback with a moving playhead, active-note highlight and auto-scroll. A reading view (no time-axis / pitch-plane capabilities); click a note to seek. Server registration of the notation config (chord-symbol toggle + treble/bass split pitch).
- Web:
  - Contributes:
    - `SonataPlayer.Display` "Notation" → `LazyBoundary`
    - `ConfigV2.WebRegister` "config"
    - `Sonata.ViewOption` "notation"
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/sonata/session` ×2
    - `apps/sonata/track-mixer` ×2
    - `config_v2` ×2
    - `primitives/css/spacing` ×2
    - `apps/sonata/document.useSongDocument`
    - `apps/sonata/player.SonataPlayer`
    - `apps/sonata/shell.Sonata`
    - `primitives/css/center.Center`
    - `primitives/css/coords.Placed`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/scroll.Scroll`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/lazy-component.lazyComponent`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/loading.Loading`
    - `primitives/virtual-rows.useVirtualRows`
- Server:
  - Contributes: `ConfigV2.Register` "config"
  - Uses: `config_v2.ConfigV2`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
