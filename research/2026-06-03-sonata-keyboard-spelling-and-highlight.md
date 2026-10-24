# Sonata keyboard: key-signature spelling + sounding-key highlight

## Context

The Sonata vertical piano roll now renders a full 88-key keyboard in the pitch-axis
gutter (`piano-keyboard` plugin, contributing to `Sonata.PitchAxis`). Two refinements
are missing:

1. **Enharmonic spelling.** White-key labels are hard-coded generic letters
   (`C D E F G A B`); black keys are unlabeled. They should reflect the score's
   key signature (`score.meta.key`) so accidentals read correctly — e.g. Eb Major
   shows `Eb / Ab / Bb`, and extreme keys respell white keys (Gb Major → `Cb`, `Fb`).
   **The set of keys that get labeled must be user-configurable**, defaulting to
   *diatonic-only*.

2. **Sounding-key highlight.** Keys for notes active at the playback cursor are not
   lit. As the transport plays, the keys under the falling notes should highlight so
   the notes visually connect to the keys they land on.

Both build on data already available in the Sonata context (`score`, `cursorBeat`) and
the published `Projection` (`projection.keys`). A blocker: **no current source sets
`score.meta.key`** — the MIDI compiler ignores the file's key-signature event — so the
spelling feature is dormant until we also extract the key. That extraction is in scope
(decided with the user).

## Design decisions (confirmed with user)

- **Label scope is a `config_v2` enum**, default `"diatonic"`. Values:
  - `diatonic` — label only the 7 in-key notes, spelled per key; others blank. In C
    Major this matches today's look; handles `Cb/Fb/E#/B#` in extreme keys.
  - `all` — every key labeled, accidentals oriented to the key (flats in flat keys).
  - `whites-plus-in-key` — white keys always labeled (respelled when diatonic), black
    keys labeled only when in-key.
- **Extract the key from the MIDI header** so the feature is actually visible.

## Where the music theory lives

A new **pure** module in the Sonata leaf, `score/core` — it already owns `KeySignature`
and `PitchSpelling` and depends on nothing. Reusable by future displays (staff, chord
readout). Files:

- `plugins/apps/plugins/sonata/plugins/score/core/spelling.ts` (new)
- export from `plugins/apps/plugins/sonata/plugins/score/core/index.ts`

### `spelling.ts` API

```ts
import type { KeySignature, PitchSpelling } from "./types";
type Step = PitchSpelling["step"];

export interface KeySpeller {
  /** Diatonic spelling for a pitch's pitch-class, or null if not in the key. */
  diatonic(pitch: number): { step: Step; alter: number } | null;
  /** A spelling for ANY pitch: diatonic when in-key, else key-oriented default. */
  spell(pitch: number): PitchSpelling;
}

/** Build a speller for a key. With no key: diatonic() === null, spell() = naturals + sharps. */
export function makeKeySpeller(key?: KeySignature): KeySpeller;

/** "" | "♯" | "♭" | "♯♯" | "♭♭" for alter 0 / ±1 / ±2. */
export function accidentalGlyph(alter: number): string;
```

**Algorithm (circle of fifths):**
- Tonic → fifths: `letterFifths[letter] + 7*accidentals` (`F=-1,C=0,G=1,D=2,A=3,E=4,B=5`;
  each `#` +1, each `b` −1). Minor: subtract 3 (relative-major / natural minor).
- `sharps = max(fifths,0)`, `flats = max(-fifths,0)`. Sharped letters are the first
  `sharps` of `[F,C,G,D,A,E,B]`; flatted letters the first `flats` of `[B,E,A,D,G,C,F]`.
- Build `diatonicMap: pc → {step, alter}` over the 7 letters: `alter` from the
  sharp/flat sets, `pc = (STEP_PC[letter] + alter + 12) % 12`.
- `spell(pitch)`: use `diatonicMap` when present; else default — natural for white pcs,
  and flat (if `fifths < 0`) or sharp for black pcs. Octave from the spelled step.

This is a single ~allocation per key; the keyboard memoizes the speller on
`score.meta.key`.

## Configurable label scope (`config_v2`)

Pattern (verified): a descriptor in `shared/`, registered on BOTH web (`ConfigV2.WebRegister`)
and server (`ConfigV2.Register`) — registering on only one makes the value read back
undefined/throw. The enum renderer + settings UI are automatic (no UI work).

The `piano-keyboard` plugin is **web-only today**; we add a `server/` runtime solely to
host the server registration. `./equin build` regenerates the plugin registry, so
no manual `plugins.ts` edits.

New / changed files in `plugins/apps/plugins/sonata/plugins/piano-keyboard/`:

- `shared/config.ts` (new):
  ```ts
  import { defineConfig } from "@plugins/config_v2/core";
  import { enumField } from "@plugins/config_v2/plugins/fields/plugins/enum/core";

  export const pianoKeyboardConfig = defineConfig({
    fields: {
      labelScope: enumField({
        label: "Key labels",
        description: "Which keys show a note name on the keyboard.",
        options: [
          { value: "diatonic", label: "In-key notes only" },
          { value: "whites-plus-in-key", label: "White keys + in-key accidentals" },
          { value: "all", label: "All keys" },
        ],
        default: "diatonic",
      }),
    },
  });
  ```
- `web/index.ts` (edit): add `ConfigV2.WebRegister({ descriptor: pianoKeyboardConfig })`
  to `contributions` (import from `@plugins/config_v2/web` and `../shared/config`).
- `server/index.ts` (new): `ServerPluginDefinition` whose only contribution is
  `ConfigV2.Register({ descriptor: pianoKeyboardConfig })` (import from
  `@plugins/config_v2/server`). Keep barrel pure (imports + single default export).

## Keyboard component changes

`plugins/apps/plugins/sonata/plugins/piano-keyboard/web/components/piano-keyboard.tsx`

The component already receives `{ projection }` and is rendered inside `SonataProvider`
and the plugin runtime, so it may call `useSonata()` and `useConfig()` directly.

```ts
const { labelScope } = useConfig(pianoKeyboardConfig);
const { score, cursorBeat } = useSonata();
const speller = useMemo(() => makeKeySpeller(score.meta.key), [score.meta.key]);
const sounding = useMemo(() => {
  const s = new Set<number>();
  for (const n of score.notes)
    if (n.start <= cursorBeat && cursorBeat < n.start + n.duration) s.add(n.pitch);
  return s;
}, [score.notes, cursorBeat]);
```

- **Label resolution** per `KeyLane` (drop the `WHITE_LETTER` map):
  - `diatonic`: `speller.diatonic(pitch)` → label, else blank.
  - `whites-plus-in-key`: white → diatonic spelling or natural letter; black → diatonic
    or blank.
  - `all`: `speller.spell(pitch)` always.
  - Render = `step + accidentalGlyph(alter)`, appending the octave number only on a
    natural C (`step==="C" && alter===0`), preserving today's octave-marker behavior.
  - Black keys now get a label span too (small text, light color over the dark key).
- **Highlight**: when `sounding.has(k.pitch)`, swap the key's base fill for an accent
  (white: `bg-primary text-primary-foreground` in place of `bg-background`; black:
  `bg-primary` in place of `bg-foreground`). Recompute is per-frame during playback;
  fine for keyboard-sized data (linear scan over notes).

The `cursorBeat`-active filter mirrors the canonical pattern in
`rich/.../chord-analyzer` and `chord-readout` (`n.start <= beat < n.start + n.duration`).

## MIDI key extraction

`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web/compile.ts`

`@tonejs/midi` exposes `midi.header.keySignatures: { ticks, key, scale }[]` (`key` a note
name like `"Eb"`, `scale` `"major"|"minor"`). Populate `meta.key` from the first event:

```ts
const ks = midi.header.keySignatures[0];
// ...
meta: {
  ...(midi.header.name ? { title: midi.header.name } : {}),
  ...(ks?.key ? { key: { tonic: ks.key, mode: ks.scale === "minor" ? "minor" : "major" } } : {}),
},
```

Guard for an absent/empty array (many MIDI files carry no key signature → stays
undefined → keyboard falls back to natural spelling). Verify the exact field names
against the installed `@tonejs/midi` types during implementation; handle gracefully if
the shape differs (no throw — absence is normal).

## Critical files

| File | Change |
| --- | --- |
| `…/score/core/spelling.ts` | **new** — `makeKeySpeller`, `accidentalGlyph` |
| `…/score/core/index.ts` | export the new spelling API |
| `…/piano-keyboard/shared/config.ts` | **new** — `pianoKeyboardConfig` enum descriptor |
| `…/piano-keyboard/web/index.ts` | add `ConfigV2.WebRegister` contribution |
| `…/piano-keyboard/server/index.ts` | **new** — `ConfigV2.Register` contribution |
| `…/piano-keyboard/web/components/piano-keyboard.tsx` | spelling + scope + highlight |
| `…/sources/plugins/midi/web/compile.ts` | extract `meta.key` from MIDI header |

## Verification

1. `./equin build` (from this worktree) — regenerates migrations/registry/docs and
   restarts. Confirm the build passes (`plugin-boundaries`, `eslint`,
   `plugins-doc-in-sync` checks included).
2. Open `http://att-1780445858-i2yt.localhost:9000/` → Sonata. Load a MIDI file that
   carries a key signature (ideally a flat key such as Eb/Bb). Confirm:
   - White/black keys spell per the key (Eb Major → `Eb`, `Ab`, `Bb`).
   - Default scope is `diatonic` (only in-key notes labeled; C Major unchanged from
     before).
3. Scripted Playwright run (`bun e2e/screenshot.mjs`) — press play, capture
   before/after, confirm keys under active notes highlight at the cursor and clear as
   notes end.
4. Open the **Config** settings pane → `piano-keyboard` → switch label scope between
   `diatonic` / `whites-plus-in-key` / `all`; confirm the keyboard relabels live.
5. Fallback: load a MIDI file with no key signature → keyboard shows natural spelling
   (no crash), matching prior behavior.

## Notes / out of scope

- **Key inference from notes** (when a MIDI file has no key signature) is intentionally
  not included — extraction covers files that declare a key; undeclared keys fall back
  to naturals.
- Highlight uses a single accent color (not per-track/hand tinting) — keep simple.
