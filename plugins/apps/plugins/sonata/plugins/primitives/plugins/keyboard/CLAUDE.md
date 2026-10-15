# keyboard

## Two layouts × three skins

The primitive draws a **`PitchPlane`** — a set of pads with fractional boxes and
the name of the layout they were laid in — and it has no geometry of its own.
The plane comes from `pitch-layout`, and it is the SAME plane the falling notes
were laid on, which is what makes "a note lands on its key" true by construction
instead of by two formulas agreeing. There is no `low`/`high` pair to pass and
nothing here to re-derive.

Two things vary independently:

- **The layout** (`plane.layout`, `piano` | `janko`) — where the pads are, and
  which chrome paints them. Picked from the plane itself, never from a second
  config read, so a keyboard cannot be drawn as a piano while its pads are
  Jankó's.
- **The skin** (`SONATA_LOOK_STYLES[look].keys.skin`, `flat` | `realistic` |
  `drawn`) — what the pads are made of. **This plugin holds no switch of its
  own**: all three come straight off Sonata's look, so the choice applies
  everywhere a keyboard renders (the 88-key roll, the chord/key readout chips,
  the website vignette) from one control.

  It used to own a `keyStyle` config for the first two, with the look's drawn
  skin overriding it. But nothing could ever select drawn *and* a key style: the
  pair was one three-valued choice wearing two controls, and the second sat inert
  in the View popover whenever the look drew its own keys. Folding it into the
  look leaves the unreachable combination with no spelling, rather than a rule
  that suppresses it.

## Sizing: `fill` or `proportional`

`sizing` is a REQUIRED prop, so no surface gets squashed keys by forgetting to
choose who owns the box:

- **`fill`** — the caller sizes the frame (a `style` height from
  `pitchKeyboardHeight(layout, "keybed")`, or a full-bleed layer). The roll's
  keybed gutter and the Chord app's card use it: their keys must stretch to a
  fixed box (under the falling notes, or a card of a set height).
- **`proportional`** — the primitive sizes the frame from the plane:
  `width: 100%`, `aspect-ratio: plane.aspect`, `max-width: plane.span ×
  MAX_KEY_PX` (24px). Every key keeps its natural shape, so a narrower keyboard
  is a SHORTER one. Applied after `style`, so a caller cannot half-override it.
  The readouts use it. No measuring: the drawn skin already measures its own box.

The proportion is the layout's (`PitchLayout.proportion` in `pitch-layout`,
written onto the plane as `span` / `aspect`), so a Jankó keyboard keeps its
pads' shape the same way a piano keeps its keys'. There is no fixed "chip"
height any more — it was what squashed readout keys as the panel narrowed.

## The primitive/chrome split, and why it is lopsided

The PRIMITIVE renders every key element and owns every invariant a layout must
not be able to break: `data-pitch` on each key (the hit target
`usePlayableKeyboard` reads, so glissando and multi-touch work on every layout),
the tier paint order, the box, the lit lookup, the label host, the frame and the
pointer handlers. A CHROME (`web/internal/chrome/`) only answers what colour a
key is.

That is why there is no "render a key" hook and never should be: a chrome that
could mint its own element could drop `data-pitch`, and hit-testing would
silently stop working on that layout alone.

Three things the types make true:

- **A chrome cannot move or resize a key.** `KeyChromeStyle` is `CSSProperties`
  with `position`/`inset`/`top`…/`width`/`height`/`translate` omitted. The piano
  black key's hardcoded `height: 62%` — the second copy of a number the pad
  already carries — is now a `tsc` error rather than a rule to remember.
- **`tier` never reaches a chrome.** It is paint order, not a fact about a key.
  A chrome that wants to know whether a key is black asks
  `isAccidental(key.pitch)`, which is true on every layout — a Jankó row mixes
  naturals and accidentals, so row parity would have coloured them wrong.
- **`decor()` is required.** A layout with nothing between its pads returns the
  frozen `NO_DECOR`, so "no decor" is a stated answer rather than a missing
  method. A decor names a TIER, not an index, so it paints even when that tier is
  empty — the felt belongs under the accidentals in a chip window that holds
  none.

`KEY_CHROME` is a `Record<PitchLayoutId, KeyChrome>`: a layout id without a
chrome is a type error. Closed set, plain data, no slot.

## The drawn skin

`sketch-paths.ts` is the pure half: a seeded RNG, a wobbling key outline, a loose
rule. **Seeded purely from the pitch**, so a key's squiggle is stable across every
re-render and note-on with no cached-shape state anywhere — that is what stops the
keyboard shimmering during playback, and it is what `sketch-paths.test.ts` pins.

`sketch-skin.tsx` is the React half, mounted by the piano chrome's `decor()` (one
SVG pass per tier, immediately beneath that tier's own divs). Three rules it must
keep:

- **Measure, don't stretch.** The viewBox is built in real measured pixels
  (`useElementSize`). A 0..1 viewBox with `preserveAspectRatio="none"` would scale
  the wobble and the stroke widths by each key's aspect ratio.
- **Scale the pen to the key.** The same primitive renders at the 88-key roll and
  at a readout chip; `sketchMetrics(height)` derives the wobble and the stroke
  weights, or the chips read as noise rather than as drawing.
- **Lighting a key rewrites `fill`, never `d`.** Path strings are memoized on the
  geometry alone and the lit tint is a permanently-mounted overlay path, so a
  note-on costs one style write per key.

Depth comes from **shade, not bevels**: a graphite wash down the ivory's front, a
blurred cast shadow where each ebony meets the white beside it, a sheen down the
black, and the outline drawn twice slightly off — SVG has no per-length stroke
width, so that overdraw IS the pen pressure.

Jankó mounts no SVG pass. A hand-drawn pad has nothing a wobbling outline would
add that the ink ring does not already say, so the drawn look speaks there through
the fills and the ring instead — `skin.ivory` / `skin.ebony` / `skin.ink`, so the
pads sit on the paper lane rather than floating over it as an unrelated dark grid.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Stateless keyboard renderer: draws any PitchPlane's pads, lights given pitches (accent or per-key color) with optional per-key content, and picks its chrome from the plane's own layout. Composed by the full PianoKeyboard and the chord/key readouts.
- Web:
  - Uses:
    - `config_v2.useConfig`
    - `primitives/css/clip.Clip`
    - `primitives/css/coords.pct`
    - `primitives/css/coords.Placed`
    - `primitives/css/layer.Layer`
    - `primitives/css/pin.Pin`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/latest-ref.useEventCallback`
  - Exports (types):
    - `KeyboardProps`
    - `KeyboardSizing`
    - `KeyHighlight`
    - `KeyRenderState`
    - `LabelTone`
  - Exports (values):
    - `Keyboard`
    - `useSonataKeySkin`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/chord/piano`
    - `apps/sonata/piano-keyboard`
    - `apps/sonata/rich/readout-keyboard`

<!-- AUTOGENERATED:END -->
