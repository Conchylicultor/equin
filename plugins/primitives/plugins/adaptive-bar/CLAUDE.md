# adaptive-bar

Overflow as **relocation**, not transformation: a bar that runs out of room asks
each widget to render a smaller form of itself, and moves the rest — as
themselves, one live instance, never a second render — into a panel.

Design doc: [`research/2026-08-16-global-adaptive-bar-relocating-overflow.md`](../../../../research/2026-08-16-global-adaptive-bar-relocating-overflow.md).

```tsx
<AdaptiveBar gap="xs" label="More actions">
  <SomeSlot.Render>
    {(item) => <AdaptiveBar.Item id={item.id}><Item {...item} /></AdaptiveBar.Item>}
  </SomeSlot.Render>
</AdaptiveBar>
```

The host names no contributor, declares no priority, hardcodes no width, and
renders no second copy. Every policy comes from the widgets, through
[`action-presentation`](../action-presentation/CLAUDE.md)'s `useActionForm` —
because a bar's occupants come from different plugins and it can name none of
them.

`align` is `"start"` (default) | `"end"` — which end of the bar's own slack the
occupants sit against. It is a prop and not a caller `className` for the same
reason as the rule below: the bar takes ALL the row's slack, so a consumer has no
way to answer "where in it" from outside, and reaching in with a raw `justify-*`
would fight the mechanics the bar owns. A trailing action cluster (a pane header)
wants `"end"`.

`spill` stops the bar clipping (`overflow-visible`), for a row holding something
that legitimately paints outside the strip — a pane header whose title is a
`CollapsibleWrap` expanding downward over the content below. The fit is
untouched: the clip was never the mechanism, only the backstop for a row with no
room left, and an over-full row already reports its own fault. A prop rather than
a caller `className` for the same reason as `align` — the overflow is one of the
mechanics the bar owns.

`<AdaptiveBar.Collapsed label>` is the same machinery with the width taken out:
every occupant relocates, unconditionally, for a slot whose layout config already
says "these live behind a `⋯`" — except when only ONE occupant is present on
that row (the rest rendered nothing): a menu holding one action is the action
plus a click, so that occupant stays inline at its full form and no `⋯` is
drawn. `overflow` is `"panel"` (default) | `"scroll"`
(nothing leaves; the row scrolls) | `"clip"`.

A slot rendered inside a bar composes through `.Render`, wrapped in whatever the
host likes: the bar declares `<SlotItemLayout orientation="host-owned">` around
its children so `slot-render` draws no cell of its own (the bar's container IS
each item's box), and it docks against the anchor's parent so the wrapper chain
between them is invisible.

`<AdaptiveBar.Item className>` puts classes on the occupant's own container,
which travels with it between the row and the panel — for a trait of the whole
occupant (a hover reveal) that a wrapper inside it cannot carry: a wrapper is an
element even when the widget renders nothing, so the occupant would never read
as empty. The container's rigidity is always kept.

## `<AdaptiveBar.Yield>` — the row's give

At most **one** child per bar that is excluded from the fit ledger: never
measured, never demoted, never relocated, and `min-w-0`
([`yieldClass`](../css/plugins/yield/CLAUDE.md)) instead of rigid. It absorbs
whatever the occupants leave and its inner `<Text>` ellipsizes, which is what a
pane title wants — a rigid title pushes the actions out of the row instead.

It is invisible to the math by construction, not by a flag: it never registers,
and the bar reads registered containers' rects.

`grow` makes it a `Fill` — it gives AND takes the row's leftover — which is what
a LEADING yielding child needs in an `align="end"` row: with no growing cell the
free space collects in front of everything, so a title would be packed against
the actions on the far edge instead of sitting at the row's start. Growing puts
the slack between the two, and a cell holding no content still holds the slack,
so a title-less header keeps its actions exactly where a titled one does. The
fit is untouched either way — `flex: 1 1 0%` contributes no width of its own,
and `min-w-0` surrenders the grow first.

Two of them would split the leftover between themselves and both ellipsize,
decided by their content rather than by the author — so a second one **throws**.
The reorder `spacer` node is the same family with the other half of `Fill`
([`grow`](../css/plugins/grow/CLAUDE.md)): it takes slack instead of giving it,
and needs nothing from this primitive.

### It gives down to a floor — **8em of its own font size**

A cell that can always give is a cell that pays for everyone. The occupants are
rigid, so flex takes the whole deficit out of the one child that can shrink;
while it can still give, the row does not overflow, `assign` sees a total that
fits, and **nothing is ever demoted or relocated**. That is not a corner case, it
is what a busy header does: the Sonata player's title rendered as "Une" at
1400px and was gone entirely at 900px while all ten of its widgets sat inline.

So the cell **reserves a floor out of the fit's budget** — the search is handed
`row content box − insetPx − yieldFloor` — and pressure past that floor is
therefore the row overflowing, paid for the ordinary way, by an occupant
relocating into the `⋯`. Above the floor nothing changes: the cell still absorbs
every pixel the occupants leave, so a roomy header is laid out exactly as it was
before the floor existed.

The floor is `8em` **of the cell's own computed font size**, not a pixel
constant, because what it protects is legibility — a count of characters — and
characters scale with the typography and density presets, which change at
runtime. A px constant would mean sixteen characters under one preset and ten
under another: the `MORE_BTN_W = 32` mistake in a different costume, and the same
reason `readRowMetrics` reads the row's gap off the rendered element. `ch` is the
more literal unit for "characters", but reading one costs an inserted element and
a reflow per pass, while `em` is in the computed style already and differs by a
constant factor this number is chosen in anyway. At the pane header's 14px, 8em
is ~112px — roughly 16 characters of a proportional UI sans, which is where a
truncated title still tells two panes apart. It is one number in the primitive
and not a prop: what makes a title legible is a property of text, not of the
surface hosting it.

Two edges, both pinned in `web/__tests__/row-inset.test.tsx`:

- **An empty cell reserves nothing.** A title-less header must land its actions
  exactly where it always did, so the floor is held back only while the cell
  renders something — judged by the same rule an occupant's container is judged
  by (`rendersNothing`: no text, and no element inside but `display: contents`
  wrappers). A title that arrives late says so
  through its own `MutationObserver`, for the reason an occupant has one: the
  row's width does not move when a title loads.
- **A row narrower than the floor** clamps the budget at 0 rather than going
  negative. A negative budget is not a narrower row, and `available <= 0` is the
  branch for "this is not a width" — which a merely-cramped row must never be
  sent down, since it latches. At 0 the fit seats nobody: every evictable
  occupant relocates, the `⋯` stays, and the cell keeps whatever the trigger
  leaves, below its floor, because there is nothing left to take it from.
  Narrowing further changes nothing, so there is nothing to oscillate.

The budget and the row's own width are kept as two numbers (`budget` and
`available` in `reconcile`) and must stay that way: the host-facing guards
(`no-slack`, the zero-width recovery, the grow-cell premise) ask whether the HOST
gave this bar a width, and they must not see a width the bar subtracted from
itself. Everything the search touches — the premise round, H2's barred rungs, the
best-so-far, the floor and surrender watermarks — is in the budget's currency, so
those comparisons stay in one currency across passes.

## The one rule for consumers

> **Put the bar where there is slack to give:** as the growing cell of a
> single-line row (`Line` / `Row` / `Bar`), with no `Fill` or other `flex-1`
> sibling competing for the same slack, and never inside a shrink-to-content
> parent (`inline-flex`, `w-fit`, `Cluster`). One adaptive bar per row.
>
> Every box between that row and the bar has to relay the grow, not just the
> shrink — a `min-w-0` wrapper is still shrink-to-content. **The bar asks for
> that itself**, so there is nothing to declare: `useRequestGrow` publishes the
> need from where the bar is rendered, and every relaying box between it and the
> row grows because it was asked
> ([`grow-relay`](../css/plugins/grow-relay/CLAUDE.md)). The `slot-render` cell
> and the reorder edit-mode wrapper are relays; `Line`/`Row`/`Bar` stop the ask,
> because they are the row it was about. `Fill` is neither: it grows already,
> and the ask crosses it for free.
>
> A wrapper the host hand-rolls is invisible to that chain and still swallows
> the grow — which is what the `no-slack` fault below is for, and why it prints
> how many boxes relayed the ask: `0` says nothing above the bar can give it
> room, `n` says everything visible relayed and the offender is a `<div>` to
> recompose onto `Fill`.

The last clause is the one that used to be only prose, and it is checked now:
a bar reads the registry of the bar above it, so a **measuring** bar mounted
inside another bar's occupant files `nested-bar` and stops deciding. An
`<AdaptiveBar.Collapsed>` nested in a bar is legitimate and never fires it — it
is one `shrink-0` `⋯` that measures nothing and asks for no slack, which is how
`reorder`'s `overflow` node type renders an authored bucket inside a pane
header.

This is a contract, not a styling preference. The bar declares itself
`min-w-0 flex-1`, so `barRoot.getBoundingClientRect().width` **is** the width it
was given — no ancestor walk, no mutate-reflow-restore, no forced style
recalculation per competing sibling. The fit's budget is that minus the root's
own padding and border (`readRowMetrics`'s `insetPx`), because the occupants are
laid out in the content box and `measureRowOverflow` judges them against that
same box; a consumer `className` carrying padding is all it takes to make the two
differ, so do not simplify the subtraction away. Pinned in
`web/__tests__/row-inset.test.tsx`. The primitive it replaces
(`responsive-overflow`) needed all of that machinery only because it chose a
content-sized container and then had to go looking for the width it had given
away.

Break the rule and you get told. Every fault files a report through
`adaptiveBarReportSink` (→ Debug → Reports via `reports/adaptive-bar`), and the
ones that mean the bar's own contract is broken also **throw in dev** — because
taking down a pane header over a layout disagreement is worse than a cramped row
plus an alert. The ones the bar has already handled correctly (`empty-rung`,
`iframe-relocation`, and the over-full row below) report without throwing and
without latching anything.

"In dev" is narrower than it sounds, and worth knowing before you go looking for
that throw in a browser: `import.meta.env.DEV` is compiled to `false` in every
built web artifact (`ARTIFACT_DEFINE` in
[`web-artifacts`](../../../framework/plugins/tooling/plugins/web-artifacts/core/internal/vite-builder.ts))
and in the layout-harness measurer page, which is a production Vite build too.
So the throw exists under vitest and nowhere else — in the deployed app, in the
Debug Exhibits gallery and in the geometry gate a fault is silent: `reportFault` plus
whichever layout the remedy commits.

The six faults:

- **no-slack** — it hides everything the row is holding, re-reads the row, and
  puts it back. A bar that was *given* its width measures the same either way;
  one whose host shrink-wraps to it measures its own content twice. That is the
  whole premise checked directly, and the reason it is not a style proxy:
  `flex-grow` is `1` in the failing case (the bar sets it on itself), and a
  parent that shrink-wraps to its child can never be overshot by it — so the
  shape reads as healthy on every cheaper test.

  A row that measures **0px while occupants are relocated out of it** is the
  other way in, and it is a *question*, never a verdict. Two filters and then a
  re-ask:

  **Does the row generate a box at all?** An element inside a `display: none`
  subtree generates none, and this app keeps whole surfaces
  mounted-but-not-rendered exactly that way in four places: an unfocused tab
  (`apps-core/surface`'s `surface-body.tsx`), the keep-alive fallback body
  (`apps-core/tab-surface`), a minimized or off-desktop floating window
  (`apps-core/surface/floating`), and a collapsed miller column
  (`layouts/miller`). Such a row was never *given* a width, so its 0 is not a
  reading at all — it is the absence of one, and the predicate that tells the
  two apart is `getClientRects().length > 0`, asked through the measurement seam
  (`isRendered`) and spelled exactly as `measureRowOverflow` already spells it.
  `visibility: hidden` is rendered and so still counts: layout is unchanged
  there, so the width is genuine. The distinction is not pedantry — a 0 standing
  in for "there is no answer" is an absorbable failure value (root `CLAUDE.md`),
  and the act at the end of this branch latches irreversibly.

  **And even a rendered 0px row is still two different things.** Either the
  ratchet has reached its end — the host shrink-wraps to the bar, so every
  eviction shrank the width that decided the next one, and the row has emptied
  itself — or the row is merely **over-full**: `flex-1` is `flex: 1 1 0%`, so
  when the row's *other* items over-fill their container, free space is negative
  and a cell with a base size of 0 has no basis on which to absorb a share of
  it, resolving to exactly 0px while fully laid out. Nothing is wrong with that
  host; there is simply no room at this width, and there will be again when the
  row widens. The probe at the top of this bullet is the guard that can tell
  them apart — it is correctly silent for the over-full row, because hiding the
  occupants cannot change a width that comes from free space — but it needs
  occupants in the row to hide, which is exactly what the ratchet has run out
  of.

  So the bar does not guess — it runs the experiment. It **re-admits everything,
  clears the premise watermark and reserves a probe**, and the very next pass
  splits the two: a shrink-wrapping host now measures its own content, so the
  probe runs and faults in the words that name the defect and latches; an
  over-full row measures nothing again but has nothing evicted any more, so
  nothing is latched and the bar decides again the moment the row has room.

  Both answers are said out loud, and only the first commits anything. The
  over-full answer is a `reportFault` — no throw, no latch — because at 0px with
  `overflow-hidden` every occupant *and* the `⋯` are clipped to invisibility,
  and a surface showing nothing with nothing filed is the outcome these guards
  exist to prevent. It is filed once per mount, and only after a recovery has
  actually happened, which is what makes it evidence rather than a guess.

  The recovery **defers while a gesture holds an occupant** (`holds`,
  `popupOpen`, `pointerPinned` — deliberately not `immovable`, which never
  clears): re-admitting is a re-parent, and doing it under a live pointer is the
  gesture-killing move the pointer lock exists to prevent. Every release bumps,
  so it is deferred, never dropped. It is bounded by `MAX_ZERO_RECOVERIES`,
  which is also where the honest termination argument is written down — and it
  is not the one you would guess.

  Asked **per width**, not once per mount: the premise is a property of the
  *host*, and a host changes under a mounted bar — a framing variant swaps, a
  wrapper's class flips, contributions arrive in a later plugin wave, or a
  shrink-to-content ancestor whose width was floored by a wider sibling stops
  being floored once the bar's own content grows past it. So it is re-asked
  whenever the row is narrower than the width it was last verified at, which is
  the ratchet's own direction — an eviction only ever reduces what the row
  holds — and bounded by `MAX_SLACK_PROBES`, because the probe is a forced
  reflow and a narrowing drag produces one every frame. A report can therefore
  arrive long after mount and name a host that broke later.
- **nested-bar** — a MEASURING bar was written inside another bar's occupant.
  Read from the tree rather than from a width: the inner bar sees the outer
  bar's registry through `BarRegistryContext`, at mount, before anything is
  measured. Two measuring bars in one row are two claimants on the same slack —
  each is `min-w-0 flex-1` and each asks the chain above it to grow — so the
  inner one takes all of it and the OUTER one is left measuring its own content.
  That is why the fault exists as its own kind: what the outer bar files is
  `no-slack`, a true sentence about a host that is fine, and the row's yielding
  cell (a pane title) crushes to its first word while the inner bar sits at full
  width. The remedy is `no-slack`'s — the ceiling, latched — because a bar
  inside another bar's occupant is inside a `shrink-0` container, so every width
  it reads is its own content's.

  `AdaptiveBar.Collapsed` is excluded, and the exclusion is not a carve-out: it
  measures nothing and takes no slack, so it is not a claimant. Both directions
  are pinned in `web/__tests__/nested-bar.test.tsx`. The bar also declines to
  measure at all while nested (`reconcile` returns beside its `degraded` check),
  because a state update made in an earlier layout effect of the same commit is
  invisible to that pass — without it the inner bar spends one pass filing
  `no-slack` about the container it is in, one commit before the fault that
  names what is really wrong.
- **row-overflow** — the fit says everything fits and the rendered row still
  overflows the box the bar was given. Measured as the union of the occupants'
  own boxes against the bar's own content box (`measureRowOverflow` +
  `core/overflow.ts`), and two simpler spellings are both wrong, so do not
  "simplify" it back to either. An **ancestor** comparison: `offsetParent` is
  the nearest *positioned* ancestor, not the row the bar is a cell of — a bar in
  a scrolled strip fits its row perfectly while sitting far outside it — and
  `parentElement` is no better, since the parent may shrink or carry padding.
  **`scrollWidth > clientWidth`**: LTR scrollable overflow ignores content past
  the *left* edge, so an `align="end"` row (every pane header) reads them equal
  while overflowing by 16px, and it folds in descendants' overflow, so a
  widget's own transform becomes a false accusation. `scroll` mode skips the
  guard: there, overflowing IS the contract.
- **no-convergence** — the round budget ran out and the answer was still moving.
  See *A round is only a round of the same question* below, which is most of
  what there is to know about this one.
- **empty-rung** — a widget declared a smaller form and then rendered **nothing**
  as it. The only fault about the *contributor* rather than the host or the
  browser, and the only one that never throws in dev: a widget rendering nothing
  for one frame while its data loads must not take a pane down. The bar recovers
  by itself (it stops offering that form — see *A form a widget does not render
  is not a form it has* below), which is exactly why it has to say so. A
  contribution that renders nothing **at all** is ordinary and is reported
  nowhere. In `panel` mode the widget ends up behind the `⋯` rendering as
  itself; in `clip` mode it ends up in the hidden parking dock, i.e. invisible —
  which is the same outcome its blank form was already producing, but worth
  knowing before reading a report from a `clip` bar.

Of the two engine-facing guards only **`row-overflow`** is gated on a real
layout engine (`layoutMeasured`), so it never fires in jsdom. `no-slack` is not
gated at all: it is a *differential* measurement taken through the measurement
seam — two readings of the same row, one holding its occupants and one not — so
two equal readings in jsdom say "the width does not follow the content", which
is a true answer and the reason the jsdom suite can drive the guard
deliberately (`web/__tests__/no-slack.test.tsx`). Its 0px branch is drivable
there for the same kind of reason: jsdom returns `[]` from `getClientRects()`
for every element, so `AdaptiveBarMeasure` defaults `isRendered` to `() => true`
— a supplied width IS a width something gave the row — and calling the DOM
predicate directly instead of through the seam would have made that branch dead
code in the one suite that can reach it.

Every fault carries **who it is about**: `label` is the name the consumer gave
the bar, and `origin` is the innermost UI-context node above the bar's root
(`apps-core.tab-bar@apps.tab-bar`). The label alone is not an identity — it
defaults to `"More"` and two unrelated bars on one route take that default — so
`origin` plus `overflow` is what the report fingerprints on. Both are read from
the DOM at fault time and cost nothing on the hot path.

**The remedy differs by fault, and the kinds must not be merged.** `no-slack` can
trust nothing it measures, so it takes the **ceiling** (everything inline, CSS
clips) and latches for good: eviction is the one thing a bad width reading must
not do, since it is what that reading was already producing. Its 0px branch has
a third remedy the others have no spelling for — the ceiling **without** the
latch — because there the bar is not yet accusing anyone, it is re-asking. And
its over-full answer commits nothing at all: it is a report about a row that is
already recovering.

`row-overflow` and `no-convergence` have an honest width and a search that
disagrees with the engine — but not in the same way, so they do not commit the
same thing:

- `row-overflow` takes the **floor**: every unpinned occupant at its narrowest
  rung. The fit's own arithmetic has just been contradicted by the engine, so
  "the widest placement the fit blessed as fitting" is exactly the claim under
  suspicion.
- `no-convergence` takes the **best answer the search actually produced** — the
  widest placement it measured (never estimated) as fitting, at this width — and
  only falls back to the floor when it never produced one. A search that runs
  out of rounds has usually blessed several perfectly good placements along the
  way, and throwing all of them away is what made a transient fault cost the
  user their whole toolbar.

In `clip` mode the floor never evicts, whichever fault reached it: `clip` drops
its evictions into a hidden parking dock, so flooring a clip bar hides
everything it holds — strictly worse than the clipping that mode already
accepts.

Committing and stopping are **one act** (`commitSurrender` latches), so "take
the fallback and keep searching" has no spelling. The zero-width recovery is not
a counter-example, and the difference is worth being precise about: it commits
the search's *input* (everyone back in the row), not an answer, and the next
thing to read that input is the probe rather than the fit — so the loop this
doctrine prevents, where the fit recomputes the same answer and trips the same
guard, has nothing to run on. Without that latch the commit
re-runs the pass, the fit recomputes the same answer and commits again forever
(both the convergence branch and the commit reset the round counter, so the
budget counted a number being zeroed underneath it). Scoped to the width and not
the mount, because a genuine resize is a premise the bar has not failed under;
capped by `MAX_SURRENDERS`. A stopped bar still DOCKS. Proof:
`web/__tests__/termination.test.tsx`.

## A round is only a round of the same question

`reconcile` runs for four reasons — the bar committed a placement, the row was
given a different width, an occupant mounted/unmounted/re-declared, an
occupant's own width moved — and only the first is a round of the search.

So each pass records its **premise** (the row's width, the ordered occupant ids
and ladder depths, every occupant's measured width) and compares it with the
previous pass's. When the premise moved, the round counter starts again: the
rounds before it were about a row that no longer exists.

The width clause counts **only a width that moved at a rung the item was already
sitting at**. That restriction is the whole correctness argument — an occupant
that just changed rung is *supposed* to measure differently, and counting it
would reset the counter on every round of the bar's own chain, removing the bound
entirely.

Three counters, three diagnoses, one remedy — and the fault says which tripped:

- **`rounds`** vs `passBudget(items)` — the search's own cost, derived from the
  steps this row has to give (each item's remaining rungs, plus one if it can
  leave), clamped to `[4, 16]`. Not a constant: the constant it replaces was 4,
  and a cold start costs 2 rounds, a late-arriving ladder a third and hysteresis
  a fourth. The fifth was a filed fault, which is what this whole section is
  about.
- **`shifts`** vs `MAX_PREMISE_SHIFTS` — the widths under this bar never stopped
  moving. A real pathology, but not the fit's fault, and worth saying in those
  words.
- **`total`** vs `HARD_ROUND_CEILING` — rounds since the last settled answer, and
  **nothing resets it**. This is the termination guarantee, and it is what makes
  the resettable counter safe: `reconcile` re-enters itself *synchronously*
  through its layout effect, so a widget that resizes itself on every commit
  (`:hover` is recomputed when a container is re-parented out from under the
  pointer; a widget with its own measuring layout effect re-measures when its
  parent re-renders) would otherwise reset `rounds` forever and take the pane
  down with React's nested-update limit.

The fault carries **evidence**, because this one is frequently transient and a
transient that records nothing can never be diagnosed: the round trace is
summarised into which occupants moved (id, rung, from → to px), the distinct row
widths the episode decided from, the three counters, and whether a placement the
search had already produced came back (a cycle in the fit, as opposed to a
premise that keeps moving). It reaches Debug → Reports through
`reports/adaptive-bar`.

## Why one stable container per item

Each occupant gets one plain `<div>`, created once in a `useState` initializer
and owned for the item host's whole life. React always renders the widget through
`createPortal(children, thatDiv)`; placement is then a **DOM operation on a node
React does not own**. React never sees the move, so the widget is never
unmounted, never re-instantiated, and — the point — never rendered a second time
to be measured.

The container must be minted once and never replaced, and that is a reconciler
rule rather than a matter of taste: React reconciles a portal by **container
identity**. Swapping a host element for a portal at the same position, or
changing a portal's container, deletes the subtree and builds a new one. Measured
both ways in
[`viewport-overlay`](../css/plugins/viewport-overlay/web/__tests__/portal-toggle-remounts.test.tsx),
whose `no-portal-toggle` rule bans the shape.

Everything ancestry-derived that a portal severs — theme scope, plugin lineage,
pane id — is stamped onto the container **imperatively and unconditionally**, not
at move time. It is the REGION bag (`useRegionForwardedAttrs`), not the popup
one: an occupant is part of its row's region, so it keeps a sub-theme a popup
would drop — without that, a page's header items revert to UI sizes. A move-time branch is a branch that can be wrong, and the symptom
would be a widget that renders in the wrong palette only after it has been
relocated once.

## What survives a re-parent, and what does not

`moveBefore` — the state-preserving move — fixes all of this. It is not
everywhere yet, and `tauri/` ships WebKit on macOS, so the fallback path is
written out and repairs what it can:

| | plain `insertBefore` | `moveBefore` | what the bar does |
|---|---|---|---|
| `<iframe>` | **reloads** | preserved | detects one and **refuses to relocate**, loudly — never silently reloads |
| focus | lost | preserved | snapshots `activeElement`, refocuses `{preventScroll:true}` |
| pointer capture | released | preserved | why the pointer lock is mandatory, not a nicety |
| top layer (open popover) | dropped | preserved | why the popup lock is mandatory |
| inner scroll offsets | reset | preserved | snapshots and restores the non-zero ones |
| CSS transitions | restart | preserved | never animate a bar item; animate the panel |
| `:hover` | recomputed | recomputed | not restorable — documented, not fixed |
| `position: sticky` | new containing block | same | **unsupported inside a bar item** |

The corollary is why **a node already in the right place is never touched**: each
still-inline container is docked immediately before its own anchor and skipped if
it is already there, and the panel's order is an LIS diff (`core/dock-plan.ts`),
so an unchanged order plans zero moves. A resize that relocates one widget leaves
the other six — their focus, their transitions, their scroll offsets — alone.

## Order is an input, and it comes from the DOM

Each item host renders a `hidden` anchor `<span>` at its natural position in the
host's own children, and the bar reads document order off those anchors. That is
not a convenience: the host may render its items through a slot whose reorder
middleware sorts them, wrapped in whatever containers it likes, and the DOM
already knows the answer. A registry keyed on mount order gets a mid-list
insertion wrong; a consumer-supplied order list is a second source of truth for
something nobody has to be told.

`hidden` means `display: none`, which means the anchor is not a flex item — no
width, and (the half that is easy to miss) no gap. The same trick carries
absence: an occupant that rendered nothing is `hidden`, so it costs no gap
either, and it is never eligible for the panel.

**The anchor's own parent is what decides placement** — not the bar root. A
container is docked immediately before its anchor, *wherever the anchor sits*,
and "still in the row" is asked as "is this container immediately before its own
anchor" (`isDockedInline`) rather than "is it a child of the root". The root was
an assumption, and it is false for every host that renders items through a slot:
between the bar and a contribution rendered by `.Render` sit `slot-render`'s box
and reorder's `SortableItem` + content wrapper, all three `display: contents`
outside edit mode. `display: contents` removes a box from LAYOUT but not from the
DOM TREE, so the container is still a flex item of the row — gap and measurement
unchanged — while the anchor is two or three levels down.

That is also why **rigidity is declared by each rigid thing rather than by the
row**. `[&>*]:shrink-0` on the root would stop reaching the containers through
that chain, and a squeezable occupant is the proven blind-the-guard failure (see
*An occupant's width is its own* below). So each minted container carries
`rigidClass()` itself, and so does the `⋯` trigger. The reorder `spacer` needs
nothing: `flex: 1 1 0%` with no content has no width for a shrink to take.

`hidden` and the blank-rung ledger are two different facts and neither is
derivable from the other, so do not try to collapse them: **`hidden` is a layout
fact** — does this generate a box right now, which is what buys the no-gap
property — and **the ledger is a decision fact** — may the bar offer this rung at
all. They are allowed to disagree for exactly one pass, which is the pass that
learns. That replaces
`action-presentation`'s old `probe` mode, which answered the same question by
instantiating every member a second time to draw nothing and be counted. A
`MutationObserver` on each container carries the signal back, because a
`display: none` element reports no resize when content appears inside it — so the
shared `ResizeObserver` can see a widget stop rendering but not start again.

## The panel is always mounted

"Closed" is `display: none` + `inert` + `aria-hidden`, never an unmount. The
panel holds the live DOM of relocated widgets, and `Popover` /
`DropdownMenuContent` both destroy their content on close — which would orphan
every container and kill the single instance this primitive exists to preserve.
So it composes `ViewportOverlay` + `OverlayPanel` + Floating UI directly: the
same three pieces `floating-surface` composes, but not `FloatingSurface` itself,
which returns `null` when closed.

It is a plain **dialog**, and nothing about it is derived from its occupants. A
`role="menu"` is wrong twice over: menu content unmounts, and inside a menu the
roving tabindex and typeahead eat the arrow keys a relocated `role="slider"`
needs. `inert` is load-bearing too — without it a parked slider stays focusable
and Tab drops the user into an invisible control.

The panel closes on the trigger, `Esc`, an outside pointer-down, and **becoming
empty**. A resize never closes it.

## Two locks, neither of which anyone opts into

React synthetic events bubble the **fiber** tree, not the DOM tree, so the bar's
own root sees a pointer-down inside a widget that physically lives in the
body-portaled panel. That is what makes both locks contract-free:

- a pointer down inside an occupant pins it for the whole gesture (with a
  document-level release as the fail-safe, because a pointer-up outside the bar
  reaches no React handler and a permanently pinned item is worse than a moved
  one);
- `PopupOpenScope` around each item pins one whose own popover is open.

`useHoldShrink` is left to cover only what survives the release — an inertial
fling's coast. A pinned item is frozen where it is and the bar re-fits everything
*around* it; the target placement is **stored, not discarded**, and the release
itself triggers the pass, so "deferred forever" is unrepresentable.

## The honest costs

- **The panel is Tab + Enter + Esc.** No typeahead, no arrow-key roving. A
  regression against a real `DropdownMenu`, and the price of hosting a live
  slider.
- **Entering or leaving reorder edit mode remounts every occupant.** In edit mode
  the bar renders everything inline in React's own tree, because dnd-kit handles
  re-parented out of their `SortableContext` are handles that silently do
  nothing. Crossing that edge means crossing the portal, and the portal *is* the
  identity-preserving mechanism — there is no version of this that keeps the
  instance. It is a deliberate user gesture, not a resize.
- **A placement change re-renders every occupant.** A rung is React state, so the
  bar must re-render for a widget to change form; there is no way to re-render
  only the one that moved.
- **One always-mounted `document.body` child per bar**, plus one hidden parking
  dock inside it.
- **The trigger is measured once by revealing it.** It is `hidden` while nothing
  is evicted, so the first fit has nothing to read; it is un-hidden, measured and
  re-hidden inside one synchronous block. One forced reflow, once per bar — and
  still better than the `MORE_BTN_W = 32` it replaces, which is simply wrong at
  any other control density. The no-slack probe is the same hide-measure-restore
  discipline, and costs one reflow each time the row narrows past the width its
  premise was last verified at — up to `MAX_SLACK_PROBES` of them per bar.
- **`degraded` latches per mount.** Nothing clears it but a remount, so a false
  `no-slack` costs that surface the whole relocation behaviour until it is torn
  down and rebuilt — which is why the 0px branch is held to a higher standard
  than the others: it asks whether the row generates a box before it accuses
  anyone, and then re-admits and re-asks rather than accusing on a number that
  cannot carry the answer. Each re-ask costs the re-admitted layout for one pass
  and one extra probe reflow, up to `MAX_ZERO_RECOVERIES` of them per settled
  answer.
- **`overflow="clip"` can silently drop a widget.** Kept because
  prompt-templates needs it and has a second route to the content. If it starts
  papering over layout bugs, the fix is a lint rule demanding a named reason, not
  a stricter default.

## Where the claims are proven

Four kinds of suite, because no one of them can carry the whole thing:

| where | what only it can prove |
|---|---|
| `core/*.test.ts` (bun) | the fit math, without a layout engine |
| `web/__tests__/` (jsdom) | React never unmounted the subtree; the pins; the panel's dock survives a close |
| `exhibits/index.ts` → `./singularity check layout-geometry` | the boxes do not collide and nothing spills, under a real layout engine, across a width sweep |
| `e2e/adaptive-bar-relocate.ts` (manual) | **a relocated slider still drags**, and comes back as the same instance |
| `e2e/adaptive-bar-hidden-host.ts` (manual) | a bar hidden with `display: none` and shown again is **still deciding** |
| `e2e/adaptive-bar-overfull-row.ts` (manual) | a bar whose row is over-filled until its cell resolves to 0px is **still deciding** once the row has room again |

jsdom has no layout engine and the shared `ResizeObserver` stub is inert, so the
jsdom suite supplies widths through `AdaptiveBarMeasure` — the primitive's own
measurement seam. Everything else (the fit, the docking, the pins, the panel)
runs exactly as it does in a browser. **`AdaptiveBarMeasure` is test-only** (published from `web/testing`): a
consumer that "adjusts" measurement is lying to the layout engine about a number
the layout engine owns.

The layout-harness fixture is the proof surface for the rich case, because every
production surface reachable today is made of plain actions and none of them
exercises the premise — *a draggable widget relocates and is still draggable*.

### Driving a bar occupant from another plugin's e2e script

What a bar relocates depends on the viewport, so a script clicking a toolbar
control by role breaks at whichever width moves it into the closed `⋯` panel
(still mounted, but `display: none` + `aria-hidden`: invisible to role locators,
unclickable). Use `reachInBar(page, control, act)` from
`@plugins/primitives/plugins/adaptive-bar/e2e` — it runs `act` in the row, or
after opening the `⋯` holding the control (closed again after). Read a
relocated control's text through a CSS locator; it still matches in the closed
panel.

---

## `core/` — the pure decision math

No DOM, no React, so it is exercisable without a layout engine.

| module | answers |
|---|---|
| `core/fit.ts` | which rung each item renders at, and who leaves the row |
| `core/width-cache.ts` | what each item measured at each rung, and how much we trust it |
| `core/blocked-rungs.ts` | which rungs a failed promotion barred, and until what width |
| `core/absent-rungs.ts` | which rungs an occupant renders nothing at, so they are never offered |
| `core/dock-plan.ts` | the fewest DOM moves that turn one dock order into another |

### The six rules worth knowing before you touch this

**An occupant's width is its own** — a property of the item and its rung, never
of how many neighbours it has. That is what `exact` claims, and it is discharged
by **`rigidClass()` on every minted container** (`bar-item.tsx`).

A pass measures the placement React has ALREADY committed, so an over-full row
is the normal mid-search state. Let the engine take the deficit out of the
occupants there and the squeezed number is stored as `exact` — sticky, since an
item is only re-measured at the rung it sits at — the row-overflow guard goes
blind (the occupants now sum to exactly the content box), and `assign` compares
that same sum against the same width and stops demoting.

Which occupants can that happen to is subtler than it looks, and worth knowing
before assuming a widget is safe. A container is a flex item with
`min-width: auto`, so its floor is its own min-content; the row is
`whitespace-nowrap`, so a text run cannot break and its min-content IS its
natural width. `min-w-0` inside a widget does not change that — it lets the leaf
be smaller, not the box the bar measures. So today's occupants (buttons, chips,
labels) happen to be unsqueezable, and a widget whose content can reflow
narrower — a wrapping sentence, a percentage-sized image — is not. The
declaration is what makes it not depend on that accident.

On each occupant, not on the row: a `[&>*]` selector reaches direct children
only, and a container is docked at its anchor — through a slot's wrapper chain
that is not a child of the root. The `⋯` trigger declares its own for the same
reason it always needed one (`measureTrigger` **caches** its width, so a single
squeezed reading under-reserves it forever). The container carries the
declaration into the panel's column too, where `flex-shrink` is about height —
harmless there, since the panel is content-height and has no deficit to take.

Proven under a real engine by `adaptive-bar/squeezable-occupants` in
`exhibits/`, whose occupants opt back into wrapping precisely so they CAN be
squeezed — remove the declaration and all four collapse 186px → 83px.

**Only an inline item is measurable.** A width read while the widget sits in the
panel describes the panel, so `write` refuses it outright. That single asymmetry
is why the rest of the ledger exists: everything not currently rendered inline is
inference.

**An estimate may refuse a fit; it may never fabricate one.** An unmeasured rung
is bounded by the nearest *wider* measured rung — a narrower form is never wider
than a wider one, so that is an upper bound. When there is no wider measurement
at all there is no bound, and `assign` reports `fits: false` rather than
substituting a 0. `usedEstimate` is how a caller tells "fits" from "probably
fits"; do not collapse them.

**One estimated step per pass.** An item whose next rung is a guess is demoted at
most once per `assign` call. Without the cap, a chain of guesses would relocate a
widget that compaction alone would have saved — and the mistake is unlearnable,
because a panelled widget is never measured again. The cost is one extra pass on
the first overflow of a session.

**A node already in the right place is never touched.** `planMoves` is an LIS
diff, not a re-append: an unchanged order plans zero moves. Every avoided move is
a preserved focus, pointer capture, CSS transition and inner scroll offset.

**A form a widget does not render is not a form it has.** "Renders nothing" is a
fact about an occupant AND a rung — read from the DOM (an empty container) at
whatever rung it is currently sitting at — so `core/absent-rungs.ts` records it
per rung, and the ladder handed to `assign` is the declared one **cut short** at
the first blank rung. The fit therefore cannot put a widget where it vanishes,
and an occupant whose ladder cuts to nothing is not an occupant: it never reaches
the fit, which is decided in one place (`reconcile`'s item construction) and
repeated nowhere.

Reading that narrower fact as the wider one ("this occupant is nothing") is what
made the bar flip for ever: `assign` dropped an absent item from the placement
("nothing to place"), `rungOf` read the hole as rung 0 ("never placed"), the
widget rendered its full form, the fit demoted it back to compact, and round one
came round again. Both readings were right; the conflation was not. See
[`research/2026-08-18-global-adaptive-bar-absent-rung.md`](../../../../research/2026-08-18-global-adaptive-bar-absent-rung.md).

Two things about a cut ladder are easy to get wrong. **Nothing about the widths
is invalidated when a rung is cut** — downgrading them leaves rung 0 with no
wider rung to bound it, `assign` reports `unbounded`, and the search empties the
row around a widget it can no longer size. And **the cut rung is never sat on
again**, so "it renders there after all" is unobservable: the only thing that can
grow a ladder back is the occupant measuring differently at the rung it *is* on,
which is where the clearing lives. A widget that cannot render a form right now
should stop declaring it — that is the recovery path with no round-trip, and
`action-presentation` documents it.

### Hysteresis, and the two things `assign` reads about the present

`assign` computes a current-state-independent ideal — it seeds everything at its
widest rung and only demotes — and then reads `currentRung` for exactly two
things:

- **freezing** a `pinned` item (a live drag, an open popup);
- **H1, the promote band**, applied to the ideal as one all-or-nothing guard: if
  any item would end wider than its `currentRung` and the ideal total lacks
  `hysteresisPx` of slack, *every* such item goes back to its `currentRung`. So a
  one-pixel resize cannot flip the row back and forth. Outside the band the
  answer ignores placement entirely.

(The design doc says `assign` never reads `currentRung` for an unpinned item.
That sentence is wrong and is being corrected: hysteresis *is* direction
dependence, and direction can only come from current state.)

**This is why a brand-new occupant is seeded at rung 0 and never at `null`.**
`currentRung: null` means EVICTED — there is no third state for "unknown". Seed a
newcomer at `null` and its first inline placement reads as a promotion, so H1
holds it out of the row until the bar grows by a further `hysteresisPx`: a freshly
contributed action that simply never appears. Pinned in
`web/__tests__/relocation.test.tsx`.

`blocked` (H2) is the same idea for a promotion that was *committed* and then
measured as not fitting: that rung is barred until the row is genuinely wider
than the width that rejected it.

Both halves of it are **scoped, not kept**. The evidence (what the last
committed pass promoted into, and the width it decided at) lives in `Episode`
beside the counters, and a premise shift discards it — the shift check runs on
every deciding pass, so it covers `reconcile`'s early returns without
enumerating them. The bar is stamped with the width the *promotion* was decided
at, never the current pass's.

The ledger (`core/blocked-rungs.ts`) keeps the widest width per (item, rung), and
a rung is barred when any rung *at or narrower than it* was rejected at a width
the row has not beaten: inline widths are monotone, so a rejection at a narrow
rung is one at every wider rung. An exact `rung === r` match would let the fit
promote straight past the form it just learned does not fit. Three things end a
bar:

| when | why |
|---|---|
| the occupant's width moved at the rung it was sitting at (`staleOthers`) | the rejection was about content that has since changed size |
| its ladder's rungs were re-declared, or it unregistered | a rung index only means anything against a ladder |
| the row is genuinely wider than a recorded rejection (once per pass) | the bar's own terms are "until the row is wider" — met, so discharged rather than dormant |

The ladder clause is gated on the rungs *really* changing, and the gate is
load-bearing: an item's channel carries its assigned form, so its declaration
effect re-runs on every rung change, and an ungated invalidation would drop the
bar one passive effect after the pass that installed it — reopening the
promote-measure-demote cycle, one converged episode at a time, with no counter
able to see it.

### What the driver does with `fits` and `usedEstimate`

Not a lot, deliberately, and the two are never collapsed into one boolean.
`fits: false` means the row is at its floor and STILL overflows (or a width has
no bound at all) — but the bar already clips or scrolls by CSS, so that outcome
is handled structurally rather than by a branch. The one place `fits` is read is
the row-overflow guard, and only on a **converged** pass: `measureRowOverflow`
measures the row as *rendered* — the union of the occupants' boxes against the
bar's own content box — which is the committed placement, so checking it
against a placement we are about to commit would report a disagreement between
two different configurations — and throw over it in dev.

`usedEstimate` deliberately does not gate that guard. An estimate is an upper
bound, so it can refuse a fit but never fabricate one; a `fits: true` reached
through estimates is still a claim that the row fits, and a row-overflow still
contradicts it.

### `yieldRank`: higher yields sooner

The highest-ranked item is demoted first. A widget that declared itself eager
gets a high rank; `"never"` maps to the lowest rank, so it is the last thing the
bar touches — not a hard pin. Ties go to the **later** item in bar order.

One consequence is a genuine design choice and worth stating out loud: the search
takes the eagest occupant **all the way to its floor** — compact, then out of the
row — before it asks anyone else for anything. The alternative (one step each,
round-robin) leaves every widget half-shrunk instead of most of them intact.

### The `null` that is not a missing key

The web half's placement map has three states, and two pairs of them have each
been confused once:

| state | means |
|---|---|
| a number | the rung the last decision put it at |
| `null` | the fit deliberately took it out of the row |
| no entry | the last decision did not place it |

`?? 0` collapses the middle into the last — `null ?? 0` is `0` — which puts every
evicted occupant straight back in the row and makes the bar look like it never
overflows at all. `rungOf()` in `web/internal/adaptive-bar.tsx` is the one place
that distinction is made; do not inline it.

"No entry" is itself two situations — an occupant that mounted since the last
decision, and one that renders nothing at every form it was offered — and both
correctly want rung 0, because in both cases nothing has been decided and the
widget's own output decides what happens next. That is safe **only** because a
blank rung is never offered again (the rule above). Undo that and the default
becomes the flip: rendered → demoted → blank → dropped → read as rung 0 →
rendered.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

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
    - `primitives/edit-mode-signal.useEditMode`
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
    - `ui/tokens/shape --spacing`
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
