# collapsible

## `Collapsible` vs `CollapsibleProvider`

`Collapsible` is the provider **plus** a wrapper `<div data-slot="collapsible">`
— the box that gives the group an element to style, a `data-state` hook, and (for
a plain `<Sticky>` header inside it) its own sticky containing block. It is the
default; reach for it unless the wrapper is actively in the way.

`CollapsibleProvider` is the same state with **no DOM at all**, so the trigger and
the content land as **siblings in the parent's own layout**. Use it when a box of
the collapsible's making would break that layout:

- **a subgrid row** — a wrapper would displace the `col-span-full` children out of
  the grid, so the columns stop aligning;
- **a sticky stack** (`css/sticky/stack`) — a wrapper becomes each header's sticky
  containing block, so the header un-pins as soon as its own section scrolls away,
  which is precisely what the stack must not do. The DataView list view uses it
  for this reason: all its group headers must share the list as one containing
  block to stack.

Both take the same `UseCollapsibleOptions` (`open` / `defaultOpen` /
`onOpenChange`); only `Collapsible` takes `className`, since only it has an
element to put it on. `CollapsibleTrigger` / `CollapsibleContent` /
`CollapsibleChevron` read the context and work identically under either.

## The content is never `{open && …}`

A disclosure's content folds with motion — through `CollapsibleContent`, or
`FoldMotion`. A bare `{open && <Body/>}` mounts and unmounts it in one frame,
and nothing says so; the lint rule `collapsible/no-unanimated-disclosure`
rejects it. Its sources of a disclosure boolean: `open` from `useCollapsible` /
`useCollapsibleContext`, `expanded.has(…)` from `useExpandAll`, and whatever an
`aria-expanded` (without `aria-haspopup` — a popup is not a fold) or a
`<CollapsibleChevron open>` reports. A conditional INSIDE the trigger (a chevron
or label swap) is the trigger's own chrome and passes. It also rejects a native
`<details>`. Not seen: an early `if (!open) return`, and a toggle that reports
its state nowhere — give it `useCollapsible`'s trigger props. A summary/full
swap is two folds (`<FoldMotion {...contentProps}>` + `<FoldMotion open={!open}>`,
the mail message card); a one-way inline "+N more" in a wrapping chip row is not
a disclosure and stays a plain slice.

## `useCollapsible` hands out a trigger bag and a content bag

`useCollapsible()` is for building your **own** trigger and content.
`contentProps` (`open`, `id`, `role="region"`) goes on a `<FoldMotion>`, so the
content folds and the trigger's `aria-controls` points at it:

```tsx
const { open, triggerProps, contentProps } = useCollapsible();
<button {...triggerProps}>…<CollapsibleChevron open={open} /></button>
<FoldMotion {...contentProps}><div className="pt-2">{body}</div></FoldMotion>
```

`open` is for the trigger's chrome. Which trigger bag you spread depends on one
question: **do you own the element?**

- **`triggerProps`** — you render a raw `<button>` (or `as="button"`). It adds
  `type="button"`, without which the trigger submits any surrounding form.
- **`triggerControlProps`** — the host owns its element (`Row`, `Button`). Same
  `aria-expanded` / `aria-controls` / `onClick`, no `type`: `Row` infers its
  element from its props and stamps `type` itself, so handing it one is a type
  error.

`triggerProps` is built by spreading `triggerControlProps`, so the two can never
disagree about what the trigger does. Before the split, the only bag carried
`type` and a host that owned its element had to hand-pick the three fields it
could accept — which is how `sidebar-pane-section` used to read them one by one.

## `CollapsibleContent` folds with motion

A flip of `open` after mount tweens the content's height and opacity (200 ms
for a short fold, the chevron's quarter turn on the same clock — `foldTiming`
from this plugin's `core`, the one fold timing flat-list folds
(`virtual-rows/row-fold`) read too). A long fold runs a little longer (capped
at 300 ms) and an opening starts gentler than a close, so a screenful of
rows arriving moves at a readable speed per frame instead of jumping ~150 px a
frame; a close keeps the content mounted
(and `inert`) until its fold-away has run, then unmounts it as before. Content
that starts open just appears — a page of open sections never unfolds on load.
A flip mid-tween reverses from the in-flight frame. Under
`prefers-reduced-motion` the tween has no duration.

The tween runs on a wrapper the primitive owns (`data-slot="collapsible-content"`,
which carries the `id` / `role` / `data-state`); the caller's `className` and
props go on the box inside it. So padding, a border or a rule tweens down with
the rest instead of the fold stopping at the padding and then jumping, and the
wrapper clips only while it moves — a sticky header or a spilling popover inside
settled-open content is never cut. Every collapsible therefore animates; there is
no per-site opt-in to forget.

`FoldMotion` is that tween on its own — `open` plus children, no collapsible
context, no `region` role — for a fold whose open state lives elsewhere: the
`tree` primitive folds a node's children with it, a `useExpandAll` list each
row's diff. `CollapsibleContent` is `FoldMotion` plus the context's state, id
and role. Its props land on the moving box, so padding, borders and vertical
margins go on a box INSIDE it; a sideways bleed (a negative inline margin) may
sit on it.

The tween caps `max-height` and its far end is the box's own size measured with
the cap released, never `scrollHeight` — the same motion for a block, and the
only one that folds a box its parent sizes: the sidebar section is a `flex-1`
cell of its column, and as it folds its siblings take the room back.

An unfold survives a slow mount. Mounting a long list can hold the main thread
for hundreds of milliseconds, and the browser dates an animation from a frame
stamp taken before that work — so a tween started in the commit had already
elapsed by first paint and the content snapped open. The commit therefore only
pins the box at its first frame; the tween starts on the next animation frame,
measures the natural height there, and sets its `startTime` to
`performance.now()`. That clock is `startFold` (web), shared with
`virtual-rows/row-fold`, so every fold starts the same way.

An unfold does not wait for its mount when the pointer rested on the trigger
first (or focus is on it). The trigger bags (`triggerProps` /
`triggerControlProps`, `CollapsibleTrigger`, `SectionHeaderRow`) carry
`warmHandlers`: 100 ms of the pointer resting on the trigger (the hover intent
of `overlay/hover-popover`'s `createHoverIntent`), or focus, sets `warm`, and
`FoldMotion` (`warm`, carried by `contentProps` and `CollapsibleContent`)
mounts the content under `display: none` while closed — so the click only lays
it out. A pointer sweeping past a list of headers warms none of them, and
leaving (or blur) lets it go: a closed section's content is mounted only while
its trigger is under the pointer or focused, never left live in the
background.

The clock costs no frame — its callback runs before the very next paint — so a
fold that starts late is waiting on the commit's own work. Measure before
blaming the motion: `e2e/fold-latency.ts` (`--path /agents/c/<conv> --trigger
Expand`) clicks first opens and prints, per click, the handler time, click →
first motion, and the long tasks between; a Chrome trace of the same click
splits those into script / style / layout. The ~0.3 s first-open lag on
transcript cards was a full restyle of the pane (every element, ~37k), caused
by an unanchored `:has()` in `css/scroll` — not the fold, nor the mount (see
the scroll plugin's CLAUDE.md and the `css:no-unanchored-has` check).
`e2e/fold-motion.ts` samples the height per frame around a fold and an unfold
(`--path /agents --header Queue`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Accessible collapsible primitive with controlled/uncontrolled support and a built-in chevron indicator. Compound components for standard layouts; useCollapsible hook for custom triggers.
- Web:
  - Uses:
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.SingleLineProvider`
    - `ui/icons.Icon`
  - Exports (types):
    - `CollapsibleChevronProps`
    - `CollapsibleContentBindProps`
    - `CollapsibleContentProps`
    - `CollapsibleCtx`
    - `CollapsibleProps`
    - `CollapsibleProviderProps`
    - `CollapsibleTriggerControlProps`
    - `CollapsibleTriggerProps`
    - `CollapsibleWarmHandlers`
    - `ExpandAllButtonProps`
    - `FoldMotionProps`
    - `UseCollapsibleOptions`
    - `UseCollapsibleReturn`
    - `UseExpandAllReturn`
  - Exports (values):
    - `Collapsible`
    - `CollapsibleChevron`
    - `CollapsibleContent`
    - `CollapsibleProvider`
    - `CollapsibleTrigger`
    - `ExpandAllButton`
    - `FoldMotion`
    - `prefersReducedMotion`
    - `startFold`
    - `useCollapsible`
    - `useCollapsibleContext`
    - `useExpandAll`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --accent`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
  - Imported by: 51 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×11
    - `ui` ×10
    - `apps` ×9
    - `primitives` ×8
    - `plugin-meta` ×4
    - `review` ×3
    - `auth`
    - `build/build-logs`
    - `code-explorer/commit-detail`
    - `debug/read-set`
    - `reorder/node-types/header`
    - `shell/health-report`
- Core:
  - Exports (types): `FoldTiming`
  - Exports (values):
    - `FOLD_MS`
    - `foldTiming`

<!-- AUTOGENERATED:END -->
