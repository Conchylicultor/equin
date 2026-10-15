# rail

The chrome half of the outline primitive — Notion's right-edge minimap.

```tsx
<OutlineRail
  entries={entries}                                  // {id, label, depth}[]
  resolve={(id) => root.querySelector(`[data-block-id="${CSS.escape(id)}"]`)}
/>
```

The host owns only **what the entries are** and **how an id maps to a DOM node**.
Which entry is current, the disclosure, the overflow window and the scroll-to
belong to the rail. Renders `null` below two entries — a one-section outline is
noise.

## `resolve` must not reach outside its own surface

Not obvious from the signature, and it bites silently: the rail derives its
**IntersectionObserver root** from the scroll parent of the first element
`resolve` returns. So a `resolve` that can match another instance's DOM — two
panes open on the same document, ids that aren't globally unique — doesn't just
scroll the wrong pane on click. It watches the wrong scroller, and the
current-position highlight quietly tracks a surface the reader isn't looking at.

If your ids are unique per document but not per mounted instance, scope the query
to your own surface's container — ask your host for that element; don't climb the
DOM from a node planted for the purpose. The worked example is jsonl-viewer's
`usePaneScrollElement()`: the pane already held its scroll element and now
publishes it, so every overlay contributor gets the scoping, not just the outline.

## The host must provide the positioning context

The rail is a `<Pin to="top-right">`, so it anchors to its nearest `relative`
ancestor. Mount it inside one that spans the scrolling surface — an overlay slot
whose host is `relative`, not a box inside the scroller (the rail must not scroll
with the content).

It hangs from the **top** corner, not the vertical middle: the rail is the
document's index, so it starts where the document starts and grows down with it.
Centered, a five-entry outline floats in the middle of an empty margin with
nothing to relate to. The consequence for the host is that its top edge is the
rail's top edge — mount the rail below your pane header, not across it.

That same ancestor is what the rail **measures** (`el.offsetParent`) to decide how
many dashes fit. Measuring itself would be circular: its height *is* the dash
count.

## The panel replaces the dashes

Open, the dash stack clips to zero height — Notion's behaviour, and the reason
the outline's first row sits at the panel's top edge rather than under a dead
band. It is **clipped, never unmounted**: the dashes carry the position contract
below (read while the panel is open). Clipping them does not shrink
`FloatingAction`'s hover hitbox — it follows the trigger's size only while the
panel is closed, so it holds still under the pointer while the panel morphs.

## The `footer` slot is a full-width, centered row

The rail owns that slot's layout, not the consumer. A footer that takes the
whole width (`w-full`) fills the row; anything narrower is centered in it. Do
not fix a small footer hit target in the consumer.

## Overflow: the rail windows, the panel does not

A 200-turn conversation cannot show 200 dashes. The rail paints at most
`floor(height / 8px)` of them, windowed around the active entry, and fades the
leading / trailing dash when something is genuinely hidden past it. The expanded
panel always lists **every** entry and scrolls.

Truncating the tail instead would put the active dash off the end of the rail —
the indicator would lie exactly when the document is long enough to need it.

## Why 8px is a raw number

`DASH_STEP_PX` (and its single mirror, `h-2` in `dash-stack.tsx`) is a fixed-height
box with the bar centered in it — deliberately not a bar plus a ramp gap.
Converting an available height into a dash count needs a step in pixels, and a
density-token gap would make that a guess that drifts with the active preset.

## Accessibility: the dashes are not the outline

The dash stack is `aria-hidden` with `tabIndex={-1}` buttons — a pointer
affordance and an indicator. The panel rows are the accessible outline
(`<button>` + `aria-current`), because exposing both would read every section
twice and cost a Tab stop each. The rail as a whole is still Tab-reachable:
`FloatingAction`'s wrapper takes focus and opens the panel.

## DOM contract (public — e2e scripts depend on it)

These attributes are **API**, not incidental markup. Restyle freely; do not rename
or drop them. Ids are the consumer's own strings, raw — callers `CSS.escape` at
query time.

| Attribute | Where |
| --- | --- |
| `data-outline-rail` | the `<nav>` root (one per rail; scope every query through it) |
| `data-outline-dash` + `data-outline-id` + `data-active="true\|false"` | every dash |
| `data-outline-row` + `data-outline-id` | every panel row `<button>`; the active one also carries `aria-current="true"` |

The dashes stay mounted while the panel is open (clipped to zero height), so
`[data-outline-dash][data-active="true"]` is readable in either state.

`aria-label` (the `label` prop, default `"Outline"`) lands on the same `<nav>`, so
`[data-outline-rail][aria-label="…"]` scopes to one instance when two surfaces are
on screen.

The panel opens on hover or focus of anything inside the rail: hover
`[data-outline-rail]`, or `.focus()` a dash (`tabIndex={-1}` still takes
programmatic focus, and the disclosure listens on `focusin`).

Panel rows and the `footer` are **always mounted** — `FloatingAction` marks the
closed panel `inert` and fades it out rather than unmounting it.

## Known edges

- The rail waits for the first host measurement before mounting
  `FloatingAction`, so it never mounts as an empty stack. A later pane
  **resize** changes the dash count, and `FloatingAction` re-sizes its hover
  hitbox to the new stack (it tracks its trigger's size while closed).
- The open panel is `max-h-80` growing down from the stack's top. In a pane
  shorter than ~350px it can reach past the bottom edge and be clipped.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Notion-style outline rail: a dash per section pinned to the surface's right edge, the current one bright and wide (position from outline/scroll-spy), expanding on hover / focus / tap into the depth-indented outline with click-to-jump. Windows its dashes to the height it has while the panel always lists every entry, so a long document's indicator can never lie.
- Web:
  - Uses:
    - `primitives/css/clip.Clip`
    - `primitives/css/column.Column`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/row.Row`
    - `primitives/css/spacing.insetClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useElementSize`
    - `primitives/dom/scroll-reveal.revealElement`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/outline/scroll-spy.useActiveInView`
    - `primitives/overlay/floating-action.FloatingAction`
    - `primitives/overlay/floating-action.FloatingActionFadeIn`
  - Exports (types):
    - `OutlineEntry`
    - `OutlineRailProps`
  - Exports (values): `OutlineRail`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --pad-row-x`
    - `ui/tokens/density --pad-row-y`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/pages/page-outline`
    - `conversations/conversation-view/jsonl-viewer/outline`
    - `primitives/metrics`
- Core:
  - Exports (types): `OutlineEntry`

<!-- AUTOGENERATED:END -->
