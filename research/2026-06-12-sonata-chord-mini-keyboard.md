# Sonata chord readout — mini piano keyboard + inversions

## Context

The Sonata "Current chord" readout (`chord-readout` plugin) currently shows only
the chord *symbol*, quality, confidence, and beat range as text. Users can't see
which notes the chord is made of. We want:

1. A **mini piano keyboard** under the readout, lighting up the current chord's notes.
2. A **toggle** ("Inversions") that, when on, stacks one mini-keyboard per inversion
   below the root-position one (Root, 1st, 2nd, 3rd…), each labeled with its
   slash-chord symbol.

There is exactly one existing piano component — `PianoKeyboard`
(`plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`)
— but it is **not reusable here**: it requires a `projection` (the piano-roll
display geometry), reads `useSonata()` (score + playback cursor), and depends on
track-mixer hooks. It renders the full 88-key keyboard absolutely-positioned in
the roll gutter.

So we build a **new stateless, reusable mini-keyboard primitive** (takes lit MIDI
pitches + an octave range, no Sonata context) and have `chord-readout` consume it.
A follow-up task (`task-1781255972357-v21c5e`) will later refactor the full
`PianoKeyboard` to build on this same primitive so key layout has one source of truth.

## Design

Three clean layers, each with a single responsibility:

- **mini-keyboard primitive** — dumb key renderer. Knows nothing about chords.
- **theory/core** — pure chord→pitches + inversion math. Knows nothing about React.
- **chord-readout** — glue: compute voicings + shared range, render rows + toggle.

### 1. New primitive: `mini-keyboard`

Path: `plugins/apps/plugins/sonata/plugins/primitives/plugins/mini-keyboard/`

Skeleton mirrors the sibling `inertial-drag` primitive (pure-export, `contributions: []`,
no server, no registry entry needed — the generated registry only lists
slot-contributing plugins; `inertial-drag` is absent and imported directly):

```
mini-keyboard/
  package.json          # { "name": "@singularity/plugin-apps-sonata-primitives-mini-keyboard", "private": true, "version": "0.0.1" }
  web/
    index.ts            # default PluginDefinition { description, contributions: [] }; re-exports component + layout helpers
    internal/
      mini-keyboard.tsx # <MiniKeyboard/> component
      key-layout.ts     # pure, range-parameterized key geometry
```

**`key-layout.ts`** — the canonical, range-parameterized key layout the unification
task will later point the full keyboard at. Fractional (0..1) centers/widths so any
consumer scales to its own pixel width. Mirrors the existing logic in
`piano-roll/web/components/geometry.ts` (`isBlackPitch`, white-key indexing,
black key at 62% width centered on the white-key boundary) but parameterized by
`[low, high]` instead of hardcoded 88 keys:

```ts
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
export function isBlackPitch(pitch: number): boolean {
  return !WHITE_PCS.has(((pitch % 12) + 12) % 12);
}
export interface KeyLane { pitch: number; isBlack: boolean; center: number; width: number } // fractions of total width
export function keyLayout(low: number, high: number): KeyLane[];
```

**`mini-keyboard.tsx`** — stateless:

```ts
export function MiniKeyboard({
  low, high,                      // MIDI range to render
  lit,                            // ReadonlyArray<number> — MIDI pitches to highlight
  className?,
}: MiniKeyboardProps)
```

Renders white keys (back layer, full height) then black keys (front, ~62% height),
positioned via `keyLayout(low, high)` with CSS `left`/`width` percentages.
Lit pitches use the theme accent (`bg-primary`); resting keys reuse the same fixed
ivory/near-black inline colors as the full keyboard
(`WHITE_KEY`/`BLACK_KEY` constants in `piano-keyboard.tsx`) so a piano always looks
like a piano in both themes. No labels (mini scale); height set by the consumer via
a wrapper with a fixed `h-*`. Inline `backgroundColor` styles keep it clear of the
`no-hardcoded-colors` className check, matching the existing keyboard.

### 2. theory/core — voicing math

Add to `plugins/apps/plugins/sonata/plugins/theory/core/` (new `voicing.ts`,
re-exported from `core/index.ts`). This is the theory home; `chord-grid/web/voicings.ts`
already has a private `chordTones` that this can later replace.

```ts
/** Root-position MIDI pitches for a chord, root at the given octave (C4=60 ⇒ octave 4). */
export function chordPitches(data: { root: number; quality: string }, octave = 4): number[] {
  const base = 12 * (octave + 1) + (((data.root % 12) + 12) % 12);
  return [base, ...qualityToIntervals(data.quality).map((i) => base + i)];
}

/** k-th inversion: raise the lowest k notes an octave, re-sort ascending. */
export function invertVoicing(pitches: readonly number[], k: number): number[] {
  const p = [...pitches];
  for (let i = 0; i < k; i++) p[i] += 12;
  return p.sort((a, b) => a - b);
}
```

Inversion count = `chordPitches(...).length - 1` (triad → 3 voicings incl. root;
7th → 4). Uses existing `qualityToIntervals` (theory/core/chords.ts:77).

### 3. chord-readout — wire it up

File: `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-readout/web/components/chord-readout.tsx`

- Compute `root = chordPitches(current.data)` once.
- Build the voicing list: `[root, invert(root,1), invert(root,2), …]` — full list when
  the toggle is on, just `[root]` when off.
- Compute a **shared range** across *all* inversions (`min`/`max` over every voicing
  in the full list, snapped down to the nearest C and up to the nearest B) and pass
  the **same `low`/`high` to every row** so the keyboards align vertically and you
  can see notes shifting between inversions.
- Render rows below the existing text readout: a small left label + `<MiniKeyboard/>`.
  - Root row label: `"Root"`.
  - Inversion labels: ordinal (`1st`, `2nd`, `3rd`) + the slash symbol via
    `formatChordSymbol({ root, quality, bass })` where `bass` = pitch-class of that
    voicing's lowest note (theory/core/chords.ts:101). E.g. C major 1st inversion → `C/E`.
- **Toggle**: `<ToggleChip active={showInv} onClick={…}>Inversions</ToggleChip>`
  (`primitives/toggle-chip/web`). Persist the choice with
  `useDraft<boolean>("sonata:chord-readout:inversions", false)`
  (`primitives/persistent-draft/web`) so it survives reloads. Hide the toggle when the
  chord has no inversions to show (shouldn't happen for real chords, but defensive).

New cross-plugin imports in chord-readout (all legal runtime barrels):
`@plugins/apps/plugins/sonata/plugins/theory/core`,
`@plugins/apps/plugins/sonata/plugins/primitives/plugins/mini-keyboard/web`,
`@plugins/primitives/plugins/toggle-chip/web`,
`@plugins/primitives/plugins/persistent-draft/web`.

## Files

**New**
- `…/sonata/plugins/primitives/plugins/mini-keyboard/package.json`
- `…/sonata/plugins/primitives/plugins/mini-keyboard/web/index.ts`
- `…/sonata/plugins/primitives/plugins/mini-keyboard/web/internal/mini-keyboard.tsx`
- `…/sonata/plugins/primitives/plugins/mini-keyboard/web/internal/key-layout.ts`
- `…/sonata/plugins/theory/core/voicing.ts`

**Modified**
- `…/sonata/plugins/theory/core/index.ts` — re-export `chordPitches`, `invertVoicing`
- `…/rich/plugins/chord-readout/web/components/chord-readout.tsx` — render rows + toggle
- `…/rich/plugins/chord-readout/package.json` — (no dep change; barrel imports are workspace-resolved)

**Reuse (do not duplicate)**
- `qualityToIntervals`, `formatChordSymbol`, `PC_NAMES` — `theory/core/chords.ts`
- `WHITE_PCS` / black-key + 62%-width convention — pattern from `piano-roll/web/components/geometry.ts`
- `useDraft` — `persistent-draft/web/use-draft.ts`
- `ToggleChip` — `toggle-chip/web`

## Verification

1. `./equin build` from the worktree (regenerates the registry, builds, restarts).
2. Open `http://att-1781255551-sdgs.localhost:9000`, go to Sonata, open a song with
   detected chords, and confirm the readout shows a mini keyboard with the current
   chord's notes lit; scrub playback and confirm the lit notes track the chord changes.
3. Toggle "Inversions" on → confirm one labeled mini-keyboard per inversion appears
   stacked below, ranges aligned, labels showing slash symbols (e.g. `C/E`, `C/G`),
   and that the toggle state survives a page reload.
4. Scripted check with `bun e2e/screenshot.mjs --url <sonata-song-url> --click "Inversions" --out /tmp/inv`
   to capture before/after and confirm the toggle actually adds the rows.
5. Optional unit test: `bun test …/theory/core/voicing.test.ts` for `chordPitches`
   (root-position MIDI for a few qualities) and `invertVoicing` (rotation correctness).

## Follow-up

`task-1781255972357-v21c5e` — refactor the full `PianoKeyboard` to build on the
mini-keyboard primitive's `keyLayout`/`isBlackPitch` so key geometry has one home.
