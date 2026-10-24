# Sonata — Chord Progression strip (rhythm-aware chord chips)

## Context

The Sonata player shows a piano roll plus, in the right-hand panel, a **Current
chord** readout (one chord at a time) and a **Key** readout. There is no view of
the *whole* progression — you can't see what's coming, where you are in the song,
or the rhythm of the chord changes at a glance.

This adds a **Progression** panel beside the piano roll: every chord of the song
rendered as a chip, laid out bar-by-bar, with each chip sized by its duration so
the rhythm of the `(C .. D)` mini-language is shown visually. The chip(s) under
the playhead are highlighted as the transport advances, and clicking a chip seeks
there.

Why it's a faithful "rhythm visualization equivalent of the mini-language": the
chord-grid language expresses rhythm through bars + within-bar groups + holds
(`(E E6)` splits a bar in two; `(C . . D)` → C for 3 beats, D for 1; `Cmaj7 . .`
holds across 3 bars). All of that is already baked into the canonical
`ChordAnnotation` start/end beats in the `Score`. Laying chips out per bar and
sizing each by its beat-span within the bar **reconstructs that rhythm directly
from the Score** — so it works identically for authored chord-grids *and*
analyzer-derived chords, with zero coupling to the mini-language parser.

## Approach

A new plugin `chord-progression` under the existing `rich` umbrella (alongside
`chord-readout`, `chord-overlay`, `key-readout`), contributing one
`Sonata.Section` (`area: "player"`) to the right-hand `SectionPane` — the same
column as the Current chord readout. No new layout region; mirrors the
established readout-panel pattern.

### Data — source-agnostic, read from the Score (no re-parsing the mini-language)

Read `score.annotations`, filter `type === "chord"` (exactly as `ChordReadout`
does). This is the narrow waist: authored *and* derived chords both land here.

Bar boundaries come from `bars(score)` (`score/core` →
`plugins/apps/plugins/sonata/plugins/score/core/helpers.ts:194`), which derives
each bar's `startBeat` from `timeSigMap` + `meta.pickupBeats` (handles non-4/4
and pickup bars). Build a render model once (`useMemo` keyed on
`score.annotations`):

For each bar `[barStart, barEnd)` (barEnd = next bar's startBeat, last bar uses
`scoreEndBeat`), collect chord annotations overlapping it and, for each, a
segment:

```
segStart = max(chord.start, barStart)
segEnd   = min(chord.end,   barEnd)
grow     = (segEnd - segStart) / (barEnd - barStart)   // flex weight within the bar
isContinuation = chord.start < barStart                // a held chord carried over
```

This single overlap model reproduces every rhythm case uniformly:
- one chord/bar → one full-width chip;
- group `(E E6)` → two half-width chips in the bar;
- `(C . . D)` → C at 3/4 width, D at 1/4;
- top-level hold `Cmaj7 . .` → a struck chip in bar N, then **continuation** chips
  (ghosted, no re-strike emphasis) in bars N+1, N+2 — reads as a tie.

Each chip keeps a reference to its source annotation (stable, from the memoized
filtered array) for highlight matching.

### Layout (rhythm)

- Bars arranged in a wrapping grid, **4 bars per row** (CSS grid
  `repeat(4, minmax(0, 1fr))`), matching the attached screenshot's lead-sheet feel.
- Each bar cell is a flex row of its chips; each chip is `flex-grow: <grow>`,
  `flex-basis: 0`, `min-w-0` so widths are proportional to duration and dense
  bars still fit (label truncates). Thin separators between bars; chips within a
  bar sit flush so a split bar reads as one cell divided.
- Chip = the `Badge`/`ToggleChip` primitive from
  `primitives/css/{badge,toggle-chip}/web`, monospace label (`chord.data.symbol`),
  `shape="rect"`. Continuation chips are dimmed (muted bg, lower-opacity label).
  The proportional `flex-grow` is the one genuine mechanic not covered by a layout
  primitive — isolate it with a justified `eslint-disable` (per the css skill).

### Active highlight + interaction

- Track the active chord with `useCursorSelector` (re-renders only on chord-boundary
  changes, not per frame) using the same selector as `ChordReadout`:
  `chords.find(c => beat >= c.start && beat < c.end) ?? (beat <= 0 ? chords[0] : undefined)`.
- A chip is active when `chip.annotation === activeChord` (reference equality);
  highlight via `ToggleChip active` (solid) vs inactive (ghost). A held chord's
  strike + continuation chips all highlight together.
- Click a chip → `seekTo(chip.annotation.start)` from `useSonata()`
  (`shell/web/context.tsx:198`). Use `ToggleChip`'s `as`/onClick (polymorphic
  button) so it's keyboard-accessible.
- Empty state: when `chords.length === 0`, render `null` (keep the panel
  uncluttered — the Current chord readout already owns the "No chords" message).

### No config, no server, no schema

Pure presentational consumer of existing context — no DB, no endpoint, no
config_v2. (4-bars-per-row is a constant for v1; promote to config later only if
asked.)

## Files

New plugin `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-progression/`:

- `web/index.ts` — barrel. Mirror `chord-readout/web/index.ts` exactly:
  `export default { description, contributions: [ Sonata.Section({ id: "chord-progression", label: "Progression", icon: <Md…>, component: ChordProgression, area: "player" }) ] } satisfies PluginDefinition`.
  (Barrel purity: imports + single default export only.)
- `web/components/chord-progression.tsx` — the component described above.
- `package.json` — mirror `chord-readout/package.json`
  (`@singularity/plugin-apps-sonata-rich-chord-progression`).
- `CLAUDE.md` — short prose (what/why, the bar-overlap rhythm model) + an empty
  autogen reference block (`./equin build` fills it).

No edits to existing files: the plugin is discovered by the filesystem walk and
auto-registered into the generated registry on build; `SectionPane` already
renders every `area:"player"` Section. Reorder is automatic (it's a render slot),
so the user can drag Progression above/below Current chord.

### Key references to reuse

- `score/core` barrel: `bars`, `scoreEndBeat` (bar math), types `Annotation`,
  `ChordData`, `Score`.
- `shell/web` barrel: `useSonata` (`score`, `seekTo`), `useCursorSelector`.
- `primitives/css/{badge,toggle-chip,text,card,spacing}/web` — chip + panel chrome
  (match `ChordReadout`'s `Card` shell + `Text` section label).
- Precedent to copy byte-for-byte: `rich/plugins/chord-readout/` (index, package,
  the `chords` memo + `useCursorSelector` selector).

## Verification

1. `./equin build` (from this worktree). Fixes any type/boundary issues;
   `plugins-registry-in-sync` + `plugins-doc-in-sync` checks confirm the new
   plugin registered and its CLAUDE autogen block is filled.
2. Open `http://att-1781708263-4dty.localhost:9000/sonata`, open a chord-grid song
   (e.g. one authored with `Amaj9 Am9 (E E6) ...`). Confirm the **Progression**
   panel appears in the right column with one chip per chord, groups split within
   a bar, holds shown as ghosted continuation chips.
3. Press Space (play). Confirm the chip under the playhead highlights and advances
   chord-by-chord in sync with the Current chord readout; verify no per-frame
   re-render jank (highlight flips only on chord boundaries).
4. Click a chip → playhead/roll seeks to that chord's start beat.
5. Open a MIDI song (derived chords, no authored grid) → confirm the strip still
   populates from analyzer annotations (source-agnostic).
6. Scripted check (optional), e.g.
   `bun e2e/screenshot.mjs --url http://att-1781708263-4dty.localhost:9000/sonata/song/<id> --click "Progression" --out /tmp/prog`
   for a before/after capture.
```
```
