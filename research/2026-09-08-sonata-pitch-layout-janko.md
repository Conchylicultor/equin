# Sonata: a pitch-layout abstraction, and a Jankó keyboard on it

## Context

Sonata's vertical piano roll assumes the piano everywhere pitch meets the screen.
One formula — `keyLayout(low, high)` in the keyboard primitive
(`primitives/plugins/keyboard/web/internal/key-layout.ts`) — is called directly by
the roll's geometry (`piano-roll/web/components/geometry.ts`), by the roll
component for its grid lines (`piano-roll.tsx:323`), and by the `Keyboard`
renderer. Every key carries an `isBlack` flag, and the three key skins (flat,
realistic, drawn) are written around "white keys tile the bottom, black keys sit
62% tall on top". A pixel copy of the key type lives in `score/core/types.ts`
(`KeyLane`) and the roll's gutter height is a constant (`KEYBOARD_HEIGHT = 112`).

The user wants a **Jankó (isomorphic) keyboard** as an option: uniform pads in
rows, every semitone offset half a pad, so every chord shape is the same in every
key. Jankó fits the roll because its x position is linear in pitch; hex layouts
(Wicki-Hayden) would not, and are out of scope.

Decisions taken with the user:

- **Closed record, tsc-enforced.** Layout ids are plain data (like `look`); the
  implementations are a `Record<PitchLayoutId, …>`, so an id without an
  implementation is a type error. No slot, no sub-plugin per layout.
- **One global choice, whole X axis.** Switching the layout re-lays the falling
  notes, the grid guides, the keyboard under the roll, AND the chord/key readout
  chips.
- **Jankó v1 = 4 rows** (the 2-row pattern duplicated), so every pitch has two
  pads. Flat chrome only; under the realistic and sketch looks Jankó renders the
  same pads tinted from that look's palette (never blank).

The end state the user sees: in the piano roll's View popover a new row
**Keyboard layout: Piano / Jankó (isomorphic)**. Flip it and the notes fall onto
evenly spaced pads, the keyboard below becomes four rows of pads that light and
play like the piano keys did, and the chord/key chips show the same pads.

## The shape of the solution

Three boundaries, one direction of dependency:

```
score/core        the CONTRACT: PitchLayoutId, PitchKey, PitchColumn, PitchGuide,
                  PitchPlane, isAccidental(); Projection.pitchPlane
      ▲
pitch-layout/     the CHOICE + the GEOMETRY: config, labels, piano + jankó
 core/web/server  pure geometry, heights, pitchGeometry(), usePitchGeometry()
      ▲                       ▲                        ▲
piano-roll        keyboard primitive           rich/{chord,key}-readout
(X axis, guides,  (renders ANY plane; chrome   (usePitchGeometry(low, high))
 gutter height)    per layout id)
      ▲
piano-keyboard    passes projection.pitchPlane straight into <Keyboard>
```

A neutral leaf owns the layout for the same reason `look` is a leaf
(`look/CLAUDE.md`): if the roll owned it the keyboard would import a display; if
the keyboard owned it the roll would import the keyboard for its lane and grid.
`score/core` keeps only the types, because it is the zero-import narrow waist
every Sonata plugin reads, and must not drag `config_v2` in.

Four properties the types make true:

1. **A note lands on its key by construction.** `PianoKeyboard` no longer
   re-derives a range and re-lays keys: it hands `projection.pitchPlane` — the
   very pads the roll built its columns from — to `<Keyboard plane>`.
2. **Chrome, geometry and config cannot disagree.** `PitchPlane.layout` names the
   layout it was laid in; `Keyboard` picks its chrome from that, not from a second
   config read.
3. **Chrome cannot move or resize a key.** The style a chrome returns is
   `Omit<CSSProperties, position | inset | top | … | width | height | translate>`.
   Today's `height: 62%` leak in `blackKeyStyle` becomes a tsc error; the box is
   the layout's alone.
4. **No fabricated positions.** A pitch the axis does not carry is dropped from
   the visuals and yields `null` from `pitchToX`/`noteToRect`, instead of today's
   white-key-wide bar pinned at x=0.

`isBlack` goes away as a layout concept. What remains is `isAccidental(pitch)`, a
pitch-class fact in `score/core`, which the note shade, the label scope and the
pad colours all read. A pad's appearance is `(plane.layout, isAccidental(pitch))`.

## Geometry contract (`score/core/pitch-plane.ts`, new, zero imports)

```ts
/** Which layout a plane was laid in. Closed; pitch-layout/core answers for each. */
export type PitchLayoutId = "piano" | "janko";

/** One pad on the keybed. X fractions of the axis width, Y fractions of the
 *  keybed height, top 0 at the edge the notes fall onto. */
export interface PitchKey {
  pitch: number;
  center: number; width: number;
  top: number; height: number;
  /** Paint order; a higher tier paints over a lower one. Piano white 0 / black 1; jankó all 0. */
  tier: number;
}
/** The X column ONE pitch's falling notes occupy (fractions of axis width). */
export interface PitchColumn { pitch: number; center: number; width: number }
/** A vertical orientation rule at a column's left edge. */
export interface PitchGuide { frac: number; strong: boolean }

declare const laidOut: unique symbol;
export interface PitchPlane {
  /** Brand: only `pitchGeometry()` mints a plane. A hand-built object literal
   *  cannot satisfy the type, so the snap rule is not documentation. */
  readonly [laidOut]: true;
  layout: PitchLayoutId;
  /** The SNAPPED inclusive MIDI range these pads cover. */
  low: number; high: number;
  /** Every pad, ascending by tier then pitch. A pitch may appear more than once. */
  keys: readonly PitchKey[];
  /** Exactly one per pitch in [low, high], ascending, contiguous. */
  columns: readonly PitchColumn[];
  guides: readonly PitchGuide[];
}
```

`columns` is a declared output, not a dedupe of `keys`: on Jankó a pad is
`2/(N+1)` wide and overlaps its semitone neighbours by half, while a note column
is the non-overlapping stride `1/(N+1)`, so a chromatic run does not smear. On
piano, column and pad coincide.

`Projection` (`score/core/types.ts`) loses `keys?: KeyLane[]` (delete `KeyLane`,
its only reader used `keys[0].pitch` / `keys.at(-1).pitch`) and gains:

```ts
pitchPlane?: PitchPlane;                       // present iff "pitch-plane"
pitchToX?: (pitch: number) => number | null;   // px; null = not on this axis
noteToRect?: (note: Note) => { x; y; w; h } | null;
```

`isAccidental(pitch)` moves into `score/core/spelling.ts` beside
`accidentalGlyph` (it was `isBlackPitch` in the keyboard primitive).

## The `pitch-layout` plugin (`sonata/plugins/pitch-layout/`, new)

Mirror `look/` byte-for-byte: `core/`, `web/`, `server/`, `package.json`,
`CLAUDE.md`, later `e2e/`.

**`core/config.ts`** — mirrors `look/core/config.ts`:

```ts
export const PITCH_LAYOUT_LABELS: Record<PitchLayoutId, string> = {
  piano: "Piano",
  janko: "Jankó (isomorphic)",
};                                     // exhaustive by type: a new id must be labelled
export const PITCH_LAYOUT_DEFAULT: PitchLayoutId = "piano";
export const pitchLayoutConfig = defineConfig({
  fields: {
    layout: enumField({
      label: "Keyboard layout",
      description: "How pitch is laid across the roll — the falling notes, the grid, the keys below them, and the chord readouts.",
      options: (Object.keys(PITCH_LAYOUT_LABELS) as PitchLayoutId[]).map((value) => ({ value, label: PITCH_LAYOUT_LABELS[value] })),
      default: PITCH_LAYOUT_DEFAULT,
    }),
  },
});
export function asPitchLayoutId(value: string): PitchLayoutId; // throws on unknown, like asSonataLook
```

**`core/geometry.ts`** — the closed record behind ONE entry point:

```ts
export type PitchKeyboardSize = "keybed" | "chip";
interface PitchLayout {                      // internal; tests import the file
  snapRange(low: number, high: number): { low: number; high: number };   // idempotent, only widens
  lay(low: number, high: number): { keys: PitchKey[]; columns: PitchColumn[]; guides: PitchGuide[] };
  heights: Record<PitchKeyboardSize, number>;   // px; a deliberate per-layout choice, not a formula
}
const PITCH_LAYOUTS: Record<PitchLayoutId, PitchLayout> = { piano: pianoLayout, janko: jankoLayout };

/** Snap the range, lay it out. Pure; the only way to obtain a plane. */
export function pitchGeometry(layout: PitchLayoutId, low: number, high: number): PitchPlane;
/** The keybed / chip height a layout wants, in px. */
export function pitchKeyboardHeight(layout: PitchLayoutId, size: PitchKeyboardSize): number;
```

**`core/piano.ts`** — `key-layout.ts` moved and re-expressed. `BLACK_WIDTH_RATIO`
0.62 stays. Naturals `{top 0, height 1, tier 0}`; accidentals `{center = white
boundary, width = w·0.62, top 0, height 0.62, tier 1}`. `BLACK_KEY_HEIGHT_PCT` is
deleted: the pad's own `height` is the one source, and the renderer writes every
extent through `pct()` from `css/plugins/coords/web` (no local `* 100`
arithmetic). If `62.000000000000014%` in devtools bothers anyone, round inside
`pct` itself, not at a call site. `snapRange` widens outward while an endpoint is an
accidental (identity on 21..108 and 60..95, every current caller). Columns equal
the pads. Guides: pitch class 0 strong, 5 weak, `frac = center − width/2` — the
exact list `piano-roll.tsx:323` builds today. Heights `{ keybed: 112, chip: 44 }`
(today's constant and `h-11`).

**`core/janko.ts`** — with `N = high − low + 1`, `i = pitch − low`:

| quantity | value |
|---|---|
| pad width | `2 / (N + 1)` |
| pad and column center | `(i + 1) / (N + 1)` |
| column width | `1 / (N + 1)` |
| row height | `1 / 4` |

Rows indexed 0 at the top (the roll edge). Parities top→bottom: odd, even, odd,
even — so the row nearest the player is the C row (C D E F# G# A#), as on a
physical Jankó. A pitch of parity `q` gets rows `1 − q` and `3 − q`. All pads
`tier 0` (same-parity pads never overlap within a row). Both pads of a pitch share
a center. `snapRange` is the identity. Guides: strong at each C column's left
edge, weak at each F# (the midpoint of the six-pad row cycle; Jankó has no E–F
seam). Heights `{ keybed: 140, chip: 64 }` (four rows need more than 112px; tune
on screenshot).

**`web/index.ts`** — mirrors `look/web/index.ts`:
`ConfigV2.WebRegister({ descriptor: pitchLayoutConfig })`,
`Sonata.ViewOption({ id: "pitch-layout", displays: ["piano-roll"], config: pitchLayoutConfig })`,
plus the one hook renderers use:

```ts
/** The active layout's plane for a requested range. Memoized on (id, low, high),
 *  so the array identities the drawn skin memoizes paths on are stable. */
export function usePitchGeometry(low: number, high: number): PitchPlane;
```

**`server/index.ts`** — `ConfigV2.Register({ descriptor: pitchLayoutConfig })`
(both registrations required or reads come back undefined).

Edges: `pitch-layout → score` (core), `pitch-layout → shell` (web only, for the
ViewOption); `{keyboard, piano-roll, piano-keyboard, rich/*} → pitch-layout`.
`shell` imports only leaf cores (`score`, `theory`, `rhythm`, `voicing`) — the
same star `look` already proves acyclic.

## The keyboard primitive (`primitives/plugins/keyboard/`)

The primitive renders EVERY key element itself and owns every invariant a layout
must not be able to break: `data-pitch` on each key, tier paint order, the box
from `PitchKey`, the lit lookup, the label host, the `Clip` frame and pointer
handlers (`use-playable-keyboard.ts` is untouched — hit-testing is
`elementFromPoint().closest("[data-pitch]")`, layout-agnostic). A chrome only
paints.

**Props** (`web/internal/keyboard.tsx`, rewrite; paint constants leave):

```ts
export interface KeyRenderState {
  lit: boolean;
  /** Which label colour reads on this key at rest (from the chrome). */
  tone: LabelTone;                 // "on-light" | "on-dark"
  /** Narrower than the plane's widest key (< 0.9×) — reproduces today's black/white label-size split. */
  narrow: boolean;
}
export interface KeyboardProps {
  plane: PitchPlane;                                   // replaces low / high
  lit: KeyHighlight;                                   // unchanged
  renderKey?: (key: PitchKey, state: KeyRenderState) => ReactNode;
  accidentalColor?: (base: string) => string;          // unchanged
  interaction?: KeyboardInteraction;                   // unchanged
  className?: string;
}
```

Render: `KEY_CHROME[plane.layout]`, skin from `SONATA_LOOK_STYLES[look].keys` as
today; keys grouped by tier (memoized on `plane`); tiers ascending, each preceded
by its decor; every key is a `<Placed>` (`css/plugins/coords`, the sanctioned
runtime-coordinate box — drops the `no-adhoc-layout` disable) with
`data-pitch`, `x={{ start: pct(center − width/2), size: pct(width) }}`,
`y={{ start: pct(top), size: pct(height) }}`, React key `` `${pitch}@${top}` ``
(unique across a pitch's duplicate pads), `style={{ isolation: "isolate", …paint.style }}`
(DOM order gives stacking; `z-raised` leaves the black key), then
`paint.children`, then the label in `<Pin to="bottom" offset="2xs" decorative>`.
The primitive resolves each lit colour once into both readings a chrome may want.

**Chrome contract** (`web/internal/chrome/types.ts`, internal):

```ts
export type KeyChromeStyle = Omit<CSSProperties, "position"|"inset"|"top"|"right"|"bottom"|"left"|"width"|"height"|"translate">;
export interface LitKey { color: string; accidental: string }   // accidental = accidentalColor(color) on an accidental pitch, else color
export interface KeyPaintContext { skin: SonataKeys; indexInTier: number }
export interface KeyPaint { style: KeyChromeStyle; children?: ReactNode }
export interface ChromeDecor { id: string; tier: number; node: ReactNode }  // painted BEFORE that tier's keys, even when the tier is empty
export interface KeyTier { tier: number; keys: readonly PitchKey[] }
export interface ChromeDecorContext { tiers: readonly KeyTier[]; skin: SonataKeys; litColors: ReadonlyMap<number, string> }
export interface KeyChrome {
  paintKey(key: PitchKey, lit: LitKey | undefined, ctx: KeyPaintContext): KeyPaint;
  decor(ctx: ChromeDecorContext): readonly ChromeDecor[];   // required; jankó returns a frozen NO_DECOR
  labelTone(key: PitchKey): LabelTone;
}
// chrome/index.ts
export const KEY_CHROME: Record<PitchLayoutId, KeyChrome> = { piano: pianoChrome, janko: jankoChrome };
```

`tier` never reaches a chrome; chromes ask `isAccidental(key.pitch)`.

**`chrome/piano.tsx`** — a MOVE of today's style functions and constants
(`PRESS_TRANSITION`, `KEY_BOTTOM_RADIUS`, `FELT_*`, `WHITE_*`, `BLACK_*`,
`FLAT_*`, `flatWhiteCarve`, `whiteKeyStyle`, `blackKeyStyle`, `BLACK_FACE`,
`DRAWN_CHROME`). Four edits: `blackKeyStyle` loses `height: 62%` (now a tsc
error); `isFirst` becomes `ctx.indexInTier === 0`; `BLACK_FACE` loses `zIndex: -1`
and is returned as `children` via `<Pin to="bottom" stretch decorative aria-hidden>`;
`decor()` returns, in order, `sketch-white` (tier 0, drawn only), `felt` (tier 1,
flat/realistic), `sketch-black` (tier 1, drawn only). Flat reads `lit.accidental`,
realistic and drawn read `lit.color` (they build darkness from a gradient —
today's reasoning). `labelTone` = accidental ? on-dark : on-light.

**`chrome/janko.tsx`** — uniform pads, ~90 lines. Gap = inset 1px ring in the
keybed colour (same technique as `flatWhiteCarve`: hit targets tile edge to edge,
no dead zone for glissando). Radius 3px all corners, inline (physical-object
shape). **Resting colour by `isAccidental`, not row parity** — a Jankó row mixes
naturals and accidentals, so parity would put a dark falling note on a light pad;
ivory for naturals, ebony for accidentals transfers the piano's reading. Lit fill
= `lit.accidental` on an accidental, `lit.color` otherwise (lockstep with the
roll's note shade). **C carries an orientation mark** (a 2px inset left bar) since
every octave of an isomorphic keyboard looks identical — the same cue the roll's
strong guide gives. Under `realistic`: same pads plus a top-light gradient and the
`translateY(1px)` + glow press. Under `drawn`: fills `skin.ivory`/`skin.ebony`,
ring `skin.ink`, no SVG. `decor()` → `NO_DECOR`. Duplicate pads need no code:
`litColors` is per pitch, and a glissando between a pitch's two pads is a no-op.
`paintKey` runs per key per render (176 pads on Jankó), so keep it
allocation-light: template strings for shadow lists, no object spreads per key.

**`sketch-skin.tsx`** — `lanes: readonly PitchKey[]`; `group: "white"|"black"`
becomes `accidental: boolean` (it selects the pen, not the tier);
`buildSketchArt` reads `k.top`/`k.height` × measured px. `sketch-paths.ts` and
its test are untouched (they take boxes).

**`web/index.ts`** exports `Keyboard`, `KeyboardProps`, `KeyHighlight`,
`KeyRenderState`, `LabelTone`. `keyLayout`, `isBlackPitch`, `KeyLane` leave
(`pitchGeometry`, `isAccidental`, `PitchKey` replace them). `key-layout.ts` is
deleted. The plugin's `CLAUDE.md` "no config of its own" note stays true.

## The roll (`piano-roll/`)

**`geometry.ts`** — delete pixel `keyLayout(width)`, `WHITE_KEY_COUNT`, the
`isBlackPitch` re-export and the `keyboard/web` import. Keep `KEYBOARD_LOW = 21`
/ `KEYBOARD_HIGH = 108` (the display's choice of how much to show, not a layout
fact). `NoteVisual.isBlack` → `isAccidental`. Both builders take the plane:

```ts
buildNoteVisuals({ score, plane, hiddenIds, colorMap, accidentalColor, speller, tempoScale }): NoteVisual[]
buildProjection({ width, height, plane, score, tempoScale, spread }): Projection
```

`byPitch` is built from `plane.columns`; a note with no column is dropped, and
`pitchToX`/`noteToRect` return `null` for it. The `?? width/WHITE_KEY_COUNT` and
`?? 0` fallbacks go.

**`piano-roll.tsx`** — read once, thread down:

```ts
const { layout } = useConfig(pitchLayoutConfig);
const plane = useMemo(() => pitchGeometry(asPitchLayoutId(layout), KEYBOARD_LOW, KEYBOARD_HIGH), [layout]);
```

`plane` joins the `visuals` and `projection` memo deps; the dep-less `pitchLines`
memo is deleted and `pitchLines={plane.guides}` goes to the canvas; the gutter
`style={{ height: KEYBOARD_HEIGHT }}` becomes
`pitchKeyboardHeight(plane.layout, "keybed")` and the constant is deleted.

**`internal/pixi/grid.ts`** — `PitchLine` → `PitchGuide` from `score/core`
(structurally identical; import + name only, through `scene.ts` and `app.tsx`).

**`slots.ts` + `scene.ts`** — `FxNoteEvent.isBlack` → `isAccidental` (no FX
plugin reads it). **`fx-core.tsx`** — after the existing `noteToRect` presence
throw: `const rect = noteToRect(bar.note); if (!rect) continue;`.

**`track-mixer`** — `blackKeyColor` → `accidentalColor` (the `Keyboard` prop is
already named that; one name per concept). Call sites: `piano-roll.tsx`,
`piano-keyboard.tsx`, `track-mixer-panel.tsx`.

## The keyboard under the roll (`piano-keyboard/`)

`const keys = projection.keys` → `projection.pitchPlane` (presence check replaces
`keys?.length`); `<Keyboard plane={plane} …>` — no low/high derivation. The stray
`KeyLane` import from `score/core` (the roll's PIXEL type, used today against the
primitive's FRACTIONAL value, compiling by structural coincidence) goes.
`keyLabel` uses `isAccidental(k.pitch)`; `renderKey={(k, { lit, tone, narrow }) => …}`
sizes by `narrow` (7px/9px) and colours by `LABEL_COLOR[tone]`; the `mb-*`
classes and their `no-adhoc-spacing` disable go (the primitive's `Pin offset="2xs"`
seats the label — the ONE intentional pixel change in the piano path, 2px instead
of 4px off the lip; check on screenshot). Both pads of a Jankó pitch get labelled.

`shared/config.ts`: keep the persisted value `whites-plus-in-key` (`enumField`
builds `z.enum` from the values; renaming would silently drop the user's setting
and config_v2 has no migration); rename the visible label to
"Naturals + in-key accidentals" and note on the local `LabelScope` union why the
spelling lags.

## The readouts (`rich/plugins/{chord,key}-readout/`)

Both: `const plane = usePitchGeometry(low, high)` → `<Keyboard plane={plane}>`;
`h-11` → `style={{ height: pitchKeyboardHeight(plane.layout, "chip") }}`.
Chord-readout KEEPS `fitToWindow` (octave shift + whole-octave widening is a
CONTENT fit; what it stops owning is flushness — drop the "keyLayout tiles flush
only then" clause). Key-readout builds its lit map by walking `KB_LOW..KB_HIGH`;
it walks `plane.low..plane.high` instead, so a layout that snaps wider never
leaves unlit pads.

## Migration order

Each step type-checks on its own; steps 1–6 leave the app pixel-identical under
`piano` (its `snapRange` is the identity on 21..108 and its pads reproduce the
current fractions).

1. `score/core`: add `pitch-plane.ts` + `isAccidental`; export. Nothing consumes yet.
2. Add the whole `pitch-layout/` plugin with its tests.
3. `./equin build` (background) so the registry codegen picks the plugin up.
4. `Projection` change (delete `KeyLane`, add `pitchPlane`, nullable accessors);
   fix `geometry.ts`, `piano-keyboard.tsx`, `fx-core.tsx` in the same step.
5. `geometry.ts` + `piano-roll.tsx` rewrite; `PitchLine` → `PitchGuide`;
   `isBlack` → `isAccidental`; `blackKeyColor` → `accidentalColor`; gutter height.
6. Chrome types + piano chrome + `keyboard.tsx` rewrite + `sketch-skin` migration;
   readouts and `piano-keyboard` onto `plane`. **Checkpoint: screenshot; the piano
   path must match main except the 2px label seat.**
7. Jankó geometry entry is already in the record (step 2); add `chrome/janko.tsx`.
   The View popover row exists from step 3; Jankó becomes reachable here.
8. Delete `key-layout.ts`, trim the barrel, update both plugins' `CLAUDE.md`,
   `./equin build` for the doc-in-sync check.

## Tests (all `*.test.ts` beside source → bun runner)

- `pitch-layout/core/geometry.test.ts`, looped over every id in
  `PITCH_LAYOUT_LABELS` so a third layout gets it free: pads span exactly [0,1];
  exactly one column per pitch in `[low, high]`, ascending, contiguous; every
  pad's center equals its pitch's column center (the "note lands on its key"
  invariant); every guide coincides with a column's left edge; `snapRange` is
  idempotent and only widens; output is deep-equal across calls; `heights` are
  positive integers.
- `pitch-layout/core/piano.test.ts` — the moved assertions: 52 naturals over
  21..108 at 1/52; accidentals 0.62 wide on white boundaries, height 0.62, tier 1;
  guides at pitch classes 0 (strong) and 5.
- `pitch-layout/core/janko.test.ts` — pad width `2/(N+1)`; every pitch in exactly
  two rows two apart of alternating parity; bottom row holds even pitch classes;
  no overlap within a row; column width `1/(N+1)`; `snapRange` identity.
- `piano-roll/web/components/geometry.test.ts` — the xFrac/wFrac contract test
  re-pointed at `pitchGeometry(id, …)` and looped over both layouts
  (`xFrac === column.center − column.width/2`); `isAccidental` replaces the
  isBlack case; NEW: pitch 8 yields no visual and `noteToRect` returns null;
  tempo/spread tests untouched.

## Verification

```
./equin check plugin-boundaries
./equin check type-check
./equin test plugins/apps/plugins/sonata/plugins
./equin build          # run_in_background: true
```

Then at `http://att-1788817374-fqt2.localhost:9000`, open a song, flip
**Keyboard layout** in the View popover. A new
`pitch-layout/e2e/pitch-layout-verify.ts` modelled on `look/e2e/look-verify.ts`:
load a song, wait for the canvas, count `[data-pitch]` elements (88 = piano,
176 = jankó — identifies the active layout without driving the combobox), click a
key to prove hit-testing, `snap` at rest and mid-playback. Run per layout × look
(six pairs, picker switched by hand). The thing to look at: under `piano` the
roll and keyboard must be pixel-identical to main apart from the 2px label seat.

## Open points (non-blocking; defaults chosen)

- **Jankó note column = half a pad.** Notes are the stride wide, centered on the
  pad, so a chromatic run stays legible. If they read too thin, a per-layout
  column-width factor is a one-line change in `janko.ts`.
- **C orientation mark on Jankó pads** is an addition, not in the brief.
- **Jankó chip height 64px** (vs 44) is a guess to tune on screenshot.
- Realistic and sketch Jankó skins are deliberately minimal (tinted flat pads);
  richer versions are follow-up tasks.
