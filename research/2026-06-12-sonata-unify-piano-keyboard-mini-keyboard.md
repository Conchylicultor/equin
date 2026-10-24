# Unify the full piano keyboard with the shared mini-keyboard primitive

## Context

Sonata has **two** piano-key renderers that duplicate the same key-geometry and
key-drawing logic:

1. **Full 88-key `PianoKeyboard`** — `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`.
   Projection-driven: draws `projection.keys` (pixel `center`/`width` from the
   piano-roll's `buildProjection`), coupled to `useSonata` + track-mixer for
   per-track lit colors, and renders key-signature-aware labels.
2. **Stateless `MiniKeyboard` primitive** — `plugins/apps/plugins/sonata/plugins/primitives/plugins/mini-keyboard/web/`.
   Range-parameterized, fractional geometry rendered as CSS percentages, lights
   the `lit` pitches in the theme accent. Used by chord-readout.

The duplication is in three layers:

| Layer | piano-roll `geometry.ts` | mini-keyboard `key-layout.ts` | `PianoKeyboard` vs `MiniKeyboard` |
|---|---|---|---|
| `isBlackPitch`, `WHITE_PCS` | dup | dup | — |
| key tiling formula + `BLACK_WIDTH_RATIO=0.62` | pixel-absolute | fractional | — |
| two-pass white-back/black-front render, resting colors, 62% black height, z-order, rounded corners | — | yes | **byte-identical** |

The two layouts are mathematically the same: the full range is `KEYBOARD_LOW=21 … KEYBOARD_HIGH=108`
(52 white keys); the pixel layout is just `fraction × containerWidth`. A
percentage-rendered `MiniKeyboard(21, 108)` lands **pixel-exact** on the
projection's notes as long as it renders in the same lane width (it does — same
gutter). A `task-1781255972357-v21c5e` comment in `key-layout.ts` already flags
this unification.

**Goal:** one source of truth for how a piano key is *laid out* and *drawn*. The
primitive owns geometry + key chrome; the full keyboard supplies its data
(range, per-track lit colors, labels) and delegates drawing to the primitive.

## Approach

The primitive (`MiniKeyboard` + `keyLayout`) becomes the canonical key
renderer + geometry. The full keyboard delegates rendering to it, and the
piano-roll's pixel geometry derives from the primitive's fractional layout.

### 1. Extend the `MiniKeyboard` primitive (own geometry + drawing)

`primitives/plugins/mini-keyboard/web/internal/mini-keyboard.tsx`:

- **Richer `lit` prop** — widen to
  `lit?: ReadonlyArray<number> | ReadonlyMap<number, string>`.
  - Array form → each pitch lit in the theme accent (`bg-primary`) — unchanged
    for chord-readout.
  - Map form → each pitch lit in its mapped CSS color; an empty-string value
    `""` falls back to the accent (matches the full keyboard's
    `colorMap.get(track) ?? ""`).
  - Normalize internally to a lookup returning `undefined` (resting) | `""`
    (accent) | color. Per key: `bg-primary` class only when lit *and* no
    explicit color; inline `backgroundColor` = the explicit color when present,
    else the resting ivory/near-black.
- **`renderKey?: (key: KeyLane, lit: boolean) => ReactNode`** — optional content
  drawn inside each key. Make every key div a `flex items-end justify-center`
  container (harmless for contentless chord-readout keys) and render
  `{renderKey?.(k, isLit)}` inside. All label-specific styling (font size,
  text-color flip, eslint-disables) stays in the *caller*, since `renderKey`
  receives `isBlack` (via `key`) and `lit`.
- **Container className via `cn`** — root becomes
  `cn("relative overflow-hidden rounded-sm", className)` (import `cn` from
  `@plugins/primitives/ui-kit/web`). `cn`/twMerge lets the full keyboard override
  position/rounding/bg cleanly (`absolute inset-0 rounded-none bg-muted/30`)
  without `relative`+`absolute` conflicting.

Keep the resting-color constants (`WHITE_KEY`/`BLACK_KEY` bg+border) and the
62%-height black-key rule **here** — this is now their single home.

### 2. Refactor `PianoKeyboard` to render via the primitive

`piano-keyboard/web/components/piano-keyboard.tsx`:

- Delete the two-pass white/black div rendering and the `WHITE_KEY.bg/border` /
  `BLACK_KEY.bg/border` key constants (now owned by the primitive). **Keep**
  `WHITE_KEY.label` / `BLACK_KEY.label` (resting label text colors — a label
  concern, not a key-chrome concern).
- Keep all data wiring unchanged: `useSonata`, `useConfig(pianoKeyboardConfig)`,
  `useTrackColorMap` / `useHiddenTrackIds` / `useMutedTrackIds`, the `speller`,
  `keyLabel`, and the `sounding` map. `sounding` is already a
  `Map<number, string>` — pass it straight through as `lit`.
- Derive the range from the projection (stay projection-driven):
  `low = keys[0].pitch`, `high = keys.at(-1).pitch` (guard `if (!keys?.length) return null`).
- Render:
  ```tsx
  <MiniKeyboard
    low={low}
    high={high}
    lit={sounding}
    className="absolute inset-0 rounded-none bg-muted/30"
    renderKey={(k, lit) => {
      const text = keyLabel(k, speller, scope);
      if (!text) return null;
      return (
        <span
          /* eslint-disable-next-line ... -- 9px/7px label tuned to key cap */
          className={`select-none ${k.isBlack ? "text-[7px] mb-0.5" : "text-[9px] mb-1"} leading-none ${lit ? "text-primary-foreground" : ""}`}
          style={lit ? undefined : { color: k.isBlack ? BLACK_KEY.label : WHITE_KEY.label }}
        >
          {text}
        </span>
      );
    }}
  />
  ```
  (The white/black bottom offset moves from the key div's `pb-1`/`pb-0.5` onto
  the label span's `mb-1`/`mb-0.5`, preserving the lift.)
- Add import: `MiniKeyboard` from
  `@plugins/apps/plugins/sonata/plugins/primitives/plugins/mini-keyboard/web`.

### 3. Derive the piano-roll's pixel geometry from the primitive

`piano-roll/web/components/geometry.ts`:

- Import `keyLayout as fractionalKeyLayout, isBlackPitch` from the mini-keyboard
  **web** barrel.
- Replace the local pixel `keyLayout(width)` with a scale of the fractional one:
  ```ts
  export function keyLayout(width: number): KeyLane[] {
    return fractionalKeyLayout(KEYBOARD_LOW, KEYBOARD_HIGH).map((k) => ({
      ...k,
      center: k.center * width,
      width: k.width * width,
    }));
  }
  ```
  (Produces the score/core pixel `KeyLane` — structurally identical shape.)
- Delete the duplicated `WHITE_PCS`, `BLACK_WIDTH_RATIO`, and the local
  `isBlackPitch` body; **re-export** `isBlackPitch` from the primitive so
  `piano-roll.tsx` (`import { ..., isBlackPitch } from "./geometry"`, lines 22 &
  301) keeps working untouched.
- Keep `KEYBOARD_LOW`/`KEYBOARD_HIGH`/`WHITE_KEY_COUNT` (piano-roll domain facts;
  `WHITE_KEY_COUNT` is still the `noteToRect` fallback width divisor).

After this, the tiling formula + `0.62` ratio + `isBlackPitch` + `WHITE_PCS`
live **only** in `key-layout.ts`.

## Critical files

- `…/primitives/plugins/mini-keyboard/web/internal/mini-keyboard.tsx` — extend props + drawing (own home of key chrome).
- `…/primitives/plugins/mini-keyboard/web/internal/key-layout.ts` — canonical geometry (drop the "follow-up" comment once done).
- `…/piano-keyboard/web/components/piano-keyboard.tsx` — delegate rendering to `MiniKeyboard`.
- `…/piano-roll/web/components/geometry.ts` — derive pixel layout from fractional; re-export `isBlackPitch`.
- (read-only refs) `…/score/core/types.ts` (`KeyLane`/`Projection`), `…/rich/plugins/chord-readout/web/components/chord-readout.tsx` (array-form `lit` caller — must keep working).

## Boundaries / risks

- New import edges: `piano-keyboard/web` → `mini-keyboard/web`, and
  `piano-roll/web` → `mini-keyboard/web`. Both are legal nested-barrel imports
  and acyclic (mini-keyboard imports only React + `cn`). No cycle.
- `MiniKeyboard` assumes a contiguous `[low, high]` range — the full roll is
  always the contiguous 88 keys, so deriving `low/high` from `projection.keys`
  endpoints is safe.
- Pixel-fidelity: percentage rendering at the same lane width == the projection's
  pixel layout, so the keyboard stays aligned with the falling notes.

## Verification

1. `./equin build` (regenerates plugin docs; updates the three CLAUDE.md
   autogen blocks for the new imports/exports — commit them).
2. `./equin check` — expect green: `plugin-boundaries`, `type-check`,
   `eslint`, and `plugins-doc-in-sync`.
3. Open `http://att-1781259116-v8b8.localhost:9000`, enter Sonata, open a song:
   - **Full keyboard**: 88 keys laid out identically to before; play and confirm
     keys light in their **per-track** colors (not just the accent) and labels
     follow the key-signature/label-scope config; black keys 62% height,
     correctly positioned on the boundaries; columns land exactly on keys.
   - **Chord readout** ("Current chord" section): mini-keyboard still lights the
     voicing in the accent; inversions toggle still works.
   Use `bun e2e/screenshot.mjs --url http://att-1781259116-v8b8.localhost:9000/...`
   to capture before/after if needed.
4. Optional unit check: the primitive's `keyLayout(21,108)` scaled by `W` must
   equal the old pixel layout (52 white keys, `whiteW=W/52`).
