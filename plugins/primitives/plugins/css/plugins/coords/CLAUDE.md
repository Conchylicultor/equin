# coords

The **coordinate-space** primitive — a box placed by runtime numbers inside a
positioned host. Gantt bars, piano-roll notes, windowed-row offsets, drag ghosts,
crop rectangles, `DOMRect` highlights, editor decorations: ~46 call sites that
each wrote `absolute` plus a hand-built inline style, under a per-site
`eslint-disable`.

## Against `<Pin>`: where the number comes from

`<Pin>`'s docs used to send these sites to a disable, on the grounds that
"JS/pixel coordinates are not this primitive's job". That was right about Pin and
wrong about the corpus — the shape has a name, and this is it.

The split is **where the number comes from**, not how big it is:

- **Pin places by a semantic ramp step** (`to="top-right" offset="sm"`). An author
  chose it, and a density preset may rescale it.
- **Placed places by a measurement** — a fraction of a track, a `DOMRect`, a
  virtualizer's offset, a note's pitch. No ramp can express it and no preset may
  rescale it: a playhead at 37.4% is at 37.4%.

Against `<Layer>` it is simpler still: a Layer is `inset-0` on both axes and
carries no coordinate at all. **If your box has no number in it, you want
`<Layer>`.**

## The host

A placed box needs a **positioning context** — the ancestor its offsets resolve
against. This plugin ships no primitive for it, deliberately: every host in the
corpus is already something with a name.

| the host you have | what to write |
|---|---|
| exactly `absolute inset-0` over a surface | `<Layer>` |
| an in-flow track that clips what overflows it | `<Clip>` (+ `growClass()` if it must take the row's slack) |
| a plain sizer that only needs to be the context | nothing — `relative` was never banned, so `<div className="relative h-8">` is fine |

A fourth spelling (`<Plane>`, in an earlier sketch of this plugin) was cut for
that reason: it would have forced every author to answer "Layer or Plane?", a
question with no observable consequence.

What matters is only that **some** ancestor is positioned. Losing it is the
signature fault of this whole family and it is completely silent — no error, no
overflow, no class on the child changes; the offsets simply re-resolve against
whatever positioned box is further up and every child drifts together. That is
what the harness's `unpositionHost` falsification reproduces.

## Both axes are required

`<Placed x y>` takes both, always. Omitting one is not "leave that axis alone" —
an absolutely-positioned box with nothing said about an axis keeps its CSS
**static position**, landing wherever it would have been in flow. That is the one
genuinely surprising outcome in this corner of CSS, and it is why the corpus is
full of `absolute top-0` boxes whose author meant "the top" and got it by
accident on one axis and by luck on the other.

Saying `x="fill"` costs one word and removes the question.

## The extent vocabulary

```ts
type Coord = number | string;   // px, or any CSS length/percentage

type Extent =
  | "fill"                                              // both edges pinned
  | { start, size?, minSize?, shift? }                  // near edge
  | { end,   size?, minSize?, shift? }                  // far edge
  | { start, end, shift? }                              // both edges
  | { center, size?, minSize? };                        // centered on a coordinate
```

- Bare numbers are **px** (every site that hands this a number measured one);
  strings pass through, so `pct()`, `rem`, and `calc()` all work.
- The `?: never` keys on each arm make an **over-specified extent a `tsc`
  error**. `{ start, end, size }` and `{ center, start }` are real mistakes with
  silent outcomes — CSS resolves them by dropping whichever property loses, and
  the box lands somewhere plausible.
- **`minSize` is a floor, not a clamp.** It emits `min-width`/`min-height`
  alongside the true `size`, so CSS resolves `max(size, minSize)` and the real
  extent stays declared. This replaced a `Math.max` in the Gantt that overwrote
  the width it was flooring.
- **`layer` defaults to no z class at all**, unlike `<Pin>`'s `raised`. Every
  bar, marker and overlay here paints by DOM order, and even `z-index: 0` opens a
  stacking context none of them asked for.
- **`pct(fraction)`** is the `` `${f * 100}%` `` 14 sites hand-rolled. Unclamped
  and unrounded: culling an off-track tick is the caller's decision, and rounding
  would move pixels that are correct today.

## `shift` is per axis, and `center` is sugar for it

`shift` moves the box by a distance **relative to its own size** — `"-50%"`
centers it on its anchor, `240` composites it down by 240px. `{ center: c }` is
exactly `{ start: c, shift: "-50%" }`: one mechanic with two names, so a site can
pick the name that reads.

It is per axis rather than a whole-component mode because real sites mix them. A
windowed row is `left`/`right` inset with only its **`y`** composited; a loop
region needs an inset base **and** a shift on top. A single mode could express
neither.

## It writes `translate`, never `transform`

This is load-bearing, not a style choice. Several consumers (the Sonata progress
bar, the piano roll, the notation cursor) drive `el.style.transform` from a ref
**every frame**. CSS applies `translate` before `transform`, so the two compose:
this primitive owns the placement, the writer owns the motion, and there is no
combination to avoid and no rule to remember.

Tailwind v4 compiles `-translate-x-1/2` to the `translate` property too (verified
in the built stylesheet), which is why `<Pin to="center">` is already safe beside
such a writer.

## The class helpers are the other half

`placedStyle(x, y)` and `placedClasses(opts)` are the same resolvers the
component uses. **Reach for them whenever you do not own the element:**

- a raw `<canvas>` / `<svg>` / `<img>` leaf that must ITSELF be placed;
- an element carrying `setPointerCapture`, dnd-kit listeners, or pointer handlers
  that read a `data-*` off the topmost element under the cursor — **a wrapper
  would become that element and change behaviour, not just markup**;
- a third-party component exposing only `className` / `style`.

Own the element ⇒ `<Placed>`; don't ⇒ the helpers. A raw `<div className="absolute" style={{left: …}}>`
under an `eslint-disable` is not a third answer.

## Defaults live in `placedClasses()`, not in `<Placed>`

`<Placed>` forwards `layer` / `decorative` straight through — the `layer`
precedent, and a deliberate divergence from `pinClasses`/`<Pin>`, where every
default is stated twice and can therefore drift.

## Still out of scope

- **`position: fixed`.** Stays with `viewport-overlay` / `cursor-menu`; a `fixed`
  mode would re-open the transformed-ancestor bug those exist to prevent. (An
  `absolute` box *inside* a `ViewportOverlay` is in scope — that is still a box
  in a positioned host.)
- **Grid-mechanic overlays.** A `gridRow` span is not a coordinate; the subgrid
  data-table and the page editor's line-spanning bands are their own follow-up.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Coordinate-space positioning primitive: <Placed x y> / placedStyle() places a box by runtime numbers on both axes, plus pct() for fractional coordinates.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/z-layers.InTreeLayer`
    - `primitives/css/z-layers.zLayerClass`
  - Exports (types):
    - `Coord`
    - `Extent`
    - `PlacedOptions`
    - `PlacedProps`
  - Exports (values):
    - `pct`
    - `Placed`
    - `placedClasses`
    - `placedStyle`
- Cross-plugin:
  - Imported by: 38 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×18
    - `primitives` ×9
    - `debug` ×3
    - `page` ×2
    - `screenshot` ×2
    - `active-data/go`
    - `hints`
    - `map`
    - `shell/notifications`

<!-- AUTOGENERATED:END -->
