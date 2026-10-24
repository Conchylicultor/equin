# Chord trainer — chip readings (V/V, I/3, Neapolitan…) and the gold accent

## Context

The Chords section (`plugins/apps/plugins/chord/plugins/curriculum/web/components/chords-section.tsx`,
shipped from `research/2026-10-06-apps-chord-trainer-free-selection.md`) does not match its mockup
`proto-1791276393-29e2` (option `data = index`) in two ways:

1. **No reading under a chip's numeral.** The mockup puts a small caption under the numeral that says
   what the chord is or does: `V/V`, `V7/IV`, `I/3`, `blues IV`, `backdoor`, `Neapolitan`,
   `tritone sub`, `Picardy`, `phrygian`… Some depend on the section the chip is in (I is `Picardy` in
   Minor › Borrowed from major; ♭II is `phrygian` in the Phrygian modes and `Neapolitan` in Minor).
   Without them a learner can't tell what a secondary dominant, an inversion or a borrowed chord is.
   The chips are 32 px tall, which leaves no room for a caption. The mockup's are 44 × ≥48 px. The
   hover footer should show the same reading (mockup: `Practising · V/V · also in …`).
2. **No accent colour.** The mockup uses gold `#e8c26a` for the started-track badge, the track
   coverage bar, the "✓ from the next loop" note and "Undo clear". `chordTheme` has no token for it.
   The colour-palette group's `accent` is shadcn's hover surface, so it can't be reused.
   **Decision (user):** make the theme's own `accent` gold. Shared components that hover or select
   with `accent` (Row, menus, ghost toggle chips…) turn gold inside the Chord app too, which keeps
   one accent across the whole app. No such component is used in the app today.

## Design

### 1. Readings: structural ones in vocabulary, contextual ones in the catalog rules

A reading has two sources, and each lives with the code that already owns that knowledge:

- **Structural readings are computed from the token**, so there's no lookup table for them. They go in
  vocabulary core (new `vocabulary/core/reading.ts`, exported from the barrel; the README block in
  `vocabulary/CLAUDE.md` gets two lines):
  - `inversionReading(token): string | null` gives the root-position chord, a slash, and the bass as
    a scale degree. It reuses `chordLabel` on the root-position twin
    (`chordTokenFromParts({...parts, inversion: 0})`) and `SCALE_DEGREE_NAMES` from `label.ts`. So
    I⁶ → `I/3`, V⁴₂ → `V7/4`, i⁶ → `i/♭3`, ♭VII⁶ → `♭VII/2`, iv⁶ → `iv/♭6`. It returns null in root
    position and for "other" stacks, whose label already reads `/5`.
  - `appliedReading(token, scale): string | null` reads a dominant-shaped chord (major triad → `V`,
    dom7 → `V7`, dim7 → `vii°7`) that is not diatonic to `scale` by its target. The target is root + 5
    for a dominant and root + 1 for the dim7. The reading is only given when the target is a
    non-tonic degree of the scale whose diatonic triad is not diminished, and the target is named by
    `chordLabel` of that triad. In major that gives II → `V/V`, III → `V/vi`, VI → `V/ii`,
    VII → `V/iii`, I7 → `V7/IV`, II7 → `V7/V`, ♯iv°7 → `vii°7/V`. IV7, ♭VII7 and ♭II7 return null,
    because their targets are outside the scale.
- **Contextual names** (`Neapolitan`, `backdoor`, `Picardy`, `phrygian`…) depend on the track and
  section, which `curriculum/core/catalog-rules.ts` already encodes, so they go there:
  - `TrackRule.reads: (token, parts) => string | null` (required, so every track states its reading),
    and an optional `SectionRule.reads` that wins over it.
  - A small helper, `named({ "♭II": "Neapolitan", … })`, matches on `chordLabel(token).text`. The keys
    are the readable label spellings. A unit test checks that every key is the label of a real token,
    so a typo fails.
  - The tables:
    - **Major** and **Sevenths & jazz**: `inversionReading` ?? `appliedReading(MAJOR)` ??
      `named({ "♭II": "Neapolitan", "♭II7": "tritone sub", "♭VII7": "backdoor", "IV7": "blues IV" })`. The mockup's V11 → `IV/V` is left out: no label in the vocabulary is `V11`, so it would be a guess at which stack the mockup meant.
    - **Minor**: `inversionReading` ?? `appliedReading(MINOR)`. The section overrides are
      Borrowed from major `{ IV: "dorian IV", I: "Picardy" }` and Colour & chromatic
      `{ "♭II": "Neapolitan" }`. ♭VII7 has no caption here, because it is diatonic in minor (the
      mockup's default "backdoor" would be wrong).
    - **Modal**: `inversionReading` only. The overrides are Mixolydian `{ I7: "tonic 7" }`,
      Lydian `{ II: "lydian II" }`, and Phrygian / Locrian / Phrygian dominant `{ "♭II": "phrygian" }`.
- The catalog stores the result. `CatalogChordSchema` gains `reading: z.string().nullable()`, and
  `buildTrack` fills it per listed chord with `section.reads ?? track.reads`. Rare-group tokens get
  none. Computing it once on the server keeps every consumer reading `chord.reading`, so none of them
  has to re-derive the context.

### 2. The chip and the footer

- `ChordChip` takes `reading` and renders `<ChordNumeral/>` with
  `{reading && <span className="chord-caption">{reading}</span>}` under it. The `aria-label` becomes
  `"II, V/V, Hear"`. The `Hover` chord arm carries `reading`. In `HoverDetail`, line 1 becomes
  `<b>Practising</b> · V/V · also in Minor`, as in the mockup.
- **Caption colour comes from the paint, not from the surface.** Add a `.chord-caption` rule to
  `vocabulary/web/chord-paint.css` with the sans font, `line-height: 1`, `white-space: nowrap`, and
  `color: color-mix(in srgb, var(--chord-ink, var(--muted-foreground)) 75%, transparent)`. That makes
  tile, tint and ghost each dim their own ink, matching the mockup's three alias colours. The paint
  docs and the vocabulary barrel description get one line about it. `chords.css` sets only its size
  (9 px) and margin.
- Chip geometry in `curriculum/web/components/chords.css`, as in the mockup:
  - `.chord-pick`: 44 px tall, at least 48 px wide, `padding: 0 9px`, `border-radius: 10px`, a
    column flex centred; the numeral is 18 px.
  - `.chord-rare`: 44 px tall, `padding: 0 12px`, radius 10, 12 px text.
  - The mastery mark offsets follow the mockup: ✓ top 2 / right 4, the bar bottom 4 / inset 8.

### 3. The gold `accent`

- In `shell/web/internal/theme.ts`, `chordTheme` sets `accent: "#E8C26A"`. It also sets
  `accentForeground: GROUND`: text on a gold fill must be dark, since the light ink on gold fails
  contrast. Leave `selected` at its default (`var(--accent)`), so selection is gold as well. Update
  the `colorPalette` doc comment, which currently says the chord colours are the only colour on the
  page.
- In `chords.css`, `.chord-track-badge[data-started]` (border and text), `.chord-track-cov-fill`
  (background, opacity .75), `.chord-applied` and `.chord-clear[data-undo]` read `var(--accent)`.
  Rewrite the file's header comment, which currently says the gold "is the theme's ink".
- No change to the colour-palette token group.

## Files

- `plugins/apps/plugins/chord/plugins/vocabulary/core/reading.ts` (new), plus `reading.test.ts`, `core/index.ts` and `CLAUDE.md`
- `plugins/apps/plugins/chord/plugins/vocabulary/web/chord-paint.css` and `web/index.ts` (description)
- `plugins/apps/plugins/chord/plugins/curriculum/core/catalog-rules.ts`, `catalog.ts`, and `catalog.test.ts` (readings per section, `named` keys valid)
- `plugins/apps/plugins/chord/plugins/curriculum/web/components/chords-section.tsx` and `chords.css`
- `plugins/apps/plugins/chord/plugins/shell/web/internal/theme.ts`

## Verification

1. `./equin test plugins/apps/plugins/chord/plugins/vocabulary plugins/apps/plugins/chord/plugins/curriculum`
   checks the readings table (I6 → I/3, II → V/V, ♯iv°7 → vii°7/V, IV7 → null in major, V → null in
   minor), that minor's I reads Picardy and modal phrygian's ♭II reads phrygian in the built
   catalog, and that every `named` key is a real label.
2. `./equin build` in the background, then `./equin await`.
3. Run `compare-diff.ts --name proto-1791276393-29e2 --options data=index` and compare the chip
   sizes, captions and gold elements side by side.
4. Take a screenshot with the Major track open (Secondary dominants, Inversions), hover a chip, and
   check that the footer reads `… · V/V · …`. Also open Minor › Borrowed from major and check that I
   reads Picardy.
