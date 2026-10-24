# Sonata chord grid display + chord list — v2

Supersedes `2026-10-07-apps-sonata-chord-grid-display.md`. What changed:

- **One shared component.** The grid reuses the Chord app's **chord box**: its shape, paint, numeral and states. It is extracted into a neutral plugin and nothing else from the Chord app is shared. Plain paint alone is not enough.
- **A second surface.** A new side-pane section lists every chord in the song with a keyboard, built from the same chord box.

The mock is `proto-1791371059-oui6`. The user approved its structure:

- bar rows grouped under section headers;
- beat-weighted splits inside a bar, held chords drawn as ties;
- the active bar outlined and the active chord ringed;
- a beat line through the current bar;
- a side-pane "Chords" card with one row per distinct chord: box, keyboard, use count.

The fill style is no longer a choice. It is the Chord box's own look.

## Context

Sonata has no full-surface chord-grid view, and it has no list of a song's chords with their notes.

The Chord app already has the look we want:

- **The colour** is the root's major-scale degree relative to the tonic. I is orange, ii gold, iii rose, IV sage, V blue, vi violet, vii teal; a root outside the scale is grey.
- **The tile** is that colour deepened toward black, with the ink washed toward white.
- **The numeral** is the Bodoni serif with a raised sans mark.

That look is spread across `chord/vocabulary` and `chord/trainer`:

- `chord-tone.ts` and `chord-paint.css` hold the paint.
- `chord-numeral.tsx` holds the numeral.
- The `.chord-box` rules in `trainer.css` and `AnswerBox` in `answer-strip.tsx` hold the box.
- The hex values exist only as Chord's theme overriding `--categorical-1…7, 10`.

Sonata must not import `apps/chord`, so the box moves to a neutral place.

Decisions with the user:

- Palette: a themable token group.
- Reuse: the chord box only.
- Cell text: follows Sonata's chord-label mode (symbol / roman / both).
- The Progression strip and the piano-roll overlay keep their current look.

## Phase 1: Shared chord box

### 1a. Token group `ui/tokens/plugins/chord-palette`

This is modelled on `ui/tokens/plugins/file-type-palette`.

- **`core/group.ts`:** `chordPaletteGroup`, with keys `chord-1` … `chord-7` and `chord-outside`.
  - Dark values are Chord's hex values.
  - Light values are the same hues; the tile mixes toward black on either ground, as the mock shows.
- **`web/index.ts`:** `ThemeEngine.TokenGroup` + `ThemeCustomizer.Section` "Chord colours".

### 1b. `plugins/music/plugins/chord-box`

This needs a new `music` umbrella. The plugin knows pitch classes and strings only; it imports no app.

**`core`**

- `majorDegree(rootPc, tonicPc): 0..6 | null`, moved from `chord/vocabulary/core/degree.ts` (`MAJOR_SCALE`).

**`web`**

- `chordToneStyle(degree)` sets `--fn: var(--chord-N | --chord-outside)` and `--fn-depth` (the `TILE_DEPTH` table).
- `chord-box.css` holds the moved CSS:
  - `.chord-tone`, `.chord-num`, `.chord-num-mark`, from `chord-paint.css`;
  - the box rules from `trainer.css`: `.chord-box` (`container-type`, radius, dashed empty edge, the `cqi` numeral size), `[data-filled]`, `[data-given]`, `[data-selected]`, `[data-now]`, `.chord-box-hit` hover/focus, `.chord-box-name`.
  - Fallbacks become `--chord-outside`.
- `<ChordNumeral numeral mark />` is the presentational half of Chord's component.
- `<ChordBox>` renders the frame and its content:

```ts
type ChordBoxLabel =
  | { primary: "numeral"; numeral: string; mark: string; name?: string } // Chord's look: numeral, name under it
  | { primary: "name"; name: string; numeral?: { numeral: string; mark: string } };
interface ChordBoxProps {
  degree: number | null;                 // paint
  state: "filled" | "given" | "empty";
  label?: ChordBoxLabel;                 // absent = no text (a held tie, an empty answer)
  now?: boolean; selected?: boolean;
  hit?: { onClick; ariaLabel; disabled?; pressed? };   // the full-bleed button BEHIND the content (Overlay), as AnswerBox does today
  children?: ReactNode;                  // replaces the label content (the trainer's struck "missed" pair)
  className?; style?; /* data-* passthrough for surface-only states (mark, pop) */
}
```

### 1c. Migrate Chord onto it

There should be no visual change.

- **`vocabulary`:**
  - `chordDegree(token)` becomes `majorDegree(parseChordToken(token).root, 0)`.
  - `chordToneStyle(token)` becomes a thin wrapper over the shared one.
  - `ChordNumeral({ token })` wraps the shared component with `chordLabel(token)`.
  - Delete `chord-paint.css`.
- **`trainer/answer-strip.tsx`:** `AnswerBox` renders `<ChordBox>` and passes `hit`, `children` for the missed pair, and `data-mark` / `data-pop`.
  - `trainer.css` keeps only what belongs to the trainer: `[data-mark]`, `[data-pop]`, `.chord-badge`, `.chord-box-pair`, `.chord-missed`.
  - `chord-buttons.tsx` and `progress-panel.tsx` only change their imports.
- **`piano.css`, `chord-logo.tsx`:** switch from `--categorical-N` / `fill-categorical-N` to `--chord-N`.
- **`shell/.../theme.ts`:** the categorical fragment becomes a `chordPaletteGroup` fragment.

## Phase 2: Shared bar slicing (Sonata)

Move `buildBars` from `rich/chord-progression/.../chord-progression.tsx` into `score/core/chord-bars.ts` as `chordBars(score)`, without changing it, and add tests. The Progression strip imports it and does not change.

## Phase 3: Display `sonata/plugins/chord-chart`

The display is labelled "Chord grid". The plugin name avoids `sources/chord-grid`.

- **Contribution:** `SonataPlayer.Display({ id/match: "chord-chart", label: "Chord grid", icon: symbol("grid-view"), capabilities: [] })`.
- **States:** follows `songsheet.tsx`. A failed document shows `ResourceErrorInline`, a pending one `<Loading/>`, a song without chords a placeholder.
- **Layout:** rows of 4 bars (2 when narrow) from `chordBars`, under the `SectionAnnotation` headers. The bar cell is the grid's own chrome: neutral frame, bar number, beat dots.
- **Segments:** inside a cell, each segment is a `<ChordBox>` with a flex weight equal to its beats.
  - A struck chord is `state="filled"`.
  - A chord held over the barline is `state="given"` with no label, drawn as a tie.
  - `now` marks the chord under the playhead.
  - `hit.onClick` calls `seekTo(start)`.
- **Degree:** `majorDegree(chord.data.root, tonicPc(effectiveKeyAt(score, chord.start)))`. A missing key gives `null`, which paints grey.
- **Label:** comes from `useChordDisplayMode()`.
  - `roman` is the numeral alone.
  - `both` is the numeral with the symbol under it, exactly Chord's look.
  - `symbol` is the symbol as the primary text.
  - Numeral parts come from `theory/core`. Add a `romanNumeralParts` beside `romanNumeral` if no split exists.
- **Playback:**
  - `useCursorSelector` gives the active bar and the active chord, and only reconciles on boundaries.
  - The beat line is a CSS variable written from `useCursorApi().subscribe`, so there is no React render per frame.
  - `revealElement` brings the active row into view while playing.
- **Overlays:** `Sonata.Hud` is pinned top-right.

## Phase 4: Side-pane section `sonata/plugins/rich/plugins/chord-list`

- **Contribution:** `Sonata.Section({ id: "chord-list", label: "Chords", area: "player", useAvailable: useHasChords })`, beside Progression and Current chord.
- **Rows:** one row per distinct chord, in order of first appearance, keyed by spelled symbol plus root. Each row has:
  - a small `<ChordBox state="filled">` with the label from the same mode;
  - Sonata's `Keyboard` (`primitives/keyboard`) on a plane from `usePitchGeometry` over the fitted voicings' range, as `chord-readout` does. It is lit from `chordPitches(data)` as a `Map<pitch, "var(--chord-N)">`, so the keys wear the chord's colour, with `skin={useSonataKeySkin()}`;
  - a ×N use count.
- **Behaviour:**
  - Clicking a row seeks to the chord's first occurrence.
  - The row of the chord under the playhead is marked `now`.
  - The list is a `DataView` list if the row shape fits (domain records); otherwise justify the `Row` map with the lint annotation.

## Critical files

- **New:**
  - `ui/tokens/plugins/chord-palette`
  - `music/plugins/chord-box`
  - `apps/sonata/plugins/score/core/chord-bars.ts`
  - `apps/sonata/plugins/chord-chart`
  - `apps/sonata/plugins/rich/plugins/chord-list`
- **Changed:**
  - `apps/chord/plugins/vocabulary/{core/degree.ts,web/chord-tone.ts,web/components/chord-numeral.tsx}`
  - `apps/chord/plugins/trainer/web/components/{answer-strip.tsx,trainer.css}`
  - `apps/chord/plugins/piano/web/piano.css`
  - `apps/chord/plugins/shell/web/{internal/theme.ts,components/chord-logo.tsx}`
  - `apps/sonata/plugins/rich/plugins/chord-progression/web/components/chord-progression.tsx`

## Verification

1. **Tests:** `./equin test` on `score` (chord-bars), `music/chord-box` (`majorDegree`), and the existing Chord `vocabulary` tests.
2. **Build:** `./equin build`, which runs boundary-rules, plugin-boundaries and docs-in-sync.
3. **Chord unchanged:** `screenshot.ts --path /chord` before and after. The answer strip (empty, filled, given, checked right/wrong, now), the chord buttons and the logo must match pixel for pixel.
4. **Sonata:**
   - On a chord-grid song and a UG song, pick "Chord grid".
   - Play, then click a cell and confirm it seeks.
   - Check light and dark, and all three label modes.
   - Check the Chords section's rows, keyboards, counts and active row.
   - Compare against `proto-1791371059-oui6`.
5. **Progression strip:** identical before and after (phase 2).
