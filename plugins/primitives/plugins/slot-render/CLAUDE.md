# slot-render

## `defineRenderSlot` vs `defineMountSlot`

Two constructors for "render all contributions, each error-boundary-isolated",
distinguished by whether the contributions are *visible*:

- **`defineRenderSlot(id, config?)`** — a **visible** slot. `.Render` paints
  every contribution (item middlewares + the list/reorder middleware). Always
  **reorderable** — there is no opt-out. Every render slot appears in the
  reorder manifest and gets an authored config override.

- **`defineMountSlot<P>(id, config?)`** — a **headless** slot. Its `.Mount`
  component (prop-less) mounts every contribution wrapped only in the item
  middlewares (error-boundary isolation) — no list/reorder middleware, no flex
  sentinel, no `controlSize`. The contribution `component` is typed
  `(props) => null`, a **compile-time** guarantee that a mount contribution
  renders nothing: a component that returns JSX (or `ReactElement | null`) fails
  to type-check. Mount slots are **never reorderable** and are absent from the
  reorder manifest. Use them for side-effect-only contributions (observers,
  recorders) that need per-contribution crash isolation but paint no UI.

Reorderability is now a property of the **constructor**, not a boolean flag.
There is no `reorder?: boolean` option — pick the constructor whose reorder
semantics you want:

- **`defineRenderSlot`** — visible, renders every contribution → **reorderable**
  (always in the manifest, owes an authored config).
- **`defineMountSlot`** — headless, side-effect-only → **never reorderable**
  (absent from the manifest).
- **`defineDispatchSlot`** — visible, single-match selection → **not
  reorderable** (contributions carry no `id`, so nothing to order).
- **`defineOrderedDispatchSlot`** — dispatch selection **plus** reorder
  participation → **reorderable**. Same runtime as `defineDispatchSlot` (one
  match via `.Dispatch`), but contributions require `id: string` so the slot
  can be ordered — it declares `meta.reorderable` like a render slot, and owes
  an authored config override. Consumers that need the config order (grouped
  menus, ordered pickers) read that order through the reorder read hook — the
  slot itself renders pure dispatch.

## Density: declared by the slot, picked by the host

`defineRenderSlot({ controlSize })` makes a slot size-owning: `.Render` wraps
its whole contribution list in one `ControlSizeProvider`, so every contributed
control shares one height. That value is the slot's **default**. A host that
draws the same slot at another density passes `<Slot.Render controlSize="md"/>`,
which overrides it for the **whole** slot — never per item, so the one-height
guarantee holds. A contribution's explicit `size` still wins (escape hatch).

## Single-line discipline for horizontal slots

`.Render` detects whether its host is a **flex row** at runtime (via a
`display:none` sentinel — same technique as the reorder list middleware) and,
for row slots, wraps every contribution in a `min-w-0` flex cell. Detection
gates on the host actually being a flex container (`display:flex`/`inline-flex`)
*before* reading `flex-direction` — `flex-direction` computes to `row` for every
element (it's the CSS initial value), so a plain block or grid host would
otherwise be misread as a row and collapse wide block content to min-content
width. Non-flex hosts fall through to the untouched vertical path. This keeps
the flex shrink-chain unbroken above each contribution, so flexible text can
truncate instead of wrapping when a chrome row is compressed. Contributors
declare nothing; vertical lists are untouched.

What this does and does NOT do:

- **Cell provides `min-w-0`** at the boundary — the chain link contributors
  couldn't fix themselves and silently broke truncation.
- **Fixed-size controls** are unaffected: the `Button` primitive is already
  `shrink-0`. Anything that must not shrink should be `shrink-0` (opt-out). A
  forgotten `shrink-0` fails *loudly* (visible squish at any width).
- **Leaf text still needs truncation.** CSS can't truncate arbitrarily-nested
  text from an ancestor — render the flexible label as a `<Text>` (from
  `@plugins/primitives/plugins/css/plugins/text/web`) inside a line container
  (`Frame`/`Row`/`Bar`), which provides the ambient `SingleLine` context so the
  `<Text>` ellipsizes. The cell only makes that truncation *work*.
- The few chrome containers (`app-shell` header, `pane-chrome` title row) add
  `overflow-hidden` as a fixed-height safety net so a forgotten leaf truncation
  clips to one line instead of breaking the layout.

### The cell grows because it was asked, not because it was told

A row cell is **rigid** by default (`flex: 0 1 auto`): right for the buttons and
chips a chrome row is made of, wrong for a contribution meant to expand into the
row's free space. A rigid cell shrink-wraps to its content, so anything inside
that sizes itself from the room it is given — an `AdaptiveBar`, a truncating
strip — reads its own content back as "the room I have", a measurement that moves
with the answer it produces.

The cell is a [`GrowRelay`](../css/plugins/grow-relay/CLAUDE.md): the widget that
needs the slack asks for it from where it is rendered, and the cell grows because
it was asked. The ask travels on, so a wrapper a host adds *inside* the cell
relays too (`prompt-editor`'s toolbar does) instead of the chain breaking one
level down. Nothing about the widget's need is restated on the contribution —
which is what it used to be, several files away, and both consumers in the repo
got it wrong once each.

Only the **row** branch is a relay. The `display:contents` branch generates no
box, so it has nothing to grow — and the ask crosses it for free, because
context passes through any component that is not a relay.

`fill: true` remains on the contribution for the two things nobody can ask for:
a contribution that wants the slack with no such widget inside it, and reorder's
own reading of the flag for its edit-mode wrapper — where it means the **block**
axis (a bounded flex column so an inner scroll region clamps), a different
question from the inline grow the cell relays.

### Relocating hosts declare their layout

The measurement is the slot's *host*, so it is wrong for a host that moves
contributions somewhere else — the `overflow` reorder node type portals its
members into a dropdown panel, where a horizontal cell makes each menu row a
shrink-wrapping flex item. Such a host wraps the relocated children in
`<SlotItemLayout orientation="column">` (or `"row"`), which the cell honors over
what was measured. Read at render position, so it applies to contributions whose
elements were created upstream.

### `"host-owned"` — the host draws each item's box itself

The third value, and it is not an orientation: it answers *who* draws the box
rather than *which way* the items run.

Some hosts mint a box per item because placing the item **is** a DOM operation
on that box. [`adaptive-bar`](../adaptive-bar/CLAUDE.md) mints one stable
container per occupant and re-parents it to shrink or relocate the widget inside
without React ever unmounting it. There the container **is** the item's box, and
a slot cell around the contribution is not merely redundant — it is a second,
competing flex item that swallows the container, so the bar's gap, measurement
and docking all end up describing the cell instead of the row.

So the bar declares `<SlotItemLayout orientation="host-owned">` around its
children and the cell takes its `display: contents` branch — byte-for-byte what
`renderIsolated` produces, which is precisely the escape hatch such hosts used to
reach for instead of `.Render` (and with it they lost the reorder list
middleware: ordering, hiding and spacers all silently ignored).

Nothing about the value names `adaptive-bar`. Any host that owns its items'
boxes says the same thing.

## Middleware is contributed, not registered

What every slot renders through is three declared slots this plugin owns —
`SlotRender.ListMiddleware` (wraps a render slot's whole list),
`SlotRender.ItemMiddleware` (wraps each contribution, on every path) and
`SlotRender.ItemAttrs` (stamps the box, below) — read with hooks at render
time, lowest `priority` outermost. They replaced an imperative module registry
(`registerSlot*Middleware`), which no tool could see: `reorder` registered its
layout middleware there, nothing imported it, and served compositions shipped
without it — every slot in raw registration order.

All three accept **companions** (`companions: true`): a contribution every slot
needs says `companion: true` and ships wherever slot-render does (the error
boundary, reorder's middleware via `reorder/plugins/slot-middleware`). One that
only polishes or describes (the element picker's lineage marker, the pane title
guard) is an ordinary contribution and ships with its own plugin. Reading them
needs a `PluginProvider` — so does every slot.

## The contribution box, and stamping it

Every contribution rendered by any path gets at most ONE element the slot owns —
its **box** (`ContributionBox`). On `.Render` that box is the layout cell
described above; `.Mount` / `.Dispatch` draw no cell, so their box exists only if
something is stamped on it, and otherwise no element is emitted at all.

`SlotRender.ItemAttrs({ attrs: fn })` is how a plugin describes contributions: `fn` returns
**DOM attributes**, and slot-render puts them on the box. `fn` is handed
`{ slotId, contribution, boxless }` and must be pure — it runs once per
contribution per render.

Attributes rather than a wrapper component, deliberately. The element picker used
to describe contributions by wrapping them in a marker span, and a wrapper lands
wherever the plugin providing it happens to sit — theirs sat *inside* the layout
cell. The cell is normally a bit bigger than what the contribution paints in it,
so the slack around a small widget (most of what there is to point at when the
widget is a 4px progress bar in a 24px row) was described by nobody, and a click
there reported the enclosing pane instead of the widget. As data there is no
placement to get wrong — not for the picker, not for any future consumer.

`boxless` tells the consumer whether this box generates a box (`display:contents`
or a real cell), because walks that look for the nearest *authored* element have
to step through the layout-neutral ones. The slot knows; the consumer never
guesses.

Item middlewares are unchanged and unconditional — they always wrap the
contribution's content, inside the box, so an error boundary's fallback keeps the
cell's layout role. `applyItemMiddlewares` mints the box itself (it has to be
outermost), so `renderItem` returns a Fragment carrying the React key, which
every caller mapping it over a list relies on.

## Reading a dispatch's match: `useMatch()`

`slot.useMatch()` returns `(props) => Extra | undefined`: the `Extra` fields
(what a contribution declares beside its component —
`defineDispatchSlot<Props, Key, Extra>`) of the contribution `.Dispatch` would
render for those props, `undefined` for the fallback. Both run the ONE
precedence (`matchDispatchIndex`: exact string → RegExp → predicate), so a host
that needs a contribution's data without rendering it — the map reading every
pin type's `mark` — can never pick a different contribution than the one its
component is rendered from.

## Dispatch outcome

`.Dispatch` publishes what it did, so a descendant can react to *"nothing handled
this"* without every fallback component threading a prop by hand:

```ts
const outcome = useDispatchOutcome(); // { slotId, key, matched } | null
if (!outcome || outcome.matched) return null; // only render on a fallback
```

- **`matched`** is `true` when a contribution matched, `false` when the slot's
  `fallback` rendered (or nothing did). It is the whole point of the signal: the
  fact was already known inside `.Dispatch` (`matchedIndex < 0`) and published
  nowhere, so each fallback had to be wired up individually and every new one
  started out missing the affordance.
- **`key`** is `config.key(props)` for that render, **`slotId`** the slot's id.
- Outside any dispatch slot, `useDispatchOutcome()` returns `null`.

**Nearest wins, and that is the correct answer.** Dispatch slots nest: a
conversation tool row renders `EventRenderer.Dispatch` (matched → the tool-call
row) inside which `Tool.Renderer.Dispatch` may fall back to a generic view. The
context reports the *innermost* dispatch, which is the honest answer for the row
being rendered — a `Bash` card is handled, a `SendMessage` card is not. Consumers
should not try to reach an outer dispatch; if you need that, the surface you are
building belongs at that outer level.

**The value is three primitives, deliberately.** No `props`, no matched
`Contribution`. Either would change the context value's identity on every render
of the hottest paths in the app (the conversation transcript dispatches per event
row), re-rendering every consumer for churn that says nothing new. Consumers that
need the props already have them — they are rendered *by* the dispatch. For the
same reason the memo depends on the **boolean** `matched`, not `matchedIndex`:
reordering contributions must not churn the value.

The provider wraps **outside** the item middlewares, so the outcome stays
readable from inside an error-boundary fallback.

`DispatchOutcomeContext` itself is **not** exported — `.Dispatch` is the single
writer. A consumer able to provide it could lie about whether its subtree was
handled.

`renderIsolated()` publishes **nothing** (no provider, so `useDispatchOutcome()`
falls through to whatever dispatch encloses it, usually `null`). Slots that
select via `renderIsolated` — `data-view`'s `cell` / `cell-editor` — therefore
have no outcome signal; they would each need their own if one is ever wanted.

`defineOrderedDispatchSlot` *is* `defineDispatchSlot` at runtime, so it publishes
the outcome too, with no separate code path.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Typed rendering primitive for visual slots with auto-applied middleware (error boundaries, reorder).
- Load-bearing: yes
- Web:
  - Slots:
    - `SlotRender.ListMiddleware`
    - `SlotRender.ItemMiddleware`
    - `SlotRender.ItemAttrs`
  - Slot contributors:
    - `SlotRender.ListMiddleware` ← `reorder.slot-middleware`
    - `SlotRender.ItemMiddleware` ← `primitives.error-boundary`
    - `SlotRender.ItemMiddleware` ← `primitives.pane`
    - `SlotRender.ItemMiddleware` ← `primitives.ui-context.element-picker`
    - `SlotRender.ItemMiddleware` ← `reorder.slot-middleware`
    - `SlotRender.ItemAttrs` ← `primitives.ui-context.element-picker`
  - Uses:
    - `primitives/css/grow-relay.GrowRelay`
    - `primitives/css/ui-kit.ControlSize`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/dom/layout-host.flowAxis`
    - `primitives/dom/layout-host.layoutHost`
  - Exports (types):
    - `DispatchContribution`
    - `DispatchOutcome`
    - `DispatchSlot`
    - `DispatchSlotConfig`
    - `MountComponent`
    - `MountSlot`
    - `MountSlotConfig`
    - `OrderedDispatchContribution`
    - `OrderedDispatchSlot`
    - `RenderSlot`
    - `RenderSlotConfig`
    - `SlotItemAttrsFn`
    - `SlotItemBox`
    - `SlotItemMiddleware`
    - `SlotItemOrientation`
    - `SlotListMiddleware`
    - `WrapContribution`
    - `WrapperSlot`
    - `WrapperSlotConfig`
  - Exports (values):
    - `defineDispatchSlot`
    - `defineMountSlot`
    - `defineOrderedDispatchSlot`
    - `defineRenderSlot`
    - `defineWrapperSlot`
    - `renderIsolated`
    - `RenderSlotSubIdContext`
    - `SlotItemLayout`
    - `SlotRender`
    - `useDispatchOutcome`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --control-height-sm`
    - `ui/tokens/shape --spacing`
  - Imported by: 84 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×26
    - `conversations` ×14
    - `primitives` ×13
    - `ui` ×5
    - `shell` ×4
    - `tasks` ×4
    - `apps-core` ×3
    - `config_v2` ×2
    - `debug` ×2
    - `page` ×2
    - `improve`
    - `integrations/google-maps`
    - `map`
    - `network/live`
    - `reorder/slot-middleware`
    - `reports`
    - `review/plugin-changes`
    - `runs`
    - `stats`

<!-- AUTOGENERATED:END -->
