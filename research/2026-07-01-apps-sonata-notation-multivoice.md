# Sonata notation lens — true multi-voice / per-track staff separation

## Context

The Sonata **notation** Display lens (`plugins/apps/plugins/sonata/plugins/notation/`)
engraves the score as a grand staff via VexFlow. Its v1 is deliberately naive
(documented in `notation/CLAUDE.md`):

1. **One voice per staff.** Every note in the whole score is routed to one of two
   flat lists by a single `pitch >= splitPitch` threshold (treble vs bass), then
   each list becomes a single VexFlow voice. `Note.track` and `Note.voice` are
   never read.
2. **Re-articulation of held notes.** `buildBarStaff` groups notes into *runs*
   keyed by the exact set of note-ids sounding in each 1/16 cell. Any change to
   that set mid-bar (a new onset while another note is held, or one note ending
   while others continue) closes the run and opens a **brand-new chord tickable
   for every id in the new set** — so a sustained note is re-struck whenever a
   neighbour moves. There is no cross-onset tie.
3. **Tracks merged by pitch.** A 4-instrument ensemble collapses onto the same
   two staves by pitch, losing per-instrument identity.

Classically-trained readers expect **independent voices** (SATB, stems
up/down, held notes that stay put) and, for ensemble scores, **per-track
staves** bracketed into a system. This plan delivers both by reshaping the pure
`convert.ts` model and generalizing the VexFlow engraver.

The hard half stays **pure + unit-tested** (`web/internal/`); only the renderer
(`web/components/engrave.ts`) touches VexFlow.

## Key insight — voices are the load-bearing primitive

Both problems reduce to one fix: **stop merging all simultaneously-sounding
notes into a single re-articulated chord; partition each staff's notes into
voices, and build each voice's timeline independently.**

A *voice* is a sequence of note-units that never staggered-overlap: a unit is a
maximal set of notes sharing the **same `[start, end)`** (a real chord). Two
notes that overlap with *different* spans (one held while another moves) must
land in **different voices**. With that invariant, the existing run/quantize/
decompose machinery, run **per voice** instead of per staff, produces clean
tied chords with **no re-articulation by construction** — voice 1's held note is
simply not in voice 2's note-set, so voice 2's onsets can't re-strike it.

So the redesign is: **partition → build each voice with the existing
`buildBarStaff` logic → stack voices on a staff with opposed stems → stack
staves into a system.**

## Data-model redesign (`web/internal/convert.ts`)

Generalize the two-field `EngMeasure` into a part → staff → voice hierarchy.
`EngTickable` is **unchanged**.

```ts
/** One independent melodic line on a staff (own stem direction). */
interface EngVoice {
  tickables: EngTickable[];
  /** "up" for the upper voice of a 2-voice staff, "down" for the lower, "auto" when alone. */
  stem: "up" | "down" | "auto";
}

/** One staff of a measure: a clef + 1..N voices. */
interface EngStaff {
  clef: "treble" | "bass";
  /** Owning part/track id — for bracketing + the system label. */
  partId: string;
  voices: EngVoice[];
}

/** One measure, spanning every part top-to-bottom. */
interface EngMeasure {
  index: number;
  startBeat: number;
  timeSig: { numerator: number; denominator: number };
  keyName: string;
  keyChanged: boolean;
  staves: EngStaff[];         // ordered top→bottom across ALL parts
  chordSymbol?: string;
}

/** Part metadata, ordered top→bottom, for brackets + labels. */
interface EngPart {
  id: string;
  name?: string;
  /** Indices into EngMeasure.staves this part owns (1 = single staff, 2 = grand). */
  staffCount: 1 | 2;
}

interface EngraveModel {
  measures: EngMeasure[];
  parts: EngPart[];
  /** True when >1 part → draw a system bracket; false → single part, brace only. */
}
```

Every measure carries the **same `staves` shape** (same count + clef + partId
order) so the engraver can stack/connect uniformly across a system. Empty
staves in a given measure are filled with a whole-measure rest voice.

## Pipeline (pure, per measure)

1. **Group notes into parts.** Decide the layout mode (see config below):
   - **`grand` (default for a single track, or "merge all"):** one part whose id
     is `"_grand"`, containing **all** notes. Two staves, treble/bass split by
     `splitPitch` — the familiar piano look, now voice-separated.
   - **`perTrack`:** one part per `Note.track` (ordered by descending mean pitch,
     then track order). Each part's notes get a staff layout:
     - wide range (notes well below *and* above `splitPitch`) → grand staff
       (treble+bass split) for that part;
     - otherwise a single staff, clef = treble if the part's median pitch ≥
       `splitPitch` else bass.
   - **`auto`:** `grand` when there is exactly one (non-empty, non-hidden) track,
     else `perTrack`.

2. **Assign each part's notes to its staff/staves** (pitch split when grand).

3. **Voice-partition each staff** (the new pure module, see below) → ordered
   voices (top→bottom), capped at `maxVoicesPerStaff` (default 2, classical max
   4).

4. **Build each voice** with the existing `buildBarStaff(segs, barStart, barEnd)`
   — unchanged logic, now fed one voice's segs. Because a voice never
   staggered-overlaps, runs collapse to the real note-units and ties are only
   the legitimate duration/barline ties. Assign `stem` per voice index (2-voice:
   up/down; 1-voice: auto). Fill gaps with rests (already handled by
   `buildBarStaff`'s empty runs).

5. **Assemble** `EngStaff[]` for the measure in part order, plus `chordSymbol`
   (unchanged).

### New pure module: `web/internal/voices.ts`

`partitionVoices(notes: NoteLike[], opts): VoiceGroup[]`

- **Explicit voices honored first.** If notes carry `voice` numbers, group by
  `voice`; order groups by descending mean pitch (top voice first). This is the
  clean path — sources that know their voicing (chord grids, multi-track MIDI)
  declare it.
- **Inference fallback** when `voice` is absent: interval-graph greedy coloring
  with a pitch-coherence tiebreak.
  - Collapse notes with identical `[start, end)` into chord-units.
  - Sweep units in onset order; assign each to the highest-priority existing
    voice that is **free** (its last unit ends ≤ this unit's start) — preferring
    the voice whose pitch lane this unit best continues (keep higher pitches in
    lower-indexed voices) — else open a new voice (up to `maxVoicesPerStaff`).
  - If the cap is exceeded (≥3 genuinely staggered simultaneous lines), the
    overflow unit merges into the nearest-pitch voice (re-articulation may
    reappear only at that dense spot — documented, matches engraving convention
    that caps display voices).
  - Re-sort the resulting voices by descending mean pitch so voice 0 is always
    the upper line (stems up).

Unit-tested (`voices.test.ts`): held-note-vs-moving-note → 2 voices, no
re-strike; block chord (same start+end) → 1 voice; SATB four-part → ≤4 voices in
pitch order; explicit `voice` honored verbatim.

## Engraver generalization (`web/components/engrave.ts`)

The engraver currently hardcodes treble@`trebleY` + bass@`bassY`, one brace,
time-sig on both. Generalize to **N staves per system, M voices per staff**:

- **Vertical layout.** A system's height = `staveCount * (STAFF_HEIGHT + intra
  gap) + inter-part gaps`. Compute per-staff Y from the measure's `staves` order.
  Keep `STAFF_GAP` within a grand-staff part; a slightly larger gap between
  distinct parts.
- **Connectors.**
  - Per grand-staff part: `brace` + `singleLeft` spanning its 2 staves (today's
    behavior).
  - When `parts.length > 1`: a `bracket` spanning the whole system, one
    `singleLeft`, and `singleRight` barlines spanning **all** staves per measure.
- **Clefs / key sigs** per staff at system start (each staff's own clef).
  Time-sig on every staff of the **score's first** system (as today, but for all
  staves).
- **Voices per staff.** Build one VexFlow `Voice` per `EngVoice`; set
  `stem_direction` from `EngVoice.stem` (`Stem.UP`/`Stem.DOWN`; omit for
  `auto`). For rests in a 2-voice staff, nudge the rest line up/down so they
  don't collide (VexFlow `setStemDirection` + a rest-line offset, or rely on
  voice formatting). `joinVoices` **all** voices of the measure (all staves)
  into one `Formatter` so onsets align horizontally across the system. Beams +
  ties generated per voice.
- **Anchors / note-tagging.** `BeatAnchor`s and highlight `NoteEl`s aggregate
  across every staff+voice (same as today's treble+bass, generalized). Same-beat
  notes across voices share an x via the joint formatter.
- **Part labels (optional, perTrack only).** Draw each part's `name` as a small
  left-margin label on the first system. Keep monochrome (sheet-music
  authenticity); per-track color is intentionally **not** used here.

`SystemBox`/playhead/auto-scroll in `notation.tsx` already key off
`result.systems` + `result.anchors`; they need **no change** beyond the engraver
returning correct boxes for the taller systems.

## Config (`shared/config.ts`) + UX

Replace the lone `splitPitch` knob with a small, curated set:

```ts
staffLayout: enumField({           // see existing enum field pattern in fields/
  label: "Staff layout",
  options: [
    { value: "auto",     label: "Auto" },        // grand for 1 track, per-track for many
    { value: "grand",    label: "Grand staff" }, // merge all tracks, treble/bass split
    { value: "perTrack", label: "Per track" },   // one staff/grand-staff per track
  ],
  default: "auto",
}),
separateVoices: boolField({ label: "Separate voices", default: true }), // stems up/down
splitPitch: intField({ ... unchanged ... }),     // still drives grand-staff clef split
showChordSymbols: boolField({ ... unchanged ... }),
```

- **Quick chip** (`Sonata.ViewOption`): expose `staffLayout` (segmented) +
  `showChordSymbols` in the in-player HUD — `splitPitch`/`separateVoices` stay in
  the generic Settings pane. (Verify an `enumField` config primitive exists
  under `fields/`; if a segmented enum field type is missing, fall back to the
  existing select/enum field and file a follow-up — do **not** hand-roll a
  bespoke control.)
- `separateVoices=false` reproduces the v1 single-voice-per-staff look (escape
  hatch); default `true` is the new behavior.

### Hidden-track integration (reuse existing primitive)

`notation.tsx` reads `useHiddenTrackIds()` /track names via the existing
`track-mixer` web barrel (already consumed by piano-roll:
`apps/sonata/track-mixer.useHiddenTrackIds`, `.useTrackColorMap`) and filters
`score.notes` to drop hidden tracks **before** `convert()`. Pass `TrackMeta`
names through so per-track staves can be labeled. `convert.ts` stays pure (no
hooks) — the filtering happens in the component, the names are passed in `opts`.

## Files to modify

- `plugins/apps/plugins/sonata/plugins/notation/web/internal/convert.ts` —
  new model types; part/staff grouping; call `partitionVoices`; build per voice.
- `plugins/apps/plugins/sonata/plugins/notation/web/internal/voices.ts` — **new**
  pure voice-partition module (+ `voices.test.ts`).
- `plugins/apps/plugins/sonata/plugins/notation/web/internal/convert.test.ts` —
  extend for parts/voices/no-re-articulation.
- `plugins/apps/plugins/sonata/plugins/notation/web/components/engrave.ts` —
  N-staff / M-voice layout, connectors, stems, labels.
- `plugins/apps/plugins/sonata/plugins/notation/web/components/notation.tsx` —
  read new config + `useHiddenTrackIds`/track names; filter notes; pass through.
- `plugins/apps/plugins/sonata/plugins/notation/shared/config.ts` — new fields.
- `plugins/apps/plugins/sonata/plugins/notation/web/index.ts` — `Sonata.ViewOption`
  field list (+ any new web `Uses`).
- `plugins/apps/plugins/sonata/plugins/notation/CLAUDE.md` — update caveats →
  resolved; note the new model + remaining caps (max voices, tuplets).

Reuse (no new deps): existing `buildBarStaff`/`decomposeDuration`/`bars`/
`effectiveKeyAt`/`makeKeySpeller` in score-core; VexFlow `Stem`,
`StaveConnector("bracket")`, `Voice.setStemDirection`; `track-mixer` web hooks;
`fields` enum/bool/int config primitives.

## Verification

1. `./equin build` (regenerates docs/registry; runs checks).
2. `bun test plugins/apps/plugins/sonata/plugins/notation/web/internal` — pure
   converter + voice-partition unit tests (held-note no-re-strike, SATB, explicit
   voices, per-track grouping).
3. Screenshot/e2e at `http://<worktree>.localhost:9000` →
   open Sonata → a multi-track song → Notation lens:
   - single-track piano piece: grand staff, a held note under a moving line shows
     **one notehead with a tie**, not a re-strike; stems split up/down.
   - multi-track ensemble: one bracketed staff (or grand staff) per track; toggle
     `Staff layout` Auto/Grand/Per-track and confirm re-engrave; hide a track in
     the mixer → its staff disappears.
   Use `e2e/screenshot.mjs --url … --click "Notation"`.

## Caveats / follow-ups (post-change)

- **Max voices per staff** capped (default 2, ≤4); ≥3 staggered lines beyond the
  cap merge (rare re-articulation at that spot only). Configurable later.
- **Per-staff clef** limited to treble/bass (no alto/tenor C-clefs) — fine for
  piano/most ensembles; viola etc. a follow-up.
- **Cross-system ties** still dropped (pre-existing); **1/16 quantization** and
  **no tuplets** unchanged.
- If a segmented `enumField` config primitive is missing, file a follow-up to add
  one to `fields/` rather than hand-rolling a control here.
</content>
</invoke>
