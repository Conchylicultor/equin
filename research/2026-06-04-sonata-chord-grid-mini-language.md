# Chord-grid mini-language parser

## Context

The Sonata **chord-grid** input source (`plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/`)
currently parses chords with a thin format: text is split on `|` into bars, and
each bar is whitespace-split into chords that divide it equally. There is no way
to put more than one chord in a bar, or to hold a chord, the way a lead sheet
reads.

We want a richer **mini-language**. Per the decisions taken with the user:

- **Each cell = one bar.** A line is just a horizontal run of bars (Real-Book
  style); newlines are cosmetic. `Amaj9 Am9 (E E6) (E E6)` = 4 bars.
- **The new grammar replaces the old `|` format.** `|` is no longer required
  (still accepted and ignored, so pasted old grids don't hard-fail).
- **`.` holds the previous chord** — extends its duration, no re-strike.
- **The only syntax is chords, groups `( … )`, and dots `.`.** The colon
  phrases in the original request (`Amaj9: 4 times`, `(C D): 2 times each`,
  `(C . . D): 3 times, then one time`) were **documentation glosses describing
  the resulting rhythm, NOT syntax.** There is no `:`/repeat operator. The user
  just writes `(C . . D)`; "3 times, then one time" is the English reading of it
  (C for 3 sub-beats, D for 1). Repetition is expressed by simply typing a chord
  in several cells (`Amaj9 Amaj9 Amaj9 Amaj9`).

Target example (must parse cleanly, no "unrecognised"):

```
Amaj9 Am9 (E E6) (E E6)
Cmaj7 Am7 Dm9 G13
Fmaj7 Fm7 Em7 A7
Dm7 G7 Cmaj7
```

## Grammar

```
grid   := cell*                      ; cells separated by whitespace / newlines
cell   := chord | group | hold
chord  := <chord-symbol>             ; parsed by theory parseChordSymbol()
group  := '(' item (ws item)* ')'
item   := chord | hold
hold   := '.'
```

`|` appearing between cells is consumed and ignored (back-compat / visual aid).

### Semantics

Bar length is the existing `BEATS_PER_BAR = 4` (quarter-note beats).

- **chord cell** → one event spanning the whole bar (`start … start+4`).
- **hold cell `.`** (top level) → extend the *previous emitted event's* `end` by
  one bar (a chord sustained across bars, no re-strike). A leading `.` with no
  previous chord = a silent bar (cursor advances, no event).
- **group cell `( … )`** → one bar subdivided equally among its `M` items
  (`sub = 4 / M`). Walking items left→right at the running sub-position:
  - chord item → new event of length `sub`.
  - `.` item → extend the previous item's event by `sub` (leading `.` = silent
    sub-slot).

  So `(E E6)` → E for 2 beats + E6 for 2 beats; `(C . . D)` → C for 3 beats +
  D for 1 beat ("3 times, then one time"); `Cmaj7 . .` → one Cmaj7 sustained
  across 3 bars.

### Error handling (fail loud)

`parseGrid` keeps its current return shape `{ events, skipped }`. `skipped`
collects human-readable issues — unknown chord tokens, an unterminated `(`,
a stray `)`. The loader already renders `skipped` as a red "Unrecognised: …"
line, so issues stay visible and nothing is silently dropped (project fail-loud
rule).

## Implementation

All changes are inside the chord-grid plugin. `parseGrid` is consumed only by
`compile.ts` and `loader.tsx` (both local), and its output shape is unchanged,
so `compile()`, the voicings, and `index.ts`'s wiring need no logic changes.

### 1. New file: `web/parse-grid.ts`

The parser now owns its own module (keeps `compile.ts` focused on Score
assembly). Pure (no React/DOM). Exports:

```ts
export function parseGrid(text: string): { events: ChordEvent[]; skipped: string[] }
```

Internals:

- **Tokenizer** — a char scan (not `split(/\s+/)`, because a group contains
  spaces). Skips whitespace and `|`. Emits cells:
  - `(` → read to the matching `)` and split its body on whitespace into items
    (unterminated `(` → push an issue, stop).
  - `.` → a hold cell.
  - otherwise → a bare run until whitespace / `(` / `)` / `|` → a chord cell.
  - Chord symbols never contain `(` `)` `.` `|` (verified against theory
    `parse.ts`: roots `A–G`, accidentals `# b ♯ ♭`, quality suffixes only), so
    the delimiters never collide with chord characters.
- **Expander** — turn cells into `ChordEvent[]` with a running `beat` cursor,
  applying the semantics above. `lastEvent` tracks the event a `.` extends.
  Reuses `parseChordSymbol`
  (`@plugins/apps/plugins/sonata/plugins/theory/core`) for every chord token and
  the `ChordEvent` type from `./voicings`.

### 2. `web/compile.ts`

Delete the inline `parseGrid` (lines ~49–84) and
`import { parseGrid } from "./parse-grid"`. `ChordGridRaw` / `isChordGridRaw` /
`compile` stay as-is. Update the file-top doc comment to describe the new grammar
(groups + holds, `|` optional) instead of the old `|`-bars rule.

### 3. `web/loader.tsx`

- Import `parseGrid` from `./parse-grid` (keep `ChordGridRaw` from `./compile`).
- Update `PLACEHOLDER`, e.g. `Amaj9 Am9 (E E6) (E E6)\nCmaj7 Am7 Dm9 G13`.
- Replace the "bars split on `|`" help line with a short legend:
  `( ) share a bar · . holds the previous chord`.
- The `{events.length} chords` + red `Unrecognised:` feedback already works
  unchanged.

### 4. Docs / description

Update the `description` string in `index.ts` to mention the mini-language
(groups + holds); `./equin build` regenerates the plugin `CLAUDE.md`
autogen block and the compact/details docs from it.

### 5. Theory vocabulary (discovered during implementation)

The target grid uses extended chords (`Amaj9`, `Am9`, `E6`, `Dm9`, `G13`) that
the shared chord vocabulary in `theory/core` did not know, so they parsed as
"Unrecognised". For the feature to work on the user's own example, append the
needed qualities to `CHORD_TEMPLATES` (`theory/core/chords.ts`) and their suffix
aliases to `SUFFIX_TO_QUALITY` (`theory/core/parse.ts`):
`maj6` (`6`), `min6` (`m6`), `maj9`, `dom9` (`9`), `min9` (`m9`), `dom13` (`13`).

This is detection-safe: `detectChord` (`chord-analyzer`) matches a mod-12
relative-interval set with a strict-subset rule and earliest-wins tie-break.
Upper extensions use literal sizes (9th = `14`, 13th = `21`) so voicing spacing
is right *and* they can never appear in the mod-12 set → inert in detection. The
6th chords are always enharmonic to an earlier-listed min7/halfdim7 inversion
that ties-or-beats them → existing detection is unchanged.

## Files to modify / add

- **add** `…/chord-grid/web/parse-grid.ts`
- **edit** `…/chord-grid/web/compile.ts` (drop inline parser, import new, update doc comment)
- **edit** `…/chord-grid/web/loader.tsx` (placeholder, help legend, import)
- **edit** `…/chord-grid/web/index.ts` (description string)
- **edit** `…/chord-grid/CLAUDE.md` (hand-written syntax section)
- **edit** `…/theory/core/chords.ts` + `…/theory/core/parse.ts` (extended chords)

Reused, unchanged: `parseChordSymbol` (`theory/core`), `ChordEvent` / voicings /
`BEATS_PER_BAR`, `compile()` Score assembly, the `{ events, skipped }` contract.

## Verification

No test runner exists in the repo, so verify in the live app:

1. `./equin build` from the worktree.
2. Open `http://att-1780584938-vcjn.localhost:9000` → Sonata → add a **Chord
   Grid** source.
3. Paste the target 4-line grid; confirm the loader shows the right chord count
   and **no** "Unrecognised" line, and the piano roll renders 13 bars with
   `(E E6)` split into two half-bars.
4. Spot-check the mechanics via the live count + roll:
   - `(C . . D)` → one bar, C for 3 beats + D for 1 (unequal note widths).
   - `Cmaj7 . .` → one Cmaj7 sustained across 3 bars (single wide block).
   - `(E E6)` → two equal half-bar chords.
   - A typo (`Xyz`) and an unterminated `(C D` → surfaced in red, not dropped.
5. Scripted check with `e2e/screenshot.mjs` (type into the textarea, capture
   before/after) for the split-bar and held-chord cases.
```
