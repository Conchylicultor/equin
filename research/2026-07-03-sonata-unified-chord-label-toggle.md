# Sonata — unified chord-label display toggle (symbol / numeral / both)

## Context

Sonata now computes Roman-numeral functional notation (`romanNumeral` in `theory/core`)
and shows it in two places. In the **chord-progression** strip it renders the numeral on a
second row *below* each chord chip; in the **current-chord readout** it trails the big symbol.

The user wants a **single, user-controlled toggle** that governs how chords are labeled, with
three modes, applied uniformly to the chord displays:

- `C` — chord symbol only
- `I` — Roman numeral only
- `C (I)` — symbol with the numeral in parentheses

The toggle must drive **both** chord surfaces the user named, rendering them identically (a
"united" chord label):

1. **Piano-roll chord overlay** (`rich/plugins/chord-overlay`) — the left-edge timeline labels.
2. **Chord-progression strip** (`rich/plugins/chord-progression`) — the per-bar chips.

This **replaces** the current progression implementation (the Roman numeral printed on a
second row below each chip): the progression chip's own text becomes the mode-driven label.

**Decisions (confirmed with user):**
- **Scope:** only the piano-roll overlay + progression strip. The big "Current Chord" readout
  (`rich/plugins/chord-readout`) is **left unchanged** (keeps showing `Am7 ii7`).
- **Default mode:** `symbol` (`C`) — preserves today's default look; numerals are opt-in.

## Design

Three pieces: a **pure united formatter** (theory), a **shared config + toggle** (new plugin),
and **two consumer edits**.

### 1. Pure formatter — `theory/core`

The single home for "given a chord + key + mode, produce its label string". Sits beside the
existing `formatChordSymbol` / `romanNumeral`.

New file `plugins/apps/plugins/sonata/plugins/theory/core/chord-label.ts`:

```ts
import type { ChordData, KeySignature } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { romanNumeral } from "./roman";

/** How a chord annotation is labeled across Sonata's chord displays. */
export type ChordDisplayMode = "symbol" | "roman" | "both";

/**
 * The label for `chord` under `mode`, using `key` (the key in force at the chord's
 * onset) to derive the Roman numeral. `key` is null for a keyless/atonal score.
 * The numeral is unavailable when there's no key or the quality is out of vocab —
 * in that case both `roman` and `both` gracefully fall back to the symbol, so a
 * label never vanishes.
 */
export function formatChordLabel(
  chord: ChordData,
  key: KeySignature | null,
  mode: ChordDisplayMode,
): string {
  const symbol = chord.symbol;
  if (mode === "symbol") return symbol;
  const roman = key ? romanNumeral(chord, key) : null;
  if (!roman) return symbol;
  if (mode === "roman") return roman;
  return `${symbol} (${roman})`;
}
```

- Export `formatChordLabel` + `ChordDisplayMode` from `theory/core/index.ts`.
- Add `chord-label.test.ts` (bun:test) covering all three modes, the no-key fallback, and the
  unknown-quality fallback.

### 2. Shared config + toggle — new plugin `rich/plugins/chord-label`

A dedicated sub-plugin owns the single shared preference and surfaces it in the View popover.
Mirrors `notation`'s config wiring exactly (`shared/config.ts` + web `WebRegister` + server
`Register` + a `Sonata.ViewOption`).

Files:

- `shared/config.ts`:
  ```ts
  import { defineConfig } from "@plugins/config_v2/core";
  import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";

  export const chordLabelConfig = defineConfig({
    fields: {
      mode: enumField({
        label: "Chord labels",
        description: "How chords are labeled on the piano roll and progression.",
        options: [
          { value: "symbol", label: "Chord — C" },
          { value: "roman", label: "Numeral — I" },
          { value: "both", label: "Both — C (I)" },
        ],
        default: "symbol",
        display: "radio",
      }),
    },
  });
  ```
- `web/hook.ts` — `useChordDisplayMode()`:
  ```ts
  import { useConfig } from "@plugins/config_v2/web";
  import type { ChordDisplayMode } from "@plugins/apps/plugins/sonata/plugins/theory/core";
  import { chordLabelConfig } from "../shared/config";
  export function useChordDisplayMode(): ChordDisplayMode {
    return useConfig(chordLabelConfig).mode as ChordDisplayMode;
  }
  ```
- `web/index.ts` (barrel — re-export own internal + single default export):
  ```ts
  export { useChordDisplayMode } from "./hook";
  export default {
    description: "Sonata chord-label preference: the shared symbol/numeral/both display mode…",
    contributions: [
      ConfigV2.WebRegister({ descriptor: chordLabelConfig }),
      Sonata.ViewOption({
        id: "chord-label",
        displays: "global",       // chords render across lenses/sections → global
        config: chordLabelConfig,
        fields: ["mode"],
      }),
    ],
  } satisfies PluginDefinition;
  ```
- `server/index.ts` — `ConfigV2.Register({ descriptor: chordLabelConfig })` (config_v2 reads
  back `undefined` unless registered on **both** runtimes — see `notation/server/index.ts`).
- `package.json` + `CLAUDE.md` (autogen block filled by `./equin build`).

`displays: "global"` because the progression/readout Sections are display-agnostic and the
overlay is on the piano roll — the preference is global to "how chords are labeled".

### 3. Consumer edits

**`rich/plugins/chord-overlay/web/components/chord-overlay.tsx`** (currently renders
`data.symbol` only):
- Add `const { score } = useSonata();` and `const mode = useChordDisplayMode();`.
- Memoize a label per annotation: `useMemo(() => new Map(annotations.map(a => [a, formatChordLabel(a.data as ChordData, effectiveKeyAt(score, a.start) ?? null, mode)])), [annotations, score, mode])`.
- Render `labels.get(a)` instead of `data.symbol`. Keep the existing `title` tooltip (symbol +
  spelled + confidence).

**`rich/plugins/chord-progression/web/components/chord-progression.tsx`**:
- Add `const mode = useChordDisplayMode();`.
- Replace the current `romanByChord` map with a `labelByChord` map:
  `useMemo(map c → formatChordLabel(c.data, effectiveKeyAt(score, c.start) ?? null, mode), [score, chords, mode])`.
- **Remove the two-row rendering**: delete the `RomanCell` component and the second grid row in
  `BarBody`; restore `BarBody` to the single chip-row grid.
- `ChordChip` renders `labelByChord.get(chord)` as its text (instead of `chord.data.symbol`);
  keep the `title` tooltip on the raw symbol + beats.

**`chord-readout`** — no change (per user scope).

### Boundary / barrel notes

- Consumers import `formatChordLabel` (+ type) from `@plugins/apps/plugins/sonata/plugins/theory/core`
  and `useChordDisplayMode` from `@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web`.
  No cross-plugin re-exports; `chord-label` does not proxy theory's symbols.
- `chord-overlay` already imports `score/core`; it gains `effectiveKeyAt` + `useSonata` (shell) +
  the two new barrels. `chord-progression` already imports all of these post-current-work.

## Critical files

| File | Change |
|---|---|
| `…/theory/core/chord-label.ts` | **new** — `formatChordLabel` + `ChordDisplayMode` |
| `…/theory/core/chord-label.test.ts` | **new** — unit tests |
| `…/theory/core/index.ts` | export the two new symbols |
| `…/rich/plugins/chord-label/shared/config.ts` | **new** — `chordLabelConfig` enum |
| `…/rich/plugins/chord-label/web/hook.ts` | **new** — `useChordDisplayMode()` |
| `…/rich/plugins/chord-label/web/index.ts` | **new** — barrel: config + ViewOption + hook re-export |
| `…/rich/plugins/chord-label/server/index.ts` | **new** — `ConfigV2.Register` |
| `…/rich/plugins/chord-label/package.json` + `CLAUDE.md` | **new** |
| `…/rich/plugins/chord-overlay/web/components/chord-overlay.tsx` | use mode+key+formatter |
| `…/rich/plugins/chord-progression/web/components/chord-progression.tsx` | drop two-row roman; use formatter |

Reused: `romanNumeral`, `effectiveKeyAt`, `formatChordSymbol` (existing), `useSonata`,
`useConfig`, `enumField`, `defineConfig`, `ConfigV2.{WebRegister,Register}`, `Sonata.ViewOption`,
`FieldRenderer` (generic — renders the new radio automatically, zero edits to `view-options`).

## Verification

1. `bun test plugins/apps/plugins/sonata/plugins/theory/core/chord-label.test.ts` — formatter unit tests pass.
2. `./equin build` — type-check, boundary, doc-in-sync, migrations checks pass; regenerates
   the plugin registry + `chord-label` CLAUDE.md.
3. Open a chord-grid song (e.g. "Modal interchange", id `7c0c9447-…`) at
   `http://att-1783036518-e0fc.localhost:9000/sonata/song/<id>` on the Piano Roll lens.
4. Open the **View** popover (⚙ chip) → the new "Chord labels" radio (Chord / Numeral / Both).
5. Toggle each mode and screenshot (`bun e2e/screenshot.mjs`), asserting **both** the left-edge
   overlay labels and the progression chips update in lockstep:
   - `symbol` → `Am7`, `G7`, `C` …
   - `roman` → `ii7`, `I7`, `I` …
   - `both` → `Am7 (ii7)`, `G7 (I7)`, `C (I)` …
6. Confirm the progression no longer shows the numeral on a second row, and that labels track the
   mid-song key changes (numerals differ across the G-maj → C-maj regions).
7. Confirm the choice persists across reload (config_v2) and the current-chord readout is unchanged.
```
