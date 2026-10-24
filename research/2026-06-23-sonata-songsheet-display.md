# Sonata — chord-over-lyrics songsheet display (Task 7)

**Date:** 2026-06-23
**Category:** apps/sonata
**Status:** Plan — implementing (autonomous)
**Parent:** research/2026-06-22-sonata-ultimate-guitar-source.md (Task 7)

## Goal

A new `Sonata.Display` — a chord-over-lyrics **songsheet** — that renders lyrics
with chords positioned above each syllable, grouped by section, auto-scrolling to
follow the playback cursor. It slots into the existing display picker beside the
piano-roll (same `Sonata.Display` dispatch slot).

## Key design decision — preserve chord column placement in the lyric layer

The task's defining UX is **chords above the syllable they sound on**. The UG
parser already computes this as `ParsedChord.charOffset` (the visible column over
the lyric). But the current `compile()` (Task 5) **discards** `charOffset`: it
emits whole-line `LyricData = { text }` annotations plus chord-per-bar
`ChordAnnotation`s. Because UG timing is *synthesized* (one bar per chord, evenly
spaced), the chord **beats do not correspond to word positions** — so positioning
chords by beat would space them evenly and miss the words. The only faithful
signal is `charOffset`.

Worse, `compile()`'s own comment says the raw lyric's "leading columns are
load-bearing for chord alignment" — but there is nothing to align to once the
chord columns are dropped. A latent inconsistency.

**Fix (clean, structural):** make the lyric layer a faithful *songsheet line* —
each lyric annotation carries the chords printed over it, with their character
offsets. This makes the songsheet trivial *and* makes any future lyric-bearing
source (LRC, MusicXML) map the same way.

### IR change — `score/core/types.ts`

```ts
/** A chord printed over a lyric line at a visible character column. */
export type LyricChord = {
  /** Chord symbol as written/displayed (verbatim, e.g. "Cmaj7", "N.C."). */
  symbol: string;
  /** 0-based visible column in `text` where the chord sits (may exceed text.length). */
  charOffset: number;
  /** Beat the chord sounds on — syncs the active-chord highlight to the cursor. */
  beat: number;
};

/** A songsheet line: lyric words plus the chords printed over them by column. */
export type LyricData = { text: string; chords: LyricChord[] };
```

`chords` is **required** (not optional): every lyric annotation is a full
songsheet line. `compile()` is the only producer; no other consumer exists yet.

Two distinct projections of the same source, by design (mirrors notes vs chord
annotations already coexisting):
- **chord annotations** — the *playable harmony* timeline (recognised chords
  only → voiced notes; consumed by audio, piano-roll, analyzers).
- **lyric-line chords** — the *printed page* (all symbols verbatim, incl.
  unrecognised "N.C."; consumed by the songsheet).

### compile change — `ultimate-guitar/web/compile.ts`

In the per-line loop, accumulate `lineChords: LyricChord[]`, pushing
`{ symbol: chord.symbol, charOffset: chord.charOffset, beat: start }` for **every**
parsed chord (recognised or not). Keep emitting `ChordAnnotation` + `ChordEvent`
only for recognised chords (unchanged). Emit a lyric annotation whenever the line
has a lyric **or** chords — so chord-only / instrumental lines render in the
songsheet too (text `""`, chords populated). Update `compile.test.ts`.

## The display plugin

New top-level plugin mirroring `piano-roll`'s shape:
`plugins/apps/plugins/sonata/plugins/songsheet/` (a Display, not a `rich/`
Section — it slots into the display picker).

```
songsheet/
  package.json
  web/
    index.ts                       # Sonata.Display contribution
    components/songsheet.tsx        # scroll body: sections → lines, cursor sync
    components/songsheet-line.tsx   # one line: chord row (abs by ch) + lyric row
```

### Contribution

```ts
Sonata.Display({
  match: "songsheet", id: "songsheet", label: "Songsheet",
  icon: MdLyrics, capabilities: [], component: Songsheet,
})
```

`capabilities: []` — no time-axis pixel geometry, no pitch-plane; it is a reading
view, so capability-filtered overlays / pitch-axis (chord overlay, piano keyboard)
correctly do not mount. Host the capability-free `<Sonata.Hud.Render/>` (key chip)
for consistency with the piano-roll.

### Rendering

- Read `score.annotations`: lyric annotations (sorted by `start`) = lines;
  section annotations group them (a line's section = the section annotation whose
  `[start,end]` contains the line's `start`). Render section headers as dividers.
- Each line = two stacked rows in a **monospace** context (`font-mono`,
  `whitespace-pre`):
  - **chord row**: each `LyricChord` absolutely positioned at `left: <charOffset>ch`
    (1ch = one monospace column = exact alignment). Chord symbols in an accent
    color; the active chord brighter/bolder.
  - **lyric row**: the raw text (leading spaces preserved). Empty for
    instrumental lines.
- **Cursor sync** (no per-frame re-render): `useCursorSelector` to derive the
  active line index (re-renders only when the active line changes — bailout, like
  `rich/chord-progression`). Highlight the active line (subtle bg + left accent);
  a second selector derives the active chord within the line.
- **Auto-scroll**: when playing and the active line changes, smooth-scroll it to a
  comfortable position (`scrollIntoView({ behavior: "smooth", block: "center" })`).
  Gated on `useSonata().isPlaying` so a paused user can browse freely.
- **Click-to-seek**: clicking a line seeks the transport to its `start` beat
  (`useSonata().seekTo`).
- **Empty state**: a song with no lyric annotations (MIDI, chord-grid) shows a
  friendly `Placeholder` ("No lyrics to display as a songsheet").

`tempoScale` prop is unused (the songsheet works purely in beat space; scroll is
line-granular, not pixel-time).

## Verification

- `./equin build` (migrations/registry/docs + checks).
- `bun test .../ultimate-guitar/web/compile.test.ts` — chords/beats/charOffset in
  lyric annotations; instrumental lines emit a lyric annotation.
- Scripted Playwright: import the example UG tab, open it, switch the display
  picker to Songsheet, screenshot, press play, confirm active-line highlight +
  auto-scroll; toggle back to Piano Roll.
- `./equin check`.

## Known limitations / follow-ups

- **Line wrapping.** Monospace `whitespace-pre` lines do not wrap; long lines
  overflow horizontally (body x-scrolls). Acceptable v1; a wrapping/column-reflow
  pass that keeps chord alignment is a refinement.
- **Chord overlap.** Two close chords can visually overlap (symbol wider than the
  column gap), as on UG itself. A push-apart layout is a refinement.
- **Per-score display availability.** The picker lists the songsheet for every
  song (Display contributions are static); no-lyric songs get the empty state.
  Filtering displays by score capability is a possible future slot enhancement.
