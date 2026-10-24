# Adaptive bar — overflow as relocation, not transformation

## Context

When a bar runs out of width, today's overflow mechanism can only absorb simple
actions, and it pays for the decision by rendering every child a second time.

Two defects, both in the mechanism rather than in any widget:

1. **The overflow surface transforms its occupants.** The reorder `overflow`
   node wraps its members in `<ActionPresentation mode="menu">`, so every
   overflowed item becomes a `MenuActionItem` row. A button survives that
   losslessly. A volume slider, a jog wheel, a transport scrubber cannot be a
   labelled row at all, so it has nowhere to go. The floating panel is not the
   problem — the same widget rendered as *itself* in a panel is still draggable
   with live feedback. The menu-row transform is what is lossy.
2. **Measurement renders a second live instance.** `OverflowActionsBar`
   (`pane-chrome.tsx:238-368`) and `responsive-overflow` both measure through a
   hidden `MeasureStrip`. Free for a button; for the Sonata volume control
   (a Web Audio `GainNode` behind a scoped store) or the spread jog wheel
   (a pointer-capture drag loop with release momentum) it means duplicate
   subscriptions, duplicate effects, duplicate audio/canvas work.

Because rich widgets cannot survive either defect, the app grew a **structural
exemption** rather than a fix: `PaneChrome` branches on `chrome.header`, and the
custom-header branch (`CustomHeader`, `pane-chrome.tsx:186-196`) carries the
comment *"NO overflow-collapse — rich End widgets (transport / volume /
jog-wheel) never fold behind a '⋯' popover."* That is the second, rival
pane-header system. The Sonata player toolbar lives entirely in it.

**Outcome wanted:** one overflow mechanism that hosts arbitrary widgets without
breaking them and without instantiating them twice — *one instance that
relocates* rather than two that render — with measurement that reads the real
nodes; plus a seam where a widget can offer a **smaller form of itself** and say
how eagerly it yields relative to its neighbours.

### Scope: `chrome.header` is out of this pass

The `chrome.header` / `definePaneToolbar` branch is being **deprecated and
migrated in a separate follow-up**, so this plan does not touch `CustomHeader`
and does not merge the two pane-header systems. `PaneChrome`'s default branch
gets the new mechanism; the custom-header branch is left exactly as it is and
inherits collapse for free when it is folded into the default header later.

The consequence to be honest about: **Sonata is not reachable in this pass.** Its
toolbar's seven contributions (`transport-bar`, `audio/engine`,
`audio/metronome`, `pedal/indicator`, `piano-roll`, `progress/loop`,
`transpose`) live entirely in `chrome.header`, so their `useActionForm`
declarations move to the follow-up too, where they can actually be exercised.
Declaring them now would be inert code nothing can verify.

What does *not* change is the requirement they exist to satisfy: those seven
contributions come from seven different plugins, so no consumer of a bar can name
them or declare policy on their behalf. Every policy must come from the widget
itself, through a generic seam — which is exactly what this pass builds and
proves.

### Proving it on a rich widget without Sonata

Every surface reachable in this pass (pane-header actions, the authored reorder
bucket, the tab bar, the prompt-template strip) is made of plain actions, so none
of them exercises *"a draggable widget relocates and is still draggable"* — the
whole premise.

The proof surface is therefore the **layout harness**
(`plugins/primitives/plugins/css/plugins/layout-harness/`), and it is a
genuinely good fit rather than a workaround: it already renders real React
components with real Tailwind, **sweeps each fixture across a range of widths**
in a real headless Chromium, measures `data-geo` boxes through a generic
geometry oracle, and is wired into `./equin check layout-geometry`. It is
also a live Debug pane (`lab-pane.tsx`), so the same fixture is drivable by an
e2e script. `adaptive-bar` contributes `fixtures/index.ts` — a collected-dir
runtime, so this costs zero codegen edits.

---

## Correction: the cited keep-alive precedent does not keep anything alive

The task text points at `ViewportOverlay`'s `active={false}` as an existing
keep-alive seam. Its own docs say so, and so does the real user of that pattern:
`surface-body.tsx:271` is

```tsx
return portalToBody ? createPortal(container, document.body) : container;
```

with the comment *"`createPortal` only moves the DOM node — the React tree
position is unchanged, so `TabSurface` keeps its state across the transition
(keep-alive)."*

**That claim is wrong.** React reconciles a portal by identity: `reconcileSinglePortal`
reuses the existing fiber only when the current child is *already* a `HostPortal`
with the same `containerInfo`. Switching a plain host element to a portal at the
same position — or changing a portal's container — deletes the subtree and
creates a new one. Solo placement almost certainly remounts the tab subtree
today; nobody noticed because tab surfaces re-derive their state from stores.

I am confident about the reconciler rule and only inferring about the observed
behaviour, so this plan (a) does **not** build on `active`, and (b) includes a
cheap jsdom probe that settles it. If the probe confirms the remount, file it as
its own task — it is a pre-existing bug, not part of this work.

The technique that *does* keep a subtree alive is below: a **stable portal
container** whose DOM node is moved imperatively.

---

## What exists today

| # | Mechanism | Measures | Overflow surface | Fate |
|---|---|---|---|---|
| 1 | `primitives/responsive-overflow` | `MeasureStrip` + a mutate-reflow-restore walk up the ancestor chain | none — drops the tail | **deleted** |
| 2 | `primitives/overflow-menu` | `MeasureStrip` incl. a ghost trigger | `DropdownMenu`, rendering a **hand-authored second form** per item | **deleted** |
| 3 | `OverflowActionsBar` (private, `pane-chrome.tsx:238`) | `MeasureStrip`, hardcoded `MORE_BTN_W = 32` / `GAP = 4` | `Popover` of raw renders | **deleted** |
| 4 | `reorder/node-types/overflow` | nothing — membership is authored in JSONC | `DropdownMenu` + `mode="menu"`, with a `probe` pre-pass | **kept as a node type, loses its mechanism** |
| — | `primitives/css/measure-strip` | — | — | **deleted** (its only importers are 1–3 and `apps-core/tab-bar`) |

`apps-core/tab-bar` already hand-rolls the thing we want to generalize: it
measures a strip of *full-label* tab copies and renders tabs past `visibleCount`
icon-only — except the focused tab, which the bar exempts by name
(`app-tab-bar.tsx:163`). `OverflowMenu`'s `priorityIds` is the same idea, also
consumer-declared. Both become widget-declared.

---

## Design

### 1. The seam — `action-presentation` grows a shrink ladder

The region declares, the widget answers — the existing shape, with a richer
vocabulary. Lives in `plugins/primitives/plugins/action-presentation/`
(it owns the rung renderer, and a `row` answer and its renderer are one
contract).

```ts
/** A rung on the ladder — a form a widget renders ITSELF as. */
export type ActionForm = "full" | "compact" | "row";

/** How eagerly a widget gives up room relative to its neighbours. */
export type YieldEagerness = "never" | "late" | "normal" | "early";

export interface ShrinkLadder {
  /** Smaller forms this widget can render, widest first. `"full"` is rung 0, implicit. */
  shrinksTo?: readonly Exclude<ActionForm, "full">[];
  /** Default `"normal"`. `"never"` pins at full. */
  yields?: YieldEagerness;
}

/**
 * Declare this widget's ladder AND read back the form the region picked.
 * One hook, both directions — you cannot wire half of it.
 * INVARIANT: the returned form is one the caller declared, or "full".
 */
export function useActionForm(ladder?: ShrinkLadder): ActionForm;

/** Freeze this item's assignment while a live interaction is in flight. */
export function useHoldShrink(active: boolean): void;
```

`ActionPresentationMode` is replaced by `ActionForm`. `"inline"` → `"full"`,
because after this change a widget rendered as itself *inside a floating panel*
is not "inline" — the rung names the form, never the location, and the widget
never learns where it is.

**`"row"` becomes opt-in per widget.** A region can only hand `"row"` to a
widget that put it in `shrinksTo`. That is what makes defect #1 structurally
unrepresentable: `VolumeControl` and `SpreadWheel` never declare it, so no
region — present or future — can turn them into a labelled row. Today
`<ActionPresentation mode="menu">` blankets a whole subtree and the rule against
putting a non-action in one is prose in a CLAUDE.md.

**Why `"row"` and not `"menu"`** (a correction to an earlier draft of this plan).
`MenuActionItem` renders a `DropdownMenuItem`, which requires a live base-ui Menu
context — the same class of coupling as the `DropdownMenuLabel`-without-a-Group
crash in ui-kit's CLAUDE.md. So a `menu` form is renderable *only* inside a real
`DropdownMenu`, whose content unmounts on close — which would destroy the very
DOM this design keeps alive. It is also the wrong container on its own merits:
inside `role="menu"`, roving tabindex and typeahead own the arrow keys a
`role="slider"` needs.

So `MenuActionItem` is replaced by **`PanelActionRow`** — the same props and the
same `formatShortcutLabel` (so the two presentations still cannot drift), built
from the `Row` primitive as a real `<button>` that renders correctly with **no
menu, no popover and no context above it**. That single change dissolves the
whole conflict: with no `role="menu"` anywhere, a labelled action row and a
draggable slider are both ordinary focusable controls in a dialog.

**`"probe"` is deleted, and its guarantee is kept more cheaply.** `probe` exists
to answer *"is this bucket empty for THIS row?"* without painting, and pays with
a second instantiation (`overflow-box.tsx:86-89` admits it). Under this design
every widget is mounted exactly once, into its own container, so emptiness is a
one-line DOM read in the same layout effect that already measures:
`container.childElementCount === 0` means *this contribution rendered nothing*.
That is strictly better than today's probe, which only counts `IconButton`s and
is blind to a member that hand-rolls its markup. `ActionPresenceScope` and
`useReportActionPresence` lose their only consumers and go with it.

#### What a widget writes

Sonata volume (`audio/plugins/engine/web/components/volume-control.tsx`) — three
lines. *(Illustrative: this edit lands in the `chrome.header` follow-up, not
here. It is the clearest statement of what the seam is for.)*

```tsx
const form = useActionForm({ shrinksTo: ["compact"], yields: "early" });
if (form === "compact") return <IconButton icon={Icon} label="Volume" onClick={toggleMute} />;
return <Stack direction="row" gap="xs" align="center">{/* icon + slider */}</Stack>;
```

Spread jog wheel (`piano-roll/web/components/spread-wheel.tsx`) — no smaller
form exists (a ribbed drag face at 40px is not a control), so it declares only a
hold:

```tsx
useActionForm();                          // one rung: stay full, or relocate as myself
useHoldShrink(drag.phase !== "idle");     // don't move me mid-fling
```

`IconButton` (`icon-button.tsx`) — the one component that branches today:

```tsx
const ICON_BUTTON_LADDER = { shrinksTo: ["row"] } as const;
const form = useActionForm(ICON_BUTTON_LADDER);
if (form === "row") return <PanelActionRow … />;
return <WithTooltip …><Button variant={variant} aspect="icon" … /></WithTooltip>;
```

**No `IconButton` call site changes anywhere in the repo.**

#### Declaring nothing is safe by construction

A widget that never calls `useActionForm` (the Sonata pedal indicator is a bare
`ToggleChip as="span"`) gets a one-rung ladder and `yields: "normal"`. The
region can therefore only leave it alone or relocate it as itself. It is never
transformed and never truncated — a strict superset of today's safe behaviours.
With no adaptive bar above it, `useActionForm()` returns `"full"` and the
registration is a no-op, so all ~90 `IconButton` importers are unaffected.

#### Why report-up, not context or DOM attributes

The ladder flows *up* (widget → region); context only flows down. DOM
data-attributes were already rejected in this repo for exactly this case —
between the host and a Sonata widget sit `renderIsolated`'s error boundary, the
reorder item middleware, and `.Render`'s own wrapper, so there is no "the
widget's root element" to attribute. Static contribution metadata fails too:
eagerness is often per-instance and dynamic (every tab is the same component;
only the *focused* one says `yields: "never"`). So: an effect-time registration
into the nearest item scope, the `useReportActionPresence` / `useReportPopupOpen`
shape.

### 2. Relocation — one stable container, moved imperatively

Each item gets **one plain `<div>`, created once and owned for that item host's
whole life**. React always renders the item through `createPortal(children,
thatDiv)`, so the portal target never changes identity and the portal fiber is
never torn down. Placement is then a **DOM operation on the container, not a
React operation**.

```tsx
function BarItemHost({ id, children }: { id: string; children: ReactNode }) {
  const [container] = useState(() => document.createElement("div"));
  const forwarded = usePortalForwardedAttrs();

  useLayoutEffect(() => {
    container.setAttribute("data-bar-item", id);
    for (const [k, v] of Object.entries(forwarded)) container.setAttribute(k, v);
    register(id, container);
    return () => { unregister(id); container.remove(); };   // undock; never destroy
  }, [container, id, forwarded]);

  return createPortal(
    <PopupOpenScope>{(open) => <ItemReport id={id} popupOpen={open}>{children}</ItemReport>}</PopupOpenScope>,
    container,
  );
}
```

Two docks, both React-rendered: `inlineDockRef` inside the bar row,
`panelDockRef` inside the panel. A layout effect reconciles each dock's children
to the desired array, using `moveBefore` when available and `insertBefore`
otherwise. **A node already in the right place is never touched** — that single
property is what protects focus, transitions and scroll offsets in the common
case (a resize that moves one widget does not disturb the other six).

The container is not a React element, so `usePortalForwardedAttrs()`
(theme scope, plugin lineage, pane id) is stamped **imperatively and always** —
not only when relocated — so there is no move-time branch that can be wrong.

**What the browser breaks on a plain re-parent**, and what we do:

| | plain `insertBefore` | `moveBefore` | mitigation |
|---|---|---|---|
| `<iframe>` | **reloads** | preserved | detect one in the container and **refuse to relocate**, loudly — never silently reload |
| focus | lost | preserved | snapshot `activeElement`, refocus `{preventScroll:true}` |
| pointer capture | released | preserved | why the drag lock below is mandatory, not a nicety |
| top layer (open popover) | dropped | preserved | why the popup lock is mandatory |
| inner scroll offsets | reset | preserved | snapshot/restore non-zero offsets |
| CSS transitions | restart | preserved | never animate the moved node; animate the panel |
| `:hover` | recomputed | recomputed | not restorable; documented |
| `position: sticky` | new containing block | same | unsupported inside a bar item; documented |

`moveBefore` support in WebKit is uncertain and `tauri/` ships WebKit on macOS,
so feature-detect, keep the fallback, and keep the iframe refusal so the one
genuinely destructive case fails loudly.

### 3. Measurement and fit

**Width cache** — `useRef<Map<`itemId␀rung`, {px, exact}>>`; measurement is
derived data, the *placement* is the state.

Written in the read phase only when the container is connected, has client
rects, **and is docked inline** — a width measured while in the panel is
discarded, never written. Width is `getBoundingClientRect().width`, not
`offsetWidth`: all three existing loops round to integers and under-report by up
to 1px per item, which is how a row ends up permanently one pixel too wide.

Invalidated push-only, by one `useResizeObserver` over
`[barRoot, trigger, ...containers]` — that covers content change, font load,
`ControlSize` change, theme change and zoom in one subscription. A resize of item
*i* writes its current rung exactly and marks its *other* rungs `exact: false`
(kept as estimates; deleting would strand the item at its rung forever).

**"Measured 0" means absent, not width 0.** A contribution that returns `null`
still has a host and a 0×0 container: it contributes no width, no gap, and is
not eligible for the panel. Only an *unmeasurable* node falls back to the cache.

**Cold start, no flash.** First render puts every item at its widest rung inline,
inside an `overflow: hidden` root. `useResizeObserver` runs its callback
synchronously inside the layout effect (`element-size.ts:72`, deliberate and
documented), we measure, decide, and `setState` — whose layout effects re-run
before paint. Same mechanism the current loops rely on.

**Never skip a rung while any width on the path is an estimate.** On the first
overflow, an item with an unknown `compact` width may only be demoted one rung —
never straight to the panel. Otherwise the monotone estimate (`compact ≤ full`)
would relocate an item that compaction alone would have saved, and we would never
learn otherwise, because we only measure inline nodes. Cost: one extra pass on
the first overflow of a session.

**The fit function is pure and lives in `core/`** — no DOM, no React:

```ts
assign({ available, gap, triggerPx, hysteresisPx, items, blocked })
  → { placement, usedEstimate, fits, iterations }
```

`fits: false` means the row is at its floor and *still* overflows (or a width is
unbounded), so the host must clip or scroll rather than believe the layout.
Paired with `usedEstimate` it is the difference between "fits" and "probably
fits" — never collapse the two into one boolean. On a `FitItem`,
`currentRung: null` means **evicted**, not "unknown": there is no third state, so
a brand-new item is seeded at rung 0. Seeding it `null` would make its first
inline placement read as a promotion and hold it behind the band.

Start every unpinned item at its widest allowed rung; while it does not fit,
demote the highest yield-rank unpinned item that is not already at its narrowest
rung (ties broken by later item order); stop when it fits or nothing is
demotable.

- **Termination:** `Φ = Σ stepsRemaining_i` is a non-negative integer that
  strictly decreases each iteration. (An earlier draft wrote
  `Φ = Σ (rungCount_i − 1 − rung_i)` and claimed ≤ `2n` for a three-rung ladder;
  that omits the step into the panel, so an *evictable* three-rung ladder is
  `3n`. The `2n` bound holds only for the non-evictable case.)
- **One answer per width, except inside the band.** `assign` computes a
  placement-independent ideal (seed widest, demote only), so outside the
  hysteresis band a given available width has exactly one answer and the
  algorithm alone cannot cycle. An earlier draft said `assign` never reads the
  current placement at all; **that was wrong** — hysteresis *is*
  direction-dependence, and direction can only come from current state. The
  reconciliation: `currentRung` is read in exactly one place, an all-or-nothing
  guard applied after the ideal is computed (see H1 below).
- **H1, the promote band:** a demotion is accepted when `total > available`; a
  **promotion** only when `total_after + HYSTERESIS_PX ≤ available`
  (`HYSTERESIS_PX = 8`, one `gap-sm`). Disjoint predicates, so no width both
  demands a demote and permits the matching promote. Equality *accepts*, so the
  largest refusing width is `total + H − 1`. Applied as one all-or-nothing guard
  over the computed ideal: if any item would end wider than its `currentRung`
  and the ideal lacks the band's slack, **every** such item is put back at its
  `currentRung` — the single place an unpinned item's current placement is read.
- **Re-entering the row from evicted is a promotion too**, and is held to the
  same band. Missing that arm is how an item flickers in and out at one width.
- **An unbounded width is never a fit.** "Estimate an unmeasured rung as 0 if
  nothing is known" would break the rule it sits beside: 0 is a *lower* bound, so
  it fabricates a fit. With no bound at all the configuration is reported
  `fits: false` and demotion continues. Only a genuine *upper* bound (the nearest
  measured wider rung) is trusted for the total — it can refuse a fit, never
  invent one.
- **H2, the promotion-failure pin:** if a committed promotion turns out (with
  the now-exact width) not to fit, record `blocked[i] = {rung, atWidth}` and
  demote back; that rung is barred until `available > atWidth + HYSTERESIS_PX`.
  The failed promotion *measured the true width*, so this costs at most one
  round trip per (item, rung) per content change — bounded over the bar's
  lifetime, not per resize.
- **`MAX_PASSES = 4` per resize episode.** If pass 4 still disagrees: commit the
  **floor** assignment (every unpinned item at its narrowest rung — the only
  configuration guaranteed not to overflow), `emit` once through a
  `defineReportSink` so it lands in Debug → Reports, and **throw in dev**.
  Non-convergence means the algorithm is wrong and must not be lived with; prod
  does not throw, because taking down a pane header over a layout disagreement
  is worse than the floor layout plus a filed alert.

The trigger width is **measured from the real trigger**, never
`MORE_BTN_W = 32` — which is simply wrong at any other control density. The gap
is read from `getComputedStyle(inlineDock).columnGap`, so it cannot drift from
the rendered class.

### 4. Available width — the bar is defined to be a grow cell

Root is `min-w-0 flex-1` + `flex items-center overflow-hidden whitespace-nowrap`
(a layout primitive, so it owns its raw mechanics behind a named
`layout/no-adhoc-layout` disable). Its `getBoundingClientRect().width` **is** the
available width — exactly the contract `overflow-menu.tsx:44-52` already
documents.

`responsive-overflow`'s mutate-reflow-restore apparatus
(`responsive-overflow.tsx:51-122`) is deliberately **not** inherited. It writes
inline styles up an ancestor chain and then calls `getComputedStyle` on every
competing sibling — each read after a write is its own forced recalculation —
and it exists only because that primitive chose a content-sized `inline-flex`
container. A primitive that declares itself the grow cell does not have the
problem.

**Consumer rule, one sentence:** *put the bar where there is slack to give — as
the growing cell of a single-line row (`Line`/`Row`/`Bar`), with no `Fill` or
other `flex-1` sibling competing for the same slack, and never inside a
shrink-to-content parent (`inline-flex`, `w-fit`, `Cluster`). One adaptive bar
per row.*

Two guards, both gated on `available > 0` so jsdom cannot trip them:
`getComputedStyle(barRoot).flexGrow === "0"` at mount throws with the rule in the
message; and per pass, if the fit says "everything fits" but the bar's right edge
sticks out past its offset parent's content box by >1px, it was never given
slack — dev throws, prod reports and takes the floor assignment.

### 5. The panel

One **always-mounted** `ViewportOverlay layer="popover"` (portaled to
`document.body`, container constant forever) holding a Floating-UI-positioned
`Surface level="overlay"` box around `panelDockRef`.

**"Closed" is a CSS state, never an unmount** — `display:none` + `inert` +
`aria-hidden`. A stock `Popover` unmounts its content, which would destroy the
dock and orphan every relocated container. `inert` is also what keeps a parked
`role="slider"` from being a focusable off-screen trap.

**The surface is always a dialog. There is nothing to derive.** Each occupant
renders its own declared form: an action that declared `"row"` is a
`PanelActionRow`, everything else renders `"full"` — as itself.

An earlier draft derived the surface from the occupants (a real `DropdownMenu`
when all of them were menu-safe, a popover otherwise). That is not
implementable, and chasing it was the wrong instinct: `DropdownMenuContent`
unmounts on close, which destroys the dock and orphans every relocated
container. Composing `ViewportOverlay` + `OverlayPanel` directly — the same three
pieces `floating-surface` composes — and keeping the panel mounted is both
simpler and the only version that satisfies the one-instance requirement.

This is also the a11y fix rather than a cosmetic choice: inside `role="menu"`,
roving tabindex and typeahead own the arrow keys, so a relocated `role="slider"`
jog wheel would be keyboard-unreachable and its Left/Right eaten by menu
navigation. In a dialog it is a plain focusable widget — Tab reaches it, arrows
reach the slider, Esc closes, and because it is *the same instance*,
`aria-valuenow` and the drag physics come along untouched.

**The honest cost:** the panel is Tab + Enter + Esc, with no typeahead and no
arrow-key roving. That is a small regression for the authored reorder `overflow`
bucket (a real `DropdownMenu` today) and an improvement for the pane header
(today an anonymous column of ghost icon buttons in a popover,
`pane-chrome.tsx:337-364`; labelled rows after).

**Two locks, both contract-free.** React synthetic events bubble along the fiber
tree even out of a portal, so the bar's own root sees pointer activity inside a
widget physically living in the body-portaled panel:

- `onPointerDownCapture` / `onPointerUpCapture` on the bar root pin the item
  under the pointer for the duration of any drag — no author opt-in needed.
  `useHoldShrink` covers only what survives the release (the inertial fling's
  coast).
- `PopupOpenScope` around each item pins it while its own popover is open, so
  the Sonata metronome's `InlinePopover` is handled with zero contributor change.

A pinned item is frozen at its current rung; the bar re-fits everything *around*
it. The target placement is **stored, not discarded** — the unlock itself
triggers a pass, so "deferred forever" is unrepresentable.

The panel closes on: the trigger, `Esc`, an outside pointerdown, and
**becoming empty**. A resize never closes it.

---

## Plugin layout

New: **`plugins/primitives/plugins/adaptive-bar/`**

- `core/fit.ts` — `assign()`, pure, `bun:test`-able.
- `core/width-cache.ts` — a pure reducer (`write` / `staleOthers` / `dropItem` / `estimate`).
- `core/dock-plan.ts` — `planMoves(currentIds, wantIds) → {id, beforeId}[]`, pure over arrays.
- `web/` — `<AdaptiveBar>` (width-driven), `<AdaptiveBar.Collapsed>` (authored:
  every item relocated, no measurement — for the reorder node), `<AdaptiveBar.Item>`.
- `fixtures/index.ts` — the layout-harness contribution (collected-dir; no
  codegen edits), including the rich draggable-slider fixture that is this
  pass's proof surface.
- `e2e/adaptive-bar-relocate.ts` — the one-instance + drag-survives proof.

Host surface:

```tsx
<AdaptiveBar gap="xs" label="More controls" overflow="panel">
  <SomeSlot.Render>
    {(item) => <AdaptiveBar.Item id={item.id}><Item {...item} /></AdaptiveBar.Item>}
  </SomeSlot.Render>
</AdaptiveBar>
```

The host names no contributor, declares no priority, hardcodes no width, and
renders no second copy. **Order is an input, not something the mechanics
discovers:** a slot-driven host must take the *effective* order from the reorder
read hook, because the reorder middleware renders its own list inside `.Render`
(`render-slot.tsx:195-208`), so raw `useContributions()` order is not what is
displayed.

`overflow` is `"panel" | "scroll" | "clip"` — the one thing not derivable from
the occupants, because it is the host's own layout policy (a tab strip scrolls; a
chip strip that already has a separate "all templates" panel clips).

Dependency edges (all acyclic; `./equin check plugin-boundaries` is the gate):

```
icon-button ─────────► action-presentation                       (unchanged)
adaptive-bar ────────► action-presentation, icon-button, ui-kit, element-size,
                       css/{line,spacing,surface,viewport-overlay,layout-harness},
                       popup-open, report-sink, reorder
pane ────────────────► adaptive-bar        (pane already imports icon-button + measure-strip)
pane-toolbar ────────► pane                                       (unchanged)
apps-core/tab-bar ───► adaptive-bar
conversations/…/prompt-templates ──► adaptive-bar
reorder/node-types/overflow ───────► adaptive-bar
```

The one edge to check twice is `adaptive-bar → reorder/web` for `useEditMode`:
edit mode wraps every contribution in drag chrome and dnd-kit handles that must
not be relocated out from under `SortableContext`, so the bar renders everything
inline while edit mode is on — the same escape `OverflowBox` already takes
(`overflow-box.tsx:55`). Precedented: `primitives/collapsible-wrap` already
imports `reorder/web`. `reorder → node-types`, and `node-types/overflow →
adaptive-bar`, but `node-types` itself imports neither, so the graph stays a DAG.

Deleted: `primitives/responsive-overflow`, `primitives/overflow-menu`,
`primitives/css/measure-strip`. **`rg MeasureStrip` returning nothing is the
acceptance test for defect #2.**

`.claude/skills/css/SKILL.md` — replace the `ResponsiveOverflow` line in the
primitive index with `AdaptiveBar`.

---

## Migration, staged

Each stage builds and is independently reviewable.

**Stage 1 — the seam.** `action-presentation`: add `ActionForm`, `ShrinkLadder`,
`useActionForm`, `useHoldShrink`; delete `ActionPresentationMode`, `"probe"`,
`ActionPresenceScope`, `useReportActionPresence`. Update `IconButton` (its body
only). At this point `OverflowBox` is the only broken caller — fix it in stage 4.
Pure `bun:test` coverage for the ladder resolution.

**Stage 2 — the primitive.** `adaptive-bar` with its three pure `core/` modules
and the web host. Ships with the jsdom suite, the `ViewportOverlay active`
remount probe (§ Correction), and — the load-bearing part — its
`fixtures/index.ts` contribution to the layout harness containing **a genuinely
rich fixture**: a bar holding a draggable `role="slider"` alongside several
plain buttons, so the width sweep exercises relocation of something that is not
an action. This is what replaces Sonata as the proof surface.

**Stage 3 — the pane header's default branch.** Replace `OverflowActionsBar`
with the primitive; leave `CustomHeader` and everything `chrome.header` touches
alone.

```tsx
{hideRightActions ? (
  <Fill />
) : (
  <AdaptiveBar gap="xs" label="More actions">
    <PaneActionsSlot pane={pane} position="right" />
    {actions != null && <AdaptiveBar.Item id="pane-extra">{actions}</AdaptiveBar.Item>}
  </AdaptiveBar>
)}
```

Delete `OverflowActionsBar` (`pane-chrome.tsx:238-368`) with its hardcoded
`MORE_BTN_W = 32` / `GAP = 4`. The `flex-1` spacer eslint-disable at `:139`
becomes the `Fill` that was always the right answer. `PaneActionsSlot` wraps each
contribution in an `AdaptiveBar.Item` when it is inside a bar.

Every right-side pane action is an `IconButton`, so every occupant declares
`"row"` and the panel fills with labelled `PanelActionRow`s — an improvement on
today's popover holding an anonymous column of ghost icon buttons
(`pane-chrome.tsx:337-364`), and the first thing to eyeball.

Required sub-step: **`pane.Actions` has no `id`** (a bare
`Slot<{component, position}>` rendered by index at `pane-chrome.tsx:221-226`),
and the width ledger needs a stable key per item. Add a required
`id: string` to the Actions contribution payload and thread it through
`PaneActionsSlot`. Seven call sites across six files.

**Do NOT promote it to `defineRenderSlot`** (an earlier draft of this plan said
to). The slot is minted per pane with a *templated* id — `defineSlot(
`pane.${id}.actions`)` at `pane.ts:1838` — so build-time codegen cannot extract
it into the reorderable-slots manifest, and making it a render slot would put it
in a reorder path whose config key it can never statically own. Stable ids are
all the ledger needs; reorderable pane actions are a separate question and not
this pass's.

**Stage 4 — the authored reorder bucket.** `OverflowBox`'s live branch becomes
`<AdaptiveBar.Collapsed label={label}>` wrapping each member in an
`AdaptiveBar.Item`. The probe pass, the double mount, and the "a member exists
twice while its menu is open" caveat all go. The edit-mode inline branch
(`overflow-box.tsx:55-74`) is untouched.

**Stage 5 — the consumers.**
- `apps-core/tab-bar`: drop `useResponsiveOverflow`, the `visibleCount`
  arithmetic and the full-label `MeasureStrip`; wrap chips in
  `<AdaptiveBar overflow="scroll">`; inside `Tab`,
  `useActionForm({ shrinksTo: ["compact"], yields: active ? "never" : "normal" })`.
  The bar stops naming its focused child.
- `conversations/…/prompt-templates`: `<ResponsiveOverflow gap={4}>` →
  `<AdaptiveBar gap="xs" overflow="clip">`. Behaviour identical (dropped chips
  stay reachable through the existing `FloatingAction` panel). Its e2e
  (`e2e/usage-order.ts:45-53`) loses the "don't assert against the off-screen
  clone" workaround.
- `sonata/library` display-picker: `OverflowMenu` → `AdaptiveBar`; each option's
  hand-written `menu` node (`display-picker.tsx:69-104`) is deleted;
  `priorityIds={[activeId]}` → the active option's own `yields: "never"`.
  (This one lives *inside* a toolbar item, not in the toolbar itself, so it is
  reachable even though `chrome.header` is untouched.)

### Explicit follow-ups, not this pass

- **Deprecate and migrate `chrome.header`** onto the default header. Sonata's
  seven toolbar plugins add their `useActionForm` declarations there — volume
  `shrinksTo: ["compact"]`, spread wheel a bare `useActionForm()` +
  `useHoldShrink`, transport `shrinksTo: ["compact"]`, loop/metronome/pedal
  nothing — and the toolbar itself writes no bar code at all.
- **Let the reorder tree override yield eagerness** by `entryKey`.
- **The `ViewportOverlay` keep-alive bug**, if the probe confirms it.

---

## Deliberate decisions, and what stays open

- **The panel is always a dialog; nothing is derived.** A `role="menu"` surface
  is incompatible with both requirements at once (it unmounts its content, and
  it eats a slider's arrow keys), so the third rung is a context-free
  `PanelActionRow` instead of a `DropdownMenuItem`. Costs typeahead and
  arrow-key roving in the overflow panel; noted above.
- **Yield eagerness is widget-declared only** in this pass. Letting the slot's
  reorder-tree JSONC pin or demote a specific item by `entryKey` is a natural
  follow-up (the tree already authors order, which is the tie-break) — out of
  scope here to keep the config surface unchanged.
- **`overflow="clip"` can silently drop a widget.** Kept, because it is what
  prompt-templates needs and it has a second route to the content. If it starts
  papering over layout bugs, the answer is a lint rule requiring a named reason,
  not a stricter default.
- **A widget could declare `"row"` and not render a `PanelActionRow`.** Not
  structurally prevented. In practice `IconButton` is the only widget that ever
  declares it, so one audited component covers every row answer. The structural
  fix, if it bites, is to make the row rung a payload
  (`useActionForm({ row: { icon, label, onClick } })`) so the *region* renders
  it — not proposed now, because it makes one rung asymmetric for a hazard with
  one plausible offender.

---

## Verification

**Pure (`./equin test plugins/primitives/plugins/adaptive-bar`)**
- `assign()`: everything fits; single demote; demote order follows yield rank; a
  pinned item never moves; trigger reserved exactly once; H1's band refuses a
  promote at the boundary and accepts one pixel past; H2's pin honoured and
  released at `atWidth + HYSTERESIS_PX`. Property test: random width vectors ⇒
  ≤ 2n iterations, result fits or is the floor.
- width cache: measured-0 is absent and unwritten; a panel-docked measurement is
  refused; an unknown `compact` uses the monotone bound and a measured violation
  is reported.
- `planMoves`: **an unchanged order plans zero moves** — the property that
  protects focus, transitions and scroll offsets.

**jsdom (`web/__tests__/`)** — put the measurement read behind an injectable
`measure(el) => number` seam, since jsdom has no layout engine and the shared
observer is inert.
- *One instance, ever*: a probe widget bumps a module counter on mount and stores
  a `useRef` identity; drive a relocation; assert the counter is still 1 and the
  ref identity unchanged.
- Portal container identity stable across relocation; forwarded attrs land and
  update; a React `pointerdown` pins its item and `pointerup` applies the
  deferred move; an open `Popover` pins; closing the panel does not change the
  dock's identity or children; unmounting the bar leaves no stray `document.body`
  children.
- The `ViewportOverlay active` remount probe from the Correction section.

**Geometry, in a real browser, gated (`./equin check layout-geometry`)** —
the `fixtures/index.ts` contribution. Across the harness's width sweep, on the
rich fixture: no two `data-geo` boxes overlap, the ⋯ trigger is always inside the
bar's box, and the bar's right edge never passes its parent's content edge. This
is the fit math under a real layout engine, and it runs on every css-subtree
change with no browser launch when nothing changed.

**e2e (manual, the only place the *behavioural* claim can be proven)** —
`plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-relocate.ts`, driving
the Layout Lab pane (Debug sidebar) on the shared harness:
1. Open the Lab wide; read the fixture slider's `aria-valuenow` and a
   `data-instance-id` minted once per mount.
2. Narrow until it relocates; open the panel; `page.mouse` drag the slider face;
   assert `aria-valuenow` moved and the readout followed — **a drag that works
   after relocation is the whole point of the change**.
3. Widen; assert it is back inline **with the same `data-instance-id`** — the
   single-instance proof.
4. At every width, assert the fixture's slider matches exactly once in the
   document. Today's `MeasureStrip` would make that 2, so this line is the
   regression test for the entire premise.
5. Separately, on a real pane header: narrow a task-detail pane until its actions
   collapse, and confirm the ⋯ opens a keyboard-navigable menu.

**Repo-level**
- `rg MeasureStrip` returns nothing.
- `./equin check` — `plugin-boundaries`, `type-check`, `eslint`,
  `plugins-doc-in-sync`, `reorderable-slots-in-sync`.
- `./equin build`, then walk `http://<worktree>.localhost:9000` narrowing
  each surface: the Layout Lab's adaptive-bar fixture, a task detail pane, the
  app tab bar with many tabs, a conversation's prompt-template strip, and any
  slot with an authored `overflow` bucket. **A Sonata song should look and behave
  exactly as it does today** — its toolbar is untouched in this pass, and any
  change there is a regression.
