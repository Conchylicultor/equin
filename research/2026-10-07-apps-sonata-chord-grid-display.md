# Sonata chord grid display, painted in the Chord app's colours

## Context

Sonata has no chord-grid view of a song: bars as cells, the chords of each bar inside its cell, following playback. The nearest thing is the **Progression** strip (`sonata/plugins/rich/plugins/chord-progression`), a small side-section that already slices chords bar by bar, but it is not a player display and draws neutral chips.

The Chord app paints every chord by **the major-scale degree of its root, relative to the tonic**:

| Degree | I | ii | iii | IV | V | vi | vii | outside the scale |
|---|---|---|---|---|---|---|---|---|
| Colour | `#EC8A3A` orange | `#E2B23A` gold | `#DE6A9A` rose | `#7FB685` sage | `#3AA4D0` blue | `#9C6FE6` violet | `#2FB5A8` teal | `#8C8A85` grey |

How it does this today:

- `chord/vocabulary/web/chord-tone.ts` sets `--fn` / `--fn-depth`.
- `chord-paint.css` derives `--fn-bg` (an OKLCH mix toward black) and `--fn-ink` (the colour washed to white). It also styles `.chord-num`, the serif numeral.
- The hex values exist **only** because Chord's own theme (`chord/shell/web/internal/theme.ts`) overloads `--categorical-1…7, 10`. In Sonata those tokens are different colours.

The goal is a Sonata chord grid that reads like Chord, built on shared code in a neutral place. Sonata must not import `apps/chord`.

Decisions taken with the user:

- **Palette home:** a themable token group plus a neutral paint primitive. Both apps switch to it, and Chord stops overloading `categorical`.
- **Colour scope:** the new grid only. Sonata's existing chord surfaces (Progression strip, piano-roll overlay) keep their look.
- **Cell label:** follows Sonata's existing chord-label mode (`useChordDisplayMode`: symbol / roman / both). Roman text is drawn in Chord's serif numeral style.
- **Prototype first.** Phase 0 is a gate: implementation starts only after the user has looked at the mock.

## Phase 0: Prototype (gate)

`./equin prototype new "Sonata chord grid"`: one prototype, `prototype-viewport` `window`, with `mocks` = `route:/sonata` once the display exists. The mock is a static song with the hard-coded chord colours above (they are the requirement, not borrowed design), a simulated playhead running on a timer, and a play/pause control as part of the design.

It shows:

- **Rows of bars**, 4 bars per row (2 on narrow screens).
- **Section headers** (Verse / Chorus) above their rows.
- **Cells:**
  - A bar with several chords splits by beat share, using the Progression strip's rhythm model: `(E E6)` gives halves, `(C . . D)` gives ¾ / ¼.
  - A chord held across a barline shows as a dimmed continuation, a tie.
  - Empty bars appear as a `%`-style rest.
- **Playback:** the active bar is outlined, the active chord gets its full colour, and a thin beat-progress line runs through the active bar. The active row is scrolled to centre.
- **Light and dark** grounds, because Chord is dark-only and Sonata is not.

Options, declared through `prototype-option`:

- `fill: solid | tint | rail`. `solid` is Chord's deep tile with washed ink. `tint` is a light wash with coloured text. `rail` is a neutral cell with a coloured left rail.
- `label: symbol | roman | both`.
- `density: roomy | compact`.

Iterate with the user until one variant is picked. That choice fixes the paint CSS in phase 1 and the light-mode token values.

## Phase 1: Neutral chord paint

### 1a. Token group `ui/tokens/plugins/chord-palette`

This mirrors `ui/tokens/plugins/file-type-palette`, the precedent for a domain palette as a token group:

- **`core/group.ts`:** `chordPaletteGroup` with keys `chord-1` … `chord-7` and `chord-outside`.
  - Dark values are the table above.
  - Light values come from the prototype: probably the same hues, maybe deepened.
- **`web/index.ts`:** `ThemeEngine.TokenGroup` + `ThemeCustomizer.Section` "Chord colours" (a copy of `file-type-palette-section.tsx`).

### 1b. Paint primitive `plugins/music/plugins/chord-paint`

This needs a new `music` umbrella; `primitives/` takes no new top-level entries. The plugin imports no app, and it knows pitch classes, not chord models.

- **`core`:**
  - `majorDegree(rootPc, tonicPc): 0..6 | null`: the arithmetic from `chord/vocabulary/core/degree.ts`, which is the `MAJOR_SCALE` lookup.
  - `CHORD_FUNCTION_OF_DEGREE`, if Chord's `chordFunction` moves too. Chord keeps a thin wrapper over its token.
- **`web`:**
  - `chordToneStyle(degree: number | null): CSSProperties` sets `--fn: var(--chord-N | --chord-outside)` and `--fn-depth` (the `TILE_DEPTH` table).
  - `chord-paint.css`: `.chord-tone` and `.chord-num` / `.chord-num-mark`, moved verbatim, with the fallbacks changed from `--categorical-10` to `--chord-outside`.
  - `<ChordNumeral numeral mark className?/>`: the presentational part of Chord's component. It takes strings, not a `ChordToken`.

### 1c. Migrate Chord onto it (no visual change)

- **`vocabulary/core/degree.ts`:** `chordDegree(token)` becomes `majorDegree(parseChordToken(token).root, 0)`.
- **`vocabulary/web/chord-tone.ts`:** `chordToneStyle(token)` becomes `paint.chordToneStyle(chordDegree(token))`. Keep the token-taking wrapper so the call sites stay the same. Delete `chord-paint.css`.
- **`vocabulary/web/components/chord-numeral.tsx`:** wraps the shared `<ChordNumeral>` with `chordLabel(token)`.
- **`trainer.css`, `piano.css`, `chord-logo.tsx`:** move `--categorical-N` / `fill-categorical-N` to `--chord-N` / `--chord-outside`.
- **`shell/web/internal/theme.ts`:** the `categorical` fragment becomes a `chordPaletteGroup` fragment with the same values. Leave `categorical` to Chord's chart/default use, and update the shell's description.

## Phase 2: Shared bar slicing

`buildBars` in `rich/chord-progression/web/components/chord-progression.tsx` is the grid's layout model. Move it, without changing it, into `sonata/plugins/score/core` as `chordBars(score): ChordBar[]` with types `ChordBar` and `ChordBarSeg`. It is pure, and its inputs are `bars()`, `scoreEndBeat()` and chord annotations. Add a `chord-bars.test.ts` that covers the group, in-bar hold, cross-bar hold and head/tail trim cases. The Progression strip then imports it, and its behaviour stays the same.

## Phase 3: The display `sonata/plugins/chord-chart`

The plugin is named `chord-chart` to avoid clashing with the `sources/chord-grid` authoring source. Its label is "Chord grid".

- **`web/index.ts`:** `SonataPlayer.Display({ match: "chord-chart", id: "chord-chart", label: "Chord grid", icon: symbol("grid-view"), capabilities: [], component })`. It is a reading view, like the songsheet.
- **`web/components/chord-chart.tsx`:** follows `songsheet.tsx` as its template.
  - **States:** `useSongDocument()` failed → `ResourceErrorInline`; pending → `<Loading/>`; no chord annotations → a placeholder ("No chords in this song").
  - **Layout:** rows from `chordBars(score)` (`BARS_PER_ROW` 4, 2 below a container breakpoint), grouped under `SectionAnnotation` names as in the songsheet's `groupLines`. Inside each bar, chords are segments with a flex weight equal to their beat share.
  - **Colour:** each segment gets `className="chord-tone"` and `style={chordToneStyle(majorDegree(chord.data.root, tonicPc))}`.
    - `tonicPc` comes from `effectiveKeyAt(score, chord.start)`, through the score's tonic-to-pc helper (`tonicFifths`, `score/core/spelling.ts`).
    - A null key gives `null`, which paints grey.
    - In a minor key the tonic is the minor tonic, so Am in A minor is I (orange). This matches Chord's tonic-relative tokens.
    - Fill style comes from the prototype's pick.
  - **Label:** `formatChordLabel(data, key, useChordDisplayMode())`. In `roman` / `both`, the numeral part is drawn with the shared `<ChordNumeral>`. If `formatChordLabel` gives no split, add `romanNumeralParts` to `theory/core` alongside `romanNumeral`.
  - **Playback:**
    - `useCursorSelector` for the active bar index and the active chord. Both reconcile only on boundaries, with chord matching by reference as in the Progression strip.
    - The beat-progress line in the active bar goes through `useCursorApi().subscribe`, writing a CSS variable on one element so it never re-renders React per frame.
  - **Scroll:** `revealElement` the active row while `isPlaying`, as in the songsheet.
  - **Interaction:** clicking a segment calls `seekTo(chord.start)`.
  - **HUD:** render `Sonata.Hud` pinned top-right, as in the songsheet.
- **`web/components/chord-chart.css`:** cell/segment chrome only. Colours come from `chord-paint` and tokens; layout uses the css primitives (see the `css` skill), with no hex.
- **`CLAUDE.md`:** what it shows and where its colours and slicing come from.

The deps are `player/web`, `session/web`, `document/web`, `shell/web` (Hud), `score/core`, `theory/core`, `rich/chord-label/web` and `music/chord-paint`. None of them is `apps/chord`.

## Critical files

- **New:**
  - `plugins/ui/plugins/tokens/plugins/chord-palette/{core/group.ts,core/index.ts,web/index.ts,web/components/chord-palette-section.tsx}`
  - `plugins/music/plugins/chord-paint/{core,web}`
  - `plugins/apps/plugins/sonata/plugins/score/core/chord-bars.ts`
  - `plugins/apps/plugins/sonata/plugins/chord-chart/web/*`
- **Changed:**
  - `apps/chord/plugins/vocabulary/{core/degree.ts,web/chord-tone.ts,web/components/chord-numeral.tsx}`
  - `apps/chord/plugins/trainer/web/components/trainer.css`
  - `apps/chord/plugins/piano/web/piano.css`
  - `apps/chord/plugins/shell/web/{internal/theme.ts,components/chord-logo.tsx}`
  - `apps/sonata/plugins/rich/plugins/chord-progression/web/components/chord-progression.tsx`

## Verification

1. **Prototype:** the user reviews the variants in the gallery and picks one. Render each with `screenshot.ts --path "/api/prototypes/<id>/index.html?fill=…"`.
2. **Tests:**
   - `./equin test plugins/apps/plugins/sonata/plugins/score` covers chord-bars.
   - `./equin test plugins/music/plugins/chord-paint` covers `majorDegree`.
   - Chord's existing `degree.test.ts` must stay green.
3. **Build:** `./equin build`, background. Checks include boundary-rules, plugin-boundaries and docs-in-sync.
4. **Chord app unchanged:** before and after `screenshot.ts --path /chord`, with a pixel compare of the trainer's answer strip, buttons and logo.
5. **Sonata:**
   - Open a chord-grid song and a UG song.
   - Switch the display picker to "Chord grid".
   - `screenshot.ts --path /sonata/song/<id> --click "Play"` in light and dark.
   - Confirm the colours match Chord, the active bar follows, and clicking a cell seeks.
   - Run `compare-diff.ts --name <proto-id>` against the prototype.
6. **Progression strip:** before and after screenshots match, since the phase 2 slicing refactor must not change it.
