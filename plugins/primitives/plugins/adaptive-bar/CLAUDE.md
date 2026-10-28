# adaptive-bar

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

Overflow as **relocation**, not transformation: a bar that runs out of room asks
each widget to render a smaller form of itself, and moves the rest — as
themselves, one live instance, never a second render — into a panel.

Design doc: [`research/2026-08-16-global-adaptive-bar-relocating-overflow.md`](../../../../research/2026-08-16-global-adaptive-bar-relocating-overflow.md).

```tsx
<AdaptiveBar gap="xs" label="More actions">
  <SomeSlot.Render>
    {(item) => (
      <AdaptiveBar.Item id={item.id}>
        <Item {...item} />
      </AdaptiveBar.Item>
    )}
  </SomeSlot.Render>
</AdaptiveBar>
```

The host names no contributor, declares no priority, hardcodes no width, renders
no second copy. Every policy (which forms exist, how eagerly to yield) comes from
the widgets via [`action-presentation`](../action-presentation/CLAUDE.md)'s
`useActionForm`.

## API

- **`align`** `"start"` (default) | `"end"` — which end of the bar's slack the
  occupants sit against (pane-header action cluster: `"end"`). A prop, never a
  caller `justify-*`: the bar owns its layout mechanics.
- **`spill`** — `overflow-visible` instead of clipping, for a row holding
  something that paints outside the strip (a `CollapsibleWrap` title). The fit is
  unaffected.
- **`<AdaptiveBar.Collapsed label overflow>`** — every occupant relocates
  unconditionally (for a slot whose layout says "behind a `⋯`").
  - Exception: when only ONE occupant renders, it stays inline at full form,
    with no `⋯`.
  - `overflow` is `"panel"` (default) | `"scroll"` (nothing leaves) | `"clip"`.
  - It measures nothing and takes no slack, so it may nest inside a bar
    (`reorder`'s `overflow` node type does).
- **`<AdaptiveBar.Item className>`** — classes go on the occupant's own
  container (travels between row and panel), for traits of the whole occupant
  (hover reveal).
  - Don't use an inner wrapper for this: a wrapper is an element, so the
    occupant would never read as empty.
  - Rigidity is always kept.
- Slots: the bar declares `<SlotItemLayout orientation="host-owned">`, so
  `slot-render` draws no cell; containers dock against their anchor's parent,
  so wrapper chains in between are invisible.

## `<AdaptiveBar.Yield>` — the row's give

- At most **one** per bar (a second **throws**).
- Excluded from the fit — never registers, measured, demoted or relocated.
- `min-w-0` ([`yieldClass`](../css/plugins/yield/CLAUDE.md)), so its `<Text>`
  ellipsizes.

Use it for a pane title; a rigid title pushes the actions out instead.

`grow` makes it a `Fill` (gives AND takes slack) — what a LEADING yield needs in
an `align="end"` row, so the slack sits between title and actions. An empty
growing cell keeps the actions where a titled header has them.

The reorder `spacer` is the other half of `Fill`
([`grow`](../css/plugins/grow/CLAUDE.md)) and needs nothing from this primitive.

### It gives down to a floor — **8em of its own font size**

Without a floor, flex takes the whole deficit from the yield cell: the row never
overflows, and nothing is ever demoted (a title crushed to one word while ten
widgets sit inline).

So the fit's budget is `row content box − insetPx − yieldFloor`; past the floor
the row overflows and an occupant relocates.

- `em` (not px) because legibility scales with typography/density presets (~16
  chars at 14px).
- One constant, not a prop.

Edges (pinned in `web/__tests__/row-inset.test.tsx`):

- **An empty cell reserves nothing** (judged by `rendersNothing`, same as an
  occupant; a late title signals through its own `MutationObserver`).
- **A row narrower than the floor** clamps the budget at 0, never negative —
  `available <= 0` is the latching "not a width" branch a cramped row must
  never take. At 0 every evictable occupant relocates.

`budget` and `available` in `reconcile` must stay two numbers:

- host-facing guards (`no-slack`, zero-width recovery, grow-cell premise) read
  `available`;
- everything the search touches (premise round, H2 bars, best-so-far,
  watermarks) is in `budget`'s currency.

## The one rule for consumers

> **Put the bar where there is slack to give:** as the growing cell of a
> single-line row (`Line` / `Row` / `Bar`), with no `Fill` or other `flex-1`
> sibling competing for the same slack, and never inside a shrink-to-content
> parent (`inline-flex`, `w-fit`, `Cluster`). One adaptive bar per row.
>
> Every box between row and bar must relay the grow (a `min-w-0` wrapper is
> still shrink-to-content). The bar asks for that itself via `useRequestGrow`
> ([`grow-relay`](../css/plugins/grow-relay/CLAUDE.md)):
>
> - the `slot-render` cell relays;
> - `Line` / `Row` / `Bar` stop the ask;
> - `Fill` already grows.
>
> A hand-rolled `<div>` wrapper swallows the grow — `no-slack` prints how many
> boxes relayed (`0`: nothing above can give room; `n`: recompose the offending
> `<div>` onto `Fill`).

Because the bar is `min-w-0 flex-1`, `barRoot.getBoundingClientRect().width`
**is** its given width — no ancestor walk.

The budget subtracts the root's own padding/border (`readRowMetrics`'s
`insetPx`) because occupants are laid out and judged (`measureRowOverflow`) in
the content box; don't simplify that away.

## Faults

- Every fault files a report through `adaptiveBarReportSink` (→ Debug → Reports
  via `reports/adaptive-bar`).
- Contract-breaking ones also **throw in dev** — but `import.meta.env.DEV` is
  `false` in every built web artifact (`ARTIFACT_DEFINE` in
  [`web-artifacts`](../../../framework/plugins/tooling/plugins/web-artifacts/core/internal/vite-builder.ts))
  and the layout-harness page, so the throw exists only under vitest.
- Handled cases (`empty-rung`, `iframe-relocation`, over-full row) report
  without throwing or latching.
- Each fault carries `label` and `origin` (innermost UI-context node above the
  root); `origin` + `overflow` is the fingerprint (labels default to `"More"`).

The six kinds (`AdaptiveBarFaultKind`):

- **no-slack** — the premise checked directly: hide the occupants, re-read the
  row, restore. A given width measures the same; a shrink-wrapping host
  measures its content twice.
  - Style proxies can't detect it — `flex-grow` is 1 in the failing case.
  - Re-asked **per width** whenever the row is narrower than the width last
    verified (hosts change under a mounted bar), capped by `MAX_SLACK_PROBES`
    (each is a forced reflow).
  - **0px row with occupants relocated**: first, does the row generate a box?
    (`getClientRects().length > 0` via the seam's `isRendered`.)
    - A `display: none` surface — unfocused tab, keep-alive body, minimized
      window, collapsed miller column — is no reading at all;
      `visibility: hidden` counts.
    - A rendered 0 is either a ratchet-emptied shrink-wrap host or an
      **over-full** row (`flex: 1 1 0%` resolves to 0 under negative free
      space).
    - The bar re-admits everything, clears the premise watermark and reserves a
      probe. The next pass faults+latches for a shrink-wrap host, or files an
      over-full `reportFault` (no throw, no latch, once per mount) and decides
      again when room returns.
    - Recovery defers while a gesture holds an occupant (`holds`, `popupOpen`,
      `pointerPinned` — not `immovable`); bounded by `MAX_ZERO_RECOVERIES` (its
      termination argument lives there).
- **nested-bar** — a MEASURING bar inside another bar's occupant, read from
  `BarRegistryContext` at mount. Otherwise the outer bar files a misleading
  `no-slack`.
  - `Collapsed` is not a claimant and never fires it.
  - A nested bar declines to measure at all (`reconcile`, beside `degraded`).
  - Pinned in `web/__tests__/nested-bar.test.tsx`.
- **row-overflow** — the fit says it fits, the rendered row overflows. Measured
  as the union of occupant boxes vs the bar's content box (`measureRowOverflow`
  + `core/overflow.ts`).
  - Don't "simplify" to an ancestor comparison (`offsetParent` /
    `parentElement` aren't the row) or `scrollWidth > clientWidth` (misses
    left-edge overflow of `align="end"` rows, counts descendants' transforms).
  - Skipped in `scroll` mode.
  - Gated on `layoutMeasured`, so never fires in jsdom.
- **no-convergence** — round budget exhausted with the answer still moving; see
  *A round is only a round of the same question*.
- **iframe-relocation** — an occupant holding an `<iframe>` is never relocated
  (a plain re-parent reloads it).
- **empty-rung** — a widget declared a smaller form and rendered nothing as it.
  - About the contributor; never throws (a loading frame must not kill a pane).
  - The bar stops offering that form.
  - In `clip` mode the widget ends in the hidden parking dock, i.e. invisible.

`no-slack` is ungated — a differential measurement through the seam, so jsdom
can drive it (`web/__tests__/no-slack.test.tsx`).

`AdaptiveBarMeasure` defaults `isRendered` to `() => true` (jsdom's
`getClientRects()` is always `[]`), so always ask through the seam, never the
DOM directly.

**Remedies differ by fault; don't merge the kinds:**

| fault | commits |
|---|---|
| `no-slack`, `nested-bar` | the **ceiling** (everything inline, CSS clips), latched for good — eviction is what a bad width reading must not do |
| `no-slack` 0px branch | ceiling **without** latch (re-asking); over-full answer commits nothing |
| `row-overflow` | the **floor** (every unpinned occupant at its narrowest rung) — the fit's arithmetic is the suspect |
| `no-convergence` | the widest placement the search **measured** as fitting at this width; floor only if none |

- In `clip` mode the floor never evicts (it would hide everything).
- Committing and stopping are **one act** (`commitSurrender` latches) — "take
  the fallback and keep searching" has no spelling, else the fit recomputes the
  same answer forever.
- Scoped to the width, capped by `MAX_SURRENDERS`; a stopped bar still DOCKS.

Proof: `web/__tests__/termination.test.tsx`.

## A round is only a round of the same question

`reconcile` runs when:

- the bar committed a placement — the only one that is a search round;
- the row width changed;
- an occupant (un)mounted or re-declared;
- an occupant's width moved.

Each pass records its **premise** (row width, ordered ids and ladder depths,
measured widths); when it moves, the round counter restarts.

The width clause counts **only a width that moved at a rung the item was already
at** — counting rung changes would reset the counter every round and remove the
bound.

Three counters, one remedy; the fault says which tripped:

- **`rounds`** vs `passBudget(items)` — derived from the steps this row can give,
  clamped `[4, 16]`.
- **`shifts`** vs `MAX_PREMISE_SHIFTS` — the widths never stopped moving (not the
  fit's fault).
- **`total`** vs `HARD_ROUND_CEILING` — **never reset**; the termination
  guarantee. `reconcile` re-enters synchronously via its layout effect, so a
  self-resizing widget (`:hover` after re-parent, own measuring effect) would
  otherwise hit React's nested-update limit.

The fault carries evidence (`core/round-trace.ts`): occupants that moved (id,
rung, from → to px), distinct row widths, the counters, and whether a placement
recurred (fit cycle vs moving premise).

## Why one stable container per item

Each occupant gets one plain `<div>`, created once in a `useState` initializer.
React renders the widget through `createPortal(children, thatDiv)`, and
placement is a **DOM operation on a node React does not own** — never unmounted,
never rendered twice.

The container must never be replaced: React reconciles a portal by **container
identity** (proof:
[`portal-toggle-remounts.test.tsx`](../css/plugins/viewport-overlay/web/__tests__/portal-toggle-remounts.test.tsx);
the `no-portal-toggle` rule bans the shape).

Ancestry a portal severs (theme scope, plugin lineage, pane id) is stamped onto
the container **imperatively and unconditionally**, never at move time, using the
REGION bag (`useRegionForwardedAttrs`, not the popup one) — an occupant keeps
its row's sub-theme.

## What survives a re-parent, and what does not

| | plain `insertBefore` | `moveBefore` | what the bar does |
|---|---|---|---|
| `<iframe>` | **reloads** | preserved | **refuses to relocate**, loudly |
| focus | lost | preserved | snapshots `activeElement`, refocuses `{preventScroll:true}` |
| pointer capture | released | preserved | why the pointer lock is mandatory |
| top layer (open popover) | dropped | preserved | why the popup lock is mandatory |
| inner scroll offsets | reset | preserved | snapshots and restores non-zero ones |
| CSS transitions | restart | preserved | never animate a bar item; animate the panel |
| `:hover` | recomputed | recomputed | not restorable |
| `position: sticky` | new containing block | same | **unsupported inside a bar item** |

(`tauri/` ships WebKit on macOS, so the fallback path matters.)

Hence **a node already in the right place is never touched**:

- inline containers already before their anchor are skipped;
- the panel order is an LIS diff (`core/dock-plan.ts` `planMoves`) — an
  unchanged order plans zero moves.

## Order is an input, and it comes from the DOM

Each item host renders a `hidden` anchor `<span>` at its natural position; the
bar reads document order off the anchors (slot reorder middleware already sorted
them). No mount-order registry, no consumer order list.

`hidden` = `display: none`: no width, no gap. An occupant that rendered nothing
is `hidden` too, and never goes to the panel.

- **The anchor's parent decides placement**, not the bar root: a container docks
  immediately before its anchor, and "inline" is `isDockedInline` (immediately
  before its anchor), not "child of root" — slot-render's `display: contents`
  box sits between.
- Hence **rigidity is declared per container** (`rigidClass()` on each minted
  container and on the `⋯` trigger), never `[&>*]:shrink-0` on the root.
- **`hidden` (layout fact) and the blank-rung ledger (decision fact) are
  distinct**; they may disagree for exactly one pass. A `MutationObserver` per
  container detects content reappearing (a `display: none` element fires no
  resize).

## The panel is always mounted

"Closed" = `display: none` + `inert` + `aria-hidden`, never an unmount (it holds
live relocated DOM; `Popover`/`DropdownMenuContent` destroy content on close).

It composes `ViewportOverlay` + `OverlayPanel` + Floating UI directly — not
`FloatingSurface`, which returns `null` when closed.

- A plain **dialog**, never `role="menu"` (menus unmount, and roving
  tabindex/typeahead eat a relocated slider's arrow keys). `inert` is
  load-bearing: a parked control must not be Tab-reachable.
- Closes on trigger, `Esc`, outside pointer-down, and **becoming empty**; a
  resize never closes it.
- While a parked occupant's own popup is open, `Esc`/outside presses are the
  popup's; the panel dismisses on the next one.

## Two locks, neither of which anyone opts into

React events bubble the **fiber** tree, so the bar root sees pointer-downs inside
the body-portaled panel:

- a pointer down inside an occupant pins it for the gesture (document-level
  release as fail-safe);
- `PopupOpenScope` around each item pins one whose popover is open.

`useHoldShrink` only covers a fling's coast after release.

A pinned item is frozen; the target placement is **stored**, and the release
triggers the pass.

## The honest costs

- **The panel is Tab + Enter + Esc** — no typeahead or arrow roving; the price
  of hosting a live slider.
- **A placement change re-renders every occupant** (a rung is React state).
- **One always-mounted `document.body` child per bar**, plus a hidden parking
  dock.
- **The trigger is measured once by revealing it** (un-hide, measure, re-hide
  synchronously) — never a hardcoded width like `MORE_BTN_W = 32`.
- **`degraded` latches per mount** — only a remount clears it, which is why the
  0px branch re-asks before accusing.
- **`overflow="clip"` can silently drop a widget.** Kept for prompt-templates;
  if it starts hiding layout bugs, add a lint demanding a reason.

## Where the claims are proven

| where | what only it can prove |
|---|---|
| `core/*.test.ts` (bun) | the fit math |
| `web/__tests__/` (jsdom) | no unmount; the pins; the panel's dock survives a close |
| `exhibits/index.ts` → `./equin check layout-geometry` | no collisions/spill under a real engine across a width sweep |
| `e2e/adaptive-bar-relocate.ts` (manual) | **a relocated slider still drags**, same instance |
| `e2e/adaptive-bar-hidden-host.ts` (manual) | a bar hidden with `display: none` and shown again still decides |
| `e2e/adaptive-bar-overfull-row.ts` (manual) | a bar over-filled to 0px still decides once room returns |

jsdom supplies widths through `AdaptiveBarMeasure` (the measurement seam).
**`AdaptiveBarMeasure` is test-only** (`web/testing`): never use it to "adjust"
measurement in production.

### Driving a bar occupant from another plugin's e2e script

A relocated control sits in the closed `⋯` panel (`display: none`, invisible to
role locators).

- Use `reachInBar(page, control, act)` from
  `@plugins/primitives/plugins/adaptive-bar/e2e` — runs `act` in the row, or
  after opening the `⋯` (closed after).
- Read a relocated control's text with a CSS locator.

---

## `core/` — the pure decision math

No DOM, no React.

| module | answers |
|---|---|
| `core/fit.ts` | which rung each item renders at, and who leaves the row |
| `core/width-cache.ts` | what each item measured at each rung, and how much we trust it |
| `core/blocked-rungs.ts` | which rungs a failed promotion barred, and until what width |
| `core/absent-rungs.ts` | which rungs an occupant renders nothing at, so they are never offered |
| `core/dock-plan.ts` | the fewest DOM moves that turn one dock order into another |

### The rules worth knowing before you touch this

**An occupant's width is its own** — a property of item + rung, never of its
neighbours; that is what `exact` claims, discharged by **`rigidClass()` on every
minted container** (`bar-item.tsx`).

- Mid-search the row is normally over-full; a squeezed reading would be stored
  as sticky `exact`, blind the row-overflow guard and stop demotion.
- Today's occupants (buttons, chips under `whitespace-nowrap`) happen to be
  unsqueezable; wrapping text or %-sized images are not — the declaration
  removes the accident.
- The `⋯` trigger declares its own (`measureTrigger` caches its width).
- Proven by the `adaptive-bar/squeezable-occupants` exhibit.

**Only an inline item is measurable.** `write` refuses a width read in the panel;
everything not inline is inference.

**An estimate may refuse a fit; it may never fabricate one.** An unmeasured rung
is bounded by the nearest *wider* measured rung; with none, `assign` reports
`fits: false`, never a 0. Keep `usedEstimate` ("probably fits") distinct from
`fits`.

**One estimated step per pass.** An item whose next rung is a guess is demoted
at most once per `assign` — otherwise a guess chain relocates a widget compaction
would have saved, unlearnably (panelled widgets are never re-measured).

**A node already in the right place is never touched** — `planMoves` is an LIS
diff.

**A form a widget does not render is not a form it has.**

- Blankness is recorded per occupant AND rung (`core/absent-rungs.ts`, read from
  the DOM at the current rung).
- The ladder handed to `assign` is cut at the first blank rung, and an occupant
  whose ladder cuts to nothing never reaches the fit (decided once, in
  `reconcile`'s item construction).
- Treating "blank at this rung" as "this occupant is nothing" caused an endless
  flip
  ([research](../../../../research/2026-08-18-global-adaptive-bar-absent-rung.md)).
- Cutting a rung invalidates no widths (else rung 0 is `unbounded` and the row
  empties).
- A cut rung is never sat on again, so only a width change at the current rung
  grows the ladder back.
- A widget that can't render a form should stop declaring it (see
  `action-presentation`).

### Hysteresis, and the two things `assign` reads about the present

`assign` seeds everything at its widest rung and only demotes, then reads
`currentRung` for exactly two things:

- **freezing** a `pinned` item (live drag, open popup);
- **H1, the promote band** — all-or-nothing: if any item would end wider than
  its `currentRung` and the ideal lacks `hysteresisPx` of slack, every such item
  stays at its `currentRung`. (The design doc's "never reads `currentRung` for
  an unpinned item" is wrong.)

**A brand-new occupant is seeded at rung 0, never `null`.** `null` means
EVICTED; a `null` newcomer's first inline placement reads as a promotion and H1
keeps it out forever. Pinned in `web/__tests__/relocation.test.tsx`.

**H2 (`blocked`)**: a committed promotion measured as not fitting bars that rung
until the row is genuinely wider than the width that rejected it (stamped with
the width the *promotion* was decided at).

- Its evidence lives in `Episode`, and a premise shift discards it.
- The ledger (`core/blocked-rungs.ts`) keeps the widest width per (item, rung).
- A rung is barred when any rung *at or narrower* was rejected at an unbeaten
  width (never an exact `rung === r` match).

A bar ends when:

| when | why |
|---|---|
| the occupant's width moved at its current rung (`staleOthers`) | the content changed size |
| its ladder's rungs were re-declared, or it unregistered | a rung index only means something against a ladder |
| the row is genuinely wider than the recorded rejection | the terms are met |

The re-declare clause is gated on the rungs *really* changing: the declaration
effect re-runs on every rung change, and an ungated drop reopens the
promote-measure-demote cycle invisibly to every counter.

### What the driver does with `fits` and `usedEstimate`

Never collapsed into one boolean.

- `fits: false` (at the floor and still overflowing, or unbounded) is handled by
  CSS clip/scroll, not a branch.
- `fits` is read only by the row-overflow guard, on a **converged** pass (it
  measures the committed placement).
- `usedEstimate` does not gate that guard — an estimated `fits: true` is still a
  claim.

### `yieldRank`: higher yields sooner

- Highest rank demotes first.
- `"never"` is the lowest rank (last touched, not a hard pin).
- Ties go to the **later** item.

The search takes the eagerest occupant
**all the way to its floor** (compact, then out) before touching anyone else —
deliberately not round-robin.

### The `null` that is not a missing key

| state in the placement map | means |
|---|---|
| a number | the rung the last decision put it at |
| `null` | the fit deliberately took it out of the row |
| no entry | the last decision did not place it (newly mounted, or blank at every offered form) → rung 0 |

- Never `?? 0` (`null ?? 0` is `0`: evicted occupants reappear).
- `rungOf()` in `web/internal/adaptive-bar.tsx` is the one place this is
  decided; don't inline it.
- "No entry → rung 0" is safe only because a blank rung is never re-offered.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Overflow as relocation, not transformation: a bar that asks each widget for a smaller form of itself and moves the rest — as themselves, ONE live instance each, never rendered twice — into an always-mounted panel. Each occupant owns one stable portal container the bar re-parents imperatively, so a relocated slider is still the same slider mid-drag; measurement reads the real nodes, and every policy (which forms exist, how eagerly to yield) comes from the widget through action-presentation rather than from the host.
- Web:
  - Uses:
    - `primitives/action-presentation.ActionFormProvider`
    - `primitives/action-presentation.ItemFormChannel`
    - `primitives/css/fill.fillClasses`
    - `primitives/css/grow-relay.useRequestGrow`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.OverlayPanel`
    - `primitives/css/ui-kit.SingleLineProvider`
    - `primitives/css/ui-kit.useRegionForwardedAttrs`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/icon-button.IconButton`
    - `primitives/overlay/popup-open.PopupOpenScope`
    - `primitives/slot-render.SlotItemLayout`
    - `primitives/ui-context.collectLineage`
  - Exports (types):
    - `AdaptiveBarAlign`
    - `AdaptiveBarCollapsedProps`
    - `AdaptiveBarFault`
    - `AdaptiveBarFaultKind`
    - `AdaptiveBarItemProps`
    - `AdaptiveBarOverflow`
    - `AdaptiveBarProps`
    - `AdaptiveBarYieldProps`
  - Exports (values):
    - `AdaptiveBar`
    - `AdaptiveBarCollapsed`
    - `AdaptiveBarItem`
    - `adaptiveBarReportSink`
    - `AdaptiveBarYield`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/density --space-sm`
  - Imported by:
    - `apps-core/tab-bar`
    - `apps/prototypes/canvas`
    - `apps/sonata`
    - `conversations/conversation-view/prompt-templates`
    - `primitives/pane`
    - `reorder/node-types/overflow`
    - `reports/adaptive-bar`
- Exemptions:
  - Exempts itself from: `layout/no-adhoc-layout` — `web/internal/adaptive-bar.tsx` (sanctioned)
- Core:
  - Exports (types):
    - `AbsentRungs`
    - `BlockedRungs`
    - `ConvergenceEvidence`
    - `DockMove`
    - `FitInput`
    - `FitItem`
    - `FitResult`
    - `MeasuredWidth`
    - `MovedWidth`
    - `PremiseShift`
    - `Round`
    - `RoundItem`
    - `Span`
    - `WidthCache`
    - `WidthEstimate`
    - `WidthMeasurement`
    - `WriteRefusal`
    - `WriteResult`
  - Exports (values):
    - `assign`
    - `barRung`
    - `clearAbsentRungs`
    - `describeEvidence`
    - `dropItem`
    - `emptyBlockedRungs`
    - `emptyWidthCache`
    - `estimate`
    - `inlineWidthsFor`
    - `isAbsentRung`
    - `isBarred`
    - `isShifted`
    - `markAbsentRung`
    - `noAbsentRungs`
    - `offeredRungCount`
    - `overflowPx`
    - `passBudget`
    - `planMoves`
    - `premiseShift`
    - `pushRound`
    - `recordMoves`
    - `staleOthers`
    - `summarizeRounds`
    - `sweepBarred`
    - `unbarItem`
    - `widthKey`
    - `widthKeyItemId`
    - `write`
- Test helpers:
  - Web: `@plugins/primitives/plugins/adaptive-bar/web/testing`
    - `AdaptiveBarMeasure` — Test-only.
    - Types: `IsRendered`, `MeasureWidth`

<!-- AUTOGENERATED:END -->
