# rail

Padding is not decoration. **Applying padding is the act of opening a region** —
declaring where the things inside you start. A box either opens a region, or it
lives in one somebody else opened and does nothing at all.

There is no third option, and that is the whole point. When two boxes in a chain
both apply an inset, nothing anywhere looks wrong: each call site reads as
reasonable, and the only evidence is a child indented twice on screen. Naming
the act — you open a region, or you don't — is what turns that into a question
with one answer.

## The five rules

**The edge owner owns the rail.** One box in a chain decides where the contents'
edge is. It is the box that opened the region, and it is the only one that pads.

**You inherit alignment by doing nothing.** A bare `<Input>` dropped into a
region lines up because the region already moved its content edge. No wrapper,
no prop, nothing to remember, nothing to forget. This is the rule that makes the
whole thing worth having: a rail is proven by the child that knows nothing about
it.

**The only escape is cancel-and-reapply, as one act.** A child that must reach
the region's inner edge — a row whose hover fill should read as a row, a
hairline that spans the panel — cancels the rail and re-applies it. `rail-bleed`
is both halves in one class, because half of it is the entire bug: cancel
without re-applying and the content moves; re-apply without cancelling and it
moves twice. A canceller may deliberately stop short of the rail's origin, or
re-apply something other than the rail — `cp-row` does both — but then it writes
its own two terms and says why, rather than reaching for half of `rail-bleed`.

**Atomic in CSS is only half the invariant — it must be atomic in class strings
too.** Fusing the declarations stops anyone *writing* half an escape; it does not
stop a neighbouring `px-md` *neutralising* half of one, leaving the margins and
width bleeding while the re-apply is overridden. Hence `rail-bleed` carries
`/* twmerge: extend px */` rather than the `standalone` its three properties
suggest — and it stays `extend px` even though `excludes:` is now symmetric too,
because a synthetic group cannot yet name *another* synthetic group, and `px`
membership is what earns the mutual relation with `sg-rail`/`sg-rail-x` for free.
**Known gap: `extend px` guards the padding term only, so a later `w-full` kills
the width term while the margins keep bleeding. Do not pair `rail-bleed` with a
width utility.** Read the note at the utility before changing any marker here.

**Nesting is shadowing, not accumulation.** A region inside a region re-declares
the vars for its own subtree; the outer value simply stops being visible. There
is nothing to add up and nothing to wire.

**Publish what a descendant must adapt to.** A class name has no length. If a
descendant has to reach across your padding, bleed out of it, or follow it, it
has nothing to read unless you say the number out loud — hence the four vars
below.

## The vars

| var | means |
| --- | --- |
| `--rail-start` / `--rail-end` | the inset **already applied** between my content and the region edge. What a bleeder cancels. |
| `--rail-owed-start` / `--rail-owed-end` | the inset a follower must **still apply itself**. `0` when the owner paid; the rail when it published without paying. |
| `--rail-block-start` / `--rail-block-end` | block padding, per edge — `scroll-fade`'s strips read them |

Applied and owed are two different questions and one number cannot answer both.
A container that pads *and* publishes a non-zero "you owe this" is telling every
`rail-follow` band inside it to pay a second time — `rail-lg` over a band would
sit at 48px where it sits at 24 today. So the ramp sets owed to `0` (I paid),
and `rail-owe-<step>` sets it to the step (you pay).

**The rail is measured from the publisher's padding box, and equals the whole
of the publisher's own padding on that side** — it is *where a child that does
nothing lands*, nothing less. A region with a two-part inset (`cp-panel`: a
chrome gap plus a content rail) publishes the sum; publishing only one part
would advertise a rail no child actually sits on, which is the exact lie this
contract exists to make impossible.

## The classes, and this plugin's `core/`

Every `@utility` lives in [`ui-kit/web/theme/app.css`](../ui-kit/web/theme/app.css),
the single home for all of them. Read that section for the mechanics; this file
is the model behind them.

| class | does |
| --- | --- |
| `rail-<step>` · `rail-x-` · `rail-y-` | open a region: publish **and** pay. `rail-x-none` is how *flush* is spelled — a region of width zero, which is a different state from no region at all |
| `rail-owe-<step>` | open a region and hand the bill on: publish, pay nothing. The inverted topology; the app-shell sidebar is its live user |
| `rail-follow` | pay what is owed, publish nothing. Falls back owed → rail → chrome pad |
| `rail-bleed` | the escape: cancel and re-apply, as one class |

`core/` holds what CSS cannot: the var **spellings** (`RAIL_START_VAR`, …), for
a `getComputedStyle` read or a `style={{…}}` publication, and **`railClass({rail,
x, y, owe})`** — the twin of `insetClass()`, for a `className`-only consumer or a
step held in a variable. Its step→class tables are literals on purpose: Tailwind
emits a utility only for a token its scanner sees, so a spliced
`` `rail-x-${step}` `` produces nothing.

**They have no `:root` default, deliberately.** Every read carries its own
fallback, and a `0px` default at the root would make all of those fallbacks dead
code — `rail-follow` would resolve to zero everywhere and every pane would go
flush. "Nobody opened a region here" must stay distinguishable from "someone
opened one of width zero".

## Why a parallel ramp, and not publication folded into `p-*`

Folding it in is tempting: every padded box would open a region for free and
there would be no second vocabulary to learn. It is wrong for one concrete
reason.

`p-md` and `px-lg` legitimately coexist on one element — tailwind-merge keeps
both, and `px` wins by CSS order. If `p-*` published the rail, `--rail-start`
would then resolve by **stylesheet declaration order** rather than by any
cascade a human intended, and the published number could quietly disagree with
the applied one. Under their own tailwind-merge groups, a rail class and a plain
padding class conflict: exactly one rail declaration survives per axis, so what
is published is always what is applied.

There are three groups, not one (`sg-rail`, `sg-rail-x`, `sg-rail-y`), copying
the p/px/py topology rather than inventing one. The two axis families write
disjoint properties **and** disjoint vars, so `rail-x-lg rail-y-sm` has to
compose — a single shared group would silently drop the first of the pair, which
is the same class of invisible breakage this contract exists to kill. A plain
padding class in **either** position removes the rail outright: you replace a
region, you do not edit one. Each group therefore names every per-edge padding
group it publishes over (`sg-rail excludes: p px py pt pr pb pl`) — a rail that
kept a later `pt-2` alongside it would publish a block inset it no longer
applies. The one asymmetry is deliberate: `p-*` is broader than `rail-x-*`, so a
later `rail-x-lg` leaves an earlier `p-md` alone and its block padding survives.

## Why one shared var pair, and not a name per region

Because nesting then costs nothing (plain custom-property inheritance, and it
passes through the `display: contents` wrappers `renderIsolated` puts around
every contributed panel) — and because **the escape becomes portable**.

`cp-row` used to cancel a panel-private inset var, so it bled correctly only
inside a control panel and was undroppable anywhere else. Reading the ambient
rail, the same row bleeds correctly in whatever region it actually landed in,
and outside any region it is simply a row: nothing to cancel, nothing to
restore.

## The one inverted topology

In `data-view` the bands apply the inset and the container does not — the
opposite of the model, and the reason `rail-follow` and `rail-owe-<step>` exist.
Flipping it the right way up means `PaneChrome` becoming a region owner, which
insets *every* pane in the app including the deliberately full-bleed ones (diff
view, browser webview, canvases). That is a separate change with its own risk
budget.

The applied/owed split is what lets both topologies coexist without either side
knowing which it is in. A follower asks "what do I still owe?"; a bleeder asks
"what has been applied?" — and a bleeder lands on the region edge either way:
under `rail-lg` the container paid it, and inside a band under `rail-owe-sm` the
band paid it and the band's own edge *is* the region edge. The one shape with no
answer is a direct child of a `rail-owe-` owner reaching for `rail-bleed`:
nothing has been applied there yet, so there is nothing to escape.

## Three traps, one shape

**A box that pays the rail must not sit inside another box that pays the rail** —
whether the outer payer is a follower, an `Inset`, or any plain `px-*`. All three
are silent: the layout is plausible, no rule is broken anywhere you can point at,
and the only evidence is an inset applied twice or a box escaping its parent.
`useRailGuard` (`web/`) reports all three off the live DOM.

- **Nested followers each pay.** `rail-follow` cannot clear the debt for its
  descendants: reading `--rail-owed-start` while declaring it on the same element
  resolves against its own declaration, so an inner follower re-applies the full
  inset. Followers are siblings, never ancestors of one another. The commonest
  accidental route in is a sub-region `<Loading>` — its skeleton bands follow the
  rail — rendered **inside** an already-following body instead of in place of it.
  (data-view is clean today only because it renders `Loading` as a ternary
  *against* the view child, so the two never coexist.)
- **A bleed is only correct inside the box that published the rail it bleeds
  by.** `rail-bleed` cancels the nearest *published* rail, and an `Inset` /
  `px-*` pads without publishing — so a bleeder under one is sized for a rail
  that box never applied and overhangs by the difference (version-history's
  288px pane, inside `Inset x="xs"`, inside a 16px panel region: 12px per side).
  The fix is always for the padder to open a region, never a compensating number
  on the bleeder.
- **A bleed is only free directly under a box that hides `overflow-x`.**
  `OverlayPanel` does. A nested `ScrollArea` does the opposite — base-ui's
  Viewport sets `overflow: scroll` on both axes, and a negative end margin does
  not shrink scrollable overflow — so bleeding a row inside one buys sideways
  scroll instead of a wider fill.

**Never bleed a panel itself.** A panel *is* the region, so
`<DialogContent className="rail-bleed">` strips its own `rail-lg` (same `px`
tailwind-merge group, `className` last) and then bleeds against a rail that is
now zero: approximately right in a screenshot, wrong in the DOM. Enforced by
`lint/no-panel-bleed`; a *band inside* the panel bleeds, the panel never does.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Web half of the rail contract: useRailGuard, the dev-only structural guard a region owner attaches to its own box. It measures every child's content edge against the rail the region published and names whoever applied an inset on top of it — the double-inset that looks reasonable at every call site and is only visible as content indented twice.
- Core:
  - Uses:
    - `primitives/css/space-ramp.rampClass`
    - `primitives/css/space-ramp.SpaceStep`
  - Exports (types): `RailSides`
  - Exports (values):
    - `RAIL_BLOCK_END_VAR`
    - `RAIL_BLOCK_START_VAR`
    - `RAIL_END_VAR`
    - `RAIL_OWED_END_VAR`
    - `RAIL_OWED_START_VAR`
    - `RAIL_START_VAR`
    - `railClass`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `backup`
    - `primitives/css/control-panel`
    - `primitives/css/ui-kit`
- Web:
  - Exports (values): `useRailGuard`

<!-- AUTOGENERATED:END -->
