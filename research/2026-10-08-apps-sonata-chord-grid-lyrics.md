# Sonata chord grid — lyrics under the bars

## Context

The Chord grid display (`SP/chord-chart`, `SP` = `plugins/apps/plugins/sonata/plugins`) shows chords only; the
Songsheet display shows lyrics with chords over them. The user wants to mix the two. Prototype
`proto-1791371059-oui6` (option `mix=under`) settled the look:

- Under each row of 4 bars, print the songsheet lines **sung in that row**, verbatim — chord names over the
  lyric text in monospace, chords at their `charOffset` column. The chords appear twice (tile + over the
  words); that is intended.
- **No card, no border, no background** — plain text under the bars.
- Each line starts in the **grid column of the bar it starts in** and spans to the column where the next line
  in that row starts (or the row's end). Two 2-bar lines sit side by side, not stacked.
- Chord names coloured by their degree (the grid's palette), muted; the sounding chord full colour + bold.
  While playing, lines other than the active one dim.
- It is a **view option** of the Chord grid display, off by default (the grid stays as today).

## Design

### 1. Shared lyric-line primitive — new plugin `SP/lyric-line`

Songsheet's line rendering (`SP/songsheet/web/components/songsheet-line.tsx`) is not exported, and the grid
needs the same chord-over-text block minus the button/card chrome. Extract it:

- `core/`: `lyricLines(score): LyricAnnotation[]` (filter `type === "lyric"`, sort by `start` — today inlined
  in `songsheet.tsx`) and `activeLyricChord(lines, beat): { line, chord } | null` (the greatest
  `c.beat <= beat + EPS`, today inlined in songsheet's selector) + the `ActiveChord` type.
- `web/`: `<LyricLineText lyric activeChord? chordStyle? />` — the monospace `Stack` of chord row
  (`Placed x={{start: `${charOffset}ch`}}`) over the text row, exactly songsheet's inner markup. `chordStyle`
  (optional, `(c: LyricChord, active: boolean) => { className?, style? }`) lets a caller colour chords;
  default is songsheet's `text-primary` / `text-primary/70`.
- Songsheet is refactored onto it: `SongsheetLine` keeps its `<button>` + active styling and renders
  `<LyricLineText>` inside. No visual change to Songsheet.

### 2. View option — in `SP/chord-chart`

- `chord-chart/shared/config.ts`: `defineConfig({ fields: { lyrics: <boolean field> "Lyrics under bars",
  default false } })` (use the fields plugin's boolean field, as other Sonata view options do).
- `web/index.ts`: `ConfigV2.WebRegister({ descriptor })` + `Sonata.ViewOption({ id: "chord-chart-lyrics",
  displays: ["chord-chart"], config })`. It then shows in the existing View popover
  (`SP/view-options`) with no edits there.
- The component reads it with `useConfig(descriptor).lyrics`.

### 3. Rows + lyric placement — `SP/chord-chart/web/components/chord-chart.tsx`

Today each section group is one CSS grid of all its bars (`.chord-chart-bars`, 4 cols, 2 under a 34rem
container). With lyrics on, a group renders as **explicit rows of 4 bars**, each followed by its lyric block:

- Pure helper `chord-chart/web/lyric-rows.ts` (unit-tested beside it):
  `placeLyrics(rows: ChordBar[][], lines: LyricAnnotation[]) → per row: { line, col, span, gridRow }[]`.
  - A line belongs to the row of the **last bar whose `startBeat <= line.start + EPS`** (a pickup before bar 1
    goes to the first row; lyrics after the last bar go to the last row).
  - `col` = that bar's index in the row; span ends at the next line-in-row's `col` (or 4).
  - Two lines starting in the same bar: the later one moves to the next grid row (`gridRow` +1) instead of
    overlapping.
- Lyric block: `display: grid; grid-template-columns: repeat(4, minmax(0,1fr))` with the bar grid's gap; each
  line gets `grid-column: col+1 / col+1+span; grid-row`. Under the 34rem container query (bars go 2 per row)
  the block becomes one column and lines stack (`grid-column/row: auto`) — the 4-column placement has no
  meaning there.
- Lines overflow their span rather than wrap (`white-space: pre` is what keeps `ch` alignment); fine for
  typical 2-bar lines — noted as a known limitation.
- With the option off, or a score with no lyric annotations, render exactly as today (one grid per group).

### 4. Chord colour + playback state

- Colour of a `LyricChord`: the `ChordAnnotation` sounding at `c.beat` (already in `bars`' segs) →
  `faces.get(chord).degree` (the grid's existing `chordBoxFace` memo) → `chordColour(degree)` /
  `chordToneStyle` from `@plugins/music/plugins/chord-box/web`. No chord at that beat → outside/grey. Text is
  `c.symbol` verbatim (the songsheet line, not the label mode).
- Active line: `useCursorSelector(beat => lines.findIndex(l => beat >= l.start-EPS && beat < l.end-EPS))`;
  active chord via `activeLyricChord`. Sounding chord: full colour, bold; others colour-mixed toward muted.
  While playing (`useSession().isPlaying`) non-active lines dim. No extra auto-scroll (the active-bar scroll
  already centres the row, and its lyrics are right under it).
- Click a line → `seekTo(line.start)` (a plain `button` with no chrome, focus ring only).

## Files

- New: `SP/lyric-line/{core,web}/index.ts`, `web/components/lyric-line-text.tsx`, `core/lyric-lines.ts` (+ test)
- `SP/songsheet/web/components/{songsheet,songsheet-line}.tsx` — use the primitive
- `SP/chord-chart/shared/config.ts` (new), `web/index.ts`, `web/components/chord-chart.tsx`,
  `web/components/chord-chart.css`, `web/lyric-rows.ts` (+ `lyric-rows.test.ts`)
- `SP/chord-chart/e2e/chord-chart-verify.ts` — extend: toggle the option, assert lyric lines render under rows

## Verification

1. `./equin test plugins/apps/plugins/sonata/plugins/chord-chart plugins/apps/plugins/sonata/plugins/lyric-line`
   — `placeLyrics` cases: two lines in one row side by side, line starting mid-row, two lines in one bar,
   pickup before bar 1, lyrics past the last bar.
2. `./equin build` (checks incl. boundaries, type-check, docs in sync).
3. Screenshots on a song with lyrics (e.g. the user's
   `/sonata/song/79fba881-b633-44b1-b669-36ba996469a7`), Chord grid display, option on and off; plus the
   Songsheet display unchanged. Compare with `proto-1791371059-oui6?mix=under`.
