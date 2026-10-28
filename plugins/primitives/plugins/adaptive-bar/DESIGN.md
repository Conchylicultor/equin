# adaptive-bar — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

Full design doc: [`research/2026-08-16-global-adaptive-bar-relocating-overflow.md`](../../../../research/2026-08-16-global-adaptive-bar-relocating-overflow.md).

## API

Every policy comes from the widgets because a bar's occupants come from
different plugins, and the bar can name none of them.

- **`align` is a prop, not a caller `className`.** The bar takes ALL the row's
  slack, so a consumer cannot answer "where in it" from outside; a raw
  `justify-*` reaching in would fight the mechanics the bar owns.
- **`spill` leaves the fit untouched** because the clip was never the
  mechanism — only the backstop for a row with no room left, and an over-full
  row already reports its own fault. A prop for the same reason as `align`.
- **`Collapsed` with one occupant stays inline**: a menu holding one action is
  the action plus a click.
- **`Item className` instead of an inner wrapper**: a wrapper is an element even
  when the widget renders nothing, so the occupant would never read as empty
  (and never be hidden, gap included).

## `<AdaptiveBar.Yield>` — the row's give

- It is invisible to the math **by construction, not by a flag**: it never
  registers, and the bar reads registered containers' rects.
- A second Yield throws because two would split the leftover between themselves
  and both ellipsize — decided by their content rather than by the author.
- `grow` leaves the fit untouched: `flex: 1 1 0%` contributes no width of its
  own, and `min-w-0` surrenders the grow first. Without a growing cell in an
  `align="end"` row, the free space collects in front of everything and a title
  is packed against the actions on the far edge.

### It gives down to a floor — **8em of its own font size**

Why a floor: the occupants are rigid, so flex takes the whole deficit out of the
one child that can shrink. While it can still give, the row never overflows,
`assign` sees a total that fits, and nothing is demoted. This is what a busy
header does, not a corner case: the Sonata player's title rendered as "Une" at
1400px and vanished at 900px while all ten widgets sat inline.

Above the floor nothing changes — the cell still absorbs every pixel the
occupants leave.

Why `em`, not px:

- What the floor protects is legibility, a count of characters, and characters
  scale with the typography and density presets, which change at runtime.
- A px constant would mean sixteen characters under one preset and ten under
  another — the same mistake as a hardcoded trigger width, and the reason
  `readRowMetrics` reads the gap off the rendered element.
- Rejected: `ch`. More literal, but reading it costs an inserted element and a
  reflow per pass; `em` is already in the computed style and differs by a
  constant factor the number is chosen in anyway.
- ~16 characters of a proportional UI sans is where a truncated title still
  tells two panes apart.

Why not a prop: what makes a title legible is a property of text, not of the
surface hosting it.

Edges:

- **Empty cell reserves nothing** so a title-less header lands its actions
  exactly where it always did. A late title needs its own `MutationObserver`
  because the row's width does not move when a title loads.
- **Budget clamps at 0** because a negative budget is not a narrower row, and
  `available <= 0` latches — a merely cramped row must never be sent there. At
  0 the `⋯` stays and the cell keeps whatever the trigger leaves; narrowing
  further changes nothing, so there is nothing to oscillate.

Why `budget` and `available` stay two numbers: the host-facing guards ask
whether the HOST gave this bar a width, and must not see a width the bar
subtracted from itself. The search's comparisons must stay in one currency
across passes.

## The one rule for consumers

Why the contract instead of measuring: with the bar `min-w-0 flex-1`, its own
rect is its given width.

- Rejected: a content-sized container. It then has to go looking for the width
  it gave away — an ancestor walk, mutate-reflow-restore, a forced style recalc
  per competing sibling.
- Do not drop the `insetPx` subtraction: a consumer `className` carrying padding
  is all it takes for the fit's box and `measureRowOverflow`'s box to differ.
  Pinned in `web/__tests__/row-inset.test.tsx`.

**One bar per row** is checked (`nested-bar`), not just prose — see Faults.

## Faults

**Why throw only in dev, and report otherwise:** taking down a pane header over
a layout disagreement is worse than a cramped row plus an alert.

**no-slack.**

- **Why a direct probe, not a style proxy:** `flex-grow` is `1` in the failing
  case (the bar sets it on itself), and a parent that shrink-wraps to its child
  can never be overshot by it — so the shape reads healthy on every cheaper
  test.
- **Why re-ask per width:** the premise is a property of the host, and a host
  changes under a mounted bar — a framing variant swaps, a wrapper's class
  flips, contributions arrive in a later plugin wave, or a shrink-to-content
  ancestor floored by a wider sibling stops being floored once the bar's content
  grows past it. Narrower-than-verified is the ratchet's own direction (an
  eviction only reduces what the row holds). A report can therefore arrive long
  after mount and name a host that broke later.
- **Why `MAX_SLACK_PROBES`:** each probe is a forced reflow, and a narrowing drag
  produces one per frame.

**The 0px branch is a question, never a verdict.**

- A 0 inside a `display: none` subtree is the absence of a reading, not a
  reading. Treating it as a width is an absorbable failure value, and the act at
  the end of this branch latches irreversibly.
- A rendered 0 is still ambiguous. An over-full row — the row's *other* items
  over-fill the container, free space is negative, and a `flex: 1 1 0%` cell
  with base size 0 resolves to exactly 0px — has nothing wrong with its host.
  The hide-and-re-read probe is correctly silent there, but needs occupants in
  the row to hide, which a ratchet-emptied row has run out of.
- So the bar runs the experiment rather than guessing: re-admit everything, and
  the next pass splits the two cases.
- The over-full answer is still reported because at 0px with `overflow-hidden`
  every occupant *and* the `⋯` are invisible — a surface showing nothing with
  nothing filed is what these guards exist to prevent. Filed only after a
  recovery actually happened, which makes it evidence rather than a guess.
- **Why defer under a gesture:** re-admitting is a re-parent, and doing it under
  a live pointer kills the gesture. Not `immovable`, because it never clears.
  Every release bumps, so it is deferred, never dropped.
- `isRendered` must go through the seam: calling the DOM predicate directly would
  make this branch dead code in jsdom, the one suite that can reach it.

**nested-bar.**

Two measuring bars in one row are two claimants on the same slack — each is
`min-w-0 flex-1` and each asks the chain above to grow — so the inner one takes
all of it. The outer bar then files `no-slack`, a true sentence about a host
that is fine, while the row's title crushes to its first word.

- The remedy is `no-slack`'s ceiling, latched: a bar inside another bar's
  occupant sits in a `shrink-0` container, so every width it reads is its own
  content's.
- Excluding `Collapsed` is not a carve-out: it measures nothing and takes no
  slack.
- **Why the nested bar declines to measure at all:** a state update from an
  earlier layout effect in the same commit is invisible to that pass, so the
  inner bar would spend one pass filing `no-slack` about its container before
  the fault naming the real problem.

**row-overflow.**

Rejected spellings:

- **Ancestor comparison.** `offsetParent` is the nearest *positioned* ancestor,
  not the row — a bar in a scrolled strip fits its row while sitting far outside
  `offsetParent`. `parentElement` may shrink or carry padding.
- **`scrollWidth > clientWidth`.** LTR scrollable overflow ignores content past
  the left edge, so an `align="end"` row (every pane header) reads equal while
  overflowing by 16px. It also folds in descendants' overflow, so a widget's own
  transform becomes a false accusation.

**empty-rung.**

- **Why it never throws:** a widget rendering nothing for one frame while its
  data loads must not take a pane down.
- **Why it reports at all:** the bar recovers by itself, which is exactly why it
  has to say so. A contribution rendering nothing at *every* form is ordinary
  and reported nowhere.

**Remedies.**

- **`no-slack` takes the ceiling** because it can trust nothing it measures;
  eviction is what the bad reading was already producing.
- **`row-overflow` takes the floor** because the engine just contradicted the
  fit's arithmetic, so "the widest placement the fit blessed" is the claim under
  suspicion.
- **`no-convergence` keeps the best measured answer** because a search that runs
  out of rounds has usually blessed several good placements; throwing them all
  away cost the user their whole toolbar over a transient fault.
- **`clip` never floors** because its evictions go to a hidden parking dock —
  flooring would hide everything, strictly worse than the clipping it accepts.

**Why committing and stopping are one act:** without the latch the commit
re-runs the pass, the fit recomputes the same answer and commits again forever —
both the convergence branch and the commit reset the round counter, so the
budget counted a number being zeroed underneath it.

- The zero-width recovery is not a counter-example: it commits the search's
  *input*, not an answer, and the next reader is the probe, not the fit — so
  the loop has nothing to run on.
- Scoped to the width, not the mount, because a genuine resize is a premise the
  bar has not failed under.

## A round is only a round of the same question

Why the premise reset: rounds before a premise shift were about a row that no
longer exists.

Why `passBudget` is derived, not a constant: a cold start costs 2 rounds, a
late-arriving ladder a third, hysteresis a fourth — a fixed budget of 4 leaves
no margin, and the next legitimate round files a fault.

Why the evidence: this fault is often transient, and a transient that records
nothing can never be diagnosed.

## Why one stable container per item

- Swapping a host element for a portal at the same position, or changing a
  portal's container, deletes the subtree and builds a new one — a reconciler
  rule, not taste.
- **Why the REGION attribute bag:** an occupant is part of its row's region; the
  popup bag drops the sub-theme, and a page's header items revert to UI sizes.
- **Why stamp unconditionally, not at move time:** a move-time branch can be
  wrong, and the symptom is a widget in the wrong palette only after it has been
  relocated once.

## What survives a re-parent, and what does not

`moveBefore` fixes every row of the table, but it is not everywhere yet, so the
fallback path repairs what it can.

Why never touch a node in place: every avoided move is a preserved focus,
pointer capture, CSS transition and inner scroll offset. A resize that relocates
one widget leaves the other six alone.

## Order is an input, and it comes from the DOM

The DOM already knows the order (the host may sort through a slot's reorder
middleware and wrap items however it likes).

- Rejected: a registry keyed on mount order — gets a mid-list insertion wrong.
- Rejected: a consumer-supplied order list — a second source of truth for
  something nobody has to be told.

Why "inline" is not "child of root": `display: contents` removes a box from
LAYOUT but not from the DOM TREE. Through `slot-render`'s wrapper the container
is still a flex item of the row (gap and measurement unchanged) while its anchor
is a level or more down.

Why rigidity is per container: `[&>*]:shrink-0` on the root stops reaching
containers through that chain, and a squeezable occupant blinds the guard. The
reorder `spacer` needs nothing — `flex: 1 1 0%` with no content has no width to
shrink.

Why the blank-rung ledger instead of rendering to probe:

- Rejected: instantiating every member a second time to draw nothing and be
  counted.
- Why a `MutationObserver`: the shared `ResizeObserver` sees a widget stop
  rendering but not start again, since a `display: none` element reports no
  resize when content appears inside it.

## The panel is always mounted

Why not `Popover` / `DropdownMenuContent`: they destroy content on close, which
orphans every container and kills the single instance this primitive exists to
preserve.

Why the popup gets `Esc` first: dismissing the panel under an open popup hides
the popup's trigger and strands the popup unanchored — so a popover-opening
action behind a row's `⋯` (a "View raw JSON") would have to be a modal dialog
instead.

## Two locks, neither of which anyone opts into

- **Why the document-level release:** a pointer-up outside the bar reaches no
  React handler, and a permanently pinned item is worse than a moved one.
- **Why store the target placement:** with the release itself triggering the
  pass, "deferred forever" is unrepresentable.

## The honest costs

- **No way to re-render only the widget that moved**: the bar must re-render for
  a widget to change form.
- **Trigger reveal**: one forced reflow per bar, still better than a hardcoded
  width, which is wrong at any other control density. The no-slack probe uses the
  same hide-measure-restore discipline.
- **`degraded` latching** means a false `no-slack` costs that surface all
  relocation behaviour until remount — why the 0px branch asks whether the row
  generates a box, then re-admits and re-asks. Each re-ask costs the re-admitted
  layout for one pass plus one probe reflow.
- **`clip`**: the fix if it papers over bugs is a lint demanding a named reason,
  not a stricter default.

## Where the claims are proven

No one suite carries the whole thing: jsdom has no layout engine and the shared
`ResizeObserver` stub is inert, so the fit, docking, pins and panel run as in a
browser while widths are supplied.

**Why `AdaptiveBarMeasure` is test-only:** a consumer that "adjusts" measurement
is lying to the layout engine about a number the layout engine owns.

**Why the layout-harness fixture:** every production surface is made of plain
actions, and none exercises the premise — a draggable widget relocates and is
still draggable.

### Driving a bar occupant from another plugin's e2e script

What a bar relocates depends on the viewport, so a script clicking by role
breaks at whichever width moves the control into the closed panel.

## `core/` — the pure decision math

### The rules worth knowing before you touch this

**An occupant's width is its own.** A pass measures the placement React has
ALREADY committed, so an over-full row is the normal mid-search state. If the
engine takes the deficit out of occupants there:

- the squeezed number is stored as `exact` — sticky, since an item is only
  re-measured at the rung it sits at;
- the row-overflow guard goes blind (occupants sum to exactly the content box);
- `assign` compares that sum against the same width and stops demoting.

Why today's occupants are unsqueezable only by accident: a container is a flex
item with `min-width: auto`, so its floor is its own min-content; under
`whitespace-nowrap` a text run's min-content is its natural width. `min-w-0`
inside a widget lets the leaf be smaller, not the box the bar measures.

- The trigger needs its own declaration because `measureTrigger` caches its
  width, so one squeezed reading under-reserves it forever.
- In the panel's column `flex-shrink` is about height — harmless, the panel is
  content-height.
- The `adaptive-bar/squeezable-occupants` exhibit opts back into wrapping; remove
  the declaration and all four occupants collapse 186px → 83px.

**One estimated step per pass** costs one extra pass on the first overflow of a
session.

**Blank at a rung vs blank occupant.** Conflating them made the bar flip
forever: `assign` dropped an absent item ("nothing to place"), `rungOf` read the
hole as rung 0, the widget rendered its full form, the fit demoted it back, and
round one came round again. Both readings were right; the conflation was not.
See
[`research/2026-08-18-global-adaptive-bar-absent-rung.md`](../../../../research/2026-08-18-global-adaptive-bar-absent-rung.md).

Stopping the declaration is the recovery path with no round-trip, because "it
renders there after all" is unobservable on a rung never sat on again.

### Hysteresis, and the two things `assign` reads about the present

- H1 exists so a one-pixel resize cannot flip the row back and forth; outside
  the band the answer ignores placement entirely. Reading `currentRung` is
  unavoidable: hysteresis *is* direction dependence, and direction can only come
  from current state.
- **Seeding a newcomer at `null`** produces a freshly contributed action that
  simply never appears — H1 holds it out until the bar grows by a further
  `hysteresisPx`.
- **H2 evidence is scoped, not kept.** The shift check runs on every deciding
  pass, so discarding on a premise shift covers `reconcile`'s early returns
  without enumerating them.
- **Why "at or narrower", not `rung === r`:** inline widths are monotone, so a
  rejection at a narrow rung is one at every wider rung; an exact match lets the
  fit promote straight past the form it just learned does not fit.
- **Why the re-declare gate matters:** an item's channel carries its assigned
  form, so the declaration effect re-runs on every rung change. Ungated, the bar
  drops one passive effect after the pass that installed it, reopening the cycle
  one converged episode at a time.

### What the driver does with `fits` and `usedEstimate`

- **Why only on a converged pass:** `measureRowOverflow` measures the committed
  placement; checking it against a placement about to be committed compares two
  different configurations — and throws over it in dev.
- **Why `usedEstimate` does not gate it:** an estimate is an upper bound, so a
  `fits: true` reached through estimates is still a claim a row-overflow
  contradicts.

### `yieldRank`: higher yields sooner

Why the eagerest occupant goes all the way to its floor first: the rejected
round-robin (one step each) leaves every widget half-shrunk instead of most of
them intact.

### The `null` that is not a missing key

`?? 0` makes the bar look like it never overflows at all — every evicted
occupant goes straight back in the row.

"No entry → rung 0" holds for both cases because nothing has been decided and
the widget's own output decides what happens next. Re-offering a blank rung
would turn the default into the flip: rendered → demoted → blank → dropped →
read as rung 0 → rendered.
