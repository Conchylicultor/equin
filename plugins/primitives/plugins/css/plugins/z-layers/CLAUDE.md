# z-layers

The z-layer standard: one ordered, named ladder for every stacking decision,
plus the lint rule that keeps it the single source of truth.

## The scale

z-index is **structural**, not runtime-themeable, so the layers live in the
static `@theme { }` block as `--z-{base,raised,nav,float,overlay,popover,max}`
vars, exposed as the matching `z-*` `@utility` classes (both defined in
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`).

| Utility      | Value | Role                                                   |
| ------------ | ----- | ------------------------------------------------------ |
| `z-base`     | 0     | default flow                                           |
| `z-raised`   | 10    | sticky headers, hover chrome, drag handles             |
| `z-nav`      | 20    | persistent app chrome: sidebar, app-rail, pane header  |
| `z-float`    | 30    | in-pane floating widgets: selection bar, message TOC   |
| `z-drag`     | 35    | the item a drag carries, while carried (below)         |
| `z-overlay`  | 40    | full-pane bespoke overlays                             |
| `z-popover`  | 50    | portaled floating layers: floating-action, lightboxes  |
| *(stack)*    | 51…   | app-wide surfaces declared by their own plugins — see below |
| `z-max`      | 9999  | the unconditional top — see below                      |

### The top-layer stack (51…)

An app-wide surface that must paint above the popovers (hint tips, the Ask
card, the draw overlay, toasts, a prototype presentation, the element picker)
does **not** get a named layer here — that
would make this primitive name its contributors. It declares its own layer in
its own plugin (`ZStack.Layer`, [`plugins/stack`](plugins/stack/CLAUDE.md)),
and the order of all of them is one committed reorder layout that a new layer
cannot be pushed without placing. Values sit between `z-popover` and `z-max`.
A stack layer is drawn **only** through `ViewportOverlay` (`layer={…}`), the
sole reader of its z-index, which also wraps it in a `PortalHost` — so a popup
opened from a stack surface paints above it, never on `z-popover` beneath.

### `z-drag`: what a drag carries paints over every in-pane band

A dragged row (or a dragged section block) must paint over everything it
crosses — sticky group headers (`raised`), the pinned toolbar (`nav`), an
in-pane float such as a drop card (`float`) — for the whole drag. It takes
`z-drag`, and nothing between it and the list may seal it: z-index only
orders siblings inside one context, so a row at `z-drag` inside a box that
seals its rows (`isolate`, a transformed virtual-row wrapper) still paints at
that box's level. A box that must be a context (a transformed wrapper) lifts
itself while it holds the dragged item (`rank-reorder`'s sortable styles,
`VirtualRows`' `raisedKey`); a box that seals only by choice stops sealing
instead (`GroupedSections`' `draggedSection` drops the body's `isolate`) —
lifting it would raise all of its other rows too. Below `overlay`: a
full-pane overlay still covers a drag in progress.

### Why two systems, and what `z-max` is for

The ladder and the stack answer different questions. The in-tree tier orders
siblings inside a local stacking context — static classes, read synchronously
everywhere. `z-popover` is not an absolute rank but "a popup opened from the
page": a popup opened from a stack surface lands in that surface's host
instead. The stack is the one ordered, reviewable list of app-wide surfaces —
a read that is `loading` until its config is known.

`z-max` is what cannot be on the stack: the boot-error banner
(`web-core`'s plugin-load errors, drawn before any config exists) and the
desktop's tab-drag ghost (in-tree, above its windows' unbounded runtime z).
It is not offered to `ViewportOverlay`: an app-wide overlay goes on the stack.

z-index only orders siblings *within one stacking context*, so the durable fix
for "floating panel paints under its sibling" is to **portal** the floating layer
out of ancestor stacking contexts; this scale orders the handful of elements that
legitimately stay in-flow plus the portaled layers relative to each other.

## Enforcement

`lint/no-adhoc-zindex.ts` fails `./equin check` on any `className` carrying
a raw Tailwind z-index utility — built-in numerics (`z-0`…`z-50`) or arbitrary
values (`z-[60]`, `z-[9999]`). The named `z-*` utilities above are allowed.

Don't reach for a raw z number — pick the semantic layer that matches the
element's role so the whole app's stacking order stays legible and movable.

The rule enforces with **zero exemptions** — no plugin declares an exemption. When several sticky/floating peers must order *within one scroll
container*, give that container `isolate` (so the inner z-values form a sealed
stacking context), then assign each peer a named layer — or drop the z entirely
on any element that only needs to sit above *static* content, since a positioned
element already paints above static siblings regardless of z.

## Web barrel

`web/` is the TS face of the ladder — the single source of the layer name→class
map. Positioning primitives (`overlay`, `sticky`, `pin`, `viewport-overlay`) turn
a `layer` prop into a class through it instead of each copying the map:

- **`zLayerClass(layer)`** — resolves a named layer to its `z-*` utility class.
  The only read site of the name→class record (which stays private).
- **`InTreeLayer`** — `base | raised | nav | float | drag | overlay` (0–40): elements
  that stay in document flow. Used by `overlay` / `sticky` / `pin`.
The in-tree tier and the generic portaled layers (`popover | max`, internal)
exactly partition the full `ZLayer` union (enforced by a
compile-time partition guard), so a layer added to the map can't silently belong
to neither tier.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Semantic z-layer scale (z-base..z-max) and its enforcing lint rule (no-adhoc-zindex).
- Cross-plugin:
  - Imported by:
    - `primitives/css/coords`
    - `primitives/css/layer`
    - `primitives/css/overlay`
    - `primitives/css/pin`
    - `primitives/css/sticky`
    - `primitives/css/viewport-overlay`
    - `primitives/overlay/surface-overlay`
- Web:
  - Exports (types):
    - `InTreeLayer`
    - `ZLayer`
  - Exports (values): `zLayerClass`
- Sub-plugins:
  - **`stack`** — The top-layer stack: app-wide surfaces declare their own z-layer (ZStack.Layer) in their own plugin, ordered by one committed reorder layout; a layer is drawn only through ViewportOverlay…

<!-- AUTOGENERATED:END -->
