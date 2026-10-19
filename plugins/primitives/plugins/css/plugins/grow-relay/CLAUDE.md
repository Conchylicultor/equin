# grow-relay

The widget that needs the row's room **asks for it**, from where it is
rendered. Every box in between passes the ask on. The row stops it.

```tsx
useRequestGrow(true); //                      the widget:   I need the slack
<GrowRelay>{(growing) => …}</GrowRelay>; //   a box between: then I grow, and I pass it on
<GrowRelay.Stop>{children}</GrowRelay.Stop>; // the row:     it stops here, I have the width
```

## What it replaces

An `<AdaptiveBar>` must be the growing cell of a single-line row: it puts
`min-w-0 flex-1` on itself and reads its own `getBoundingClientRect().width` as
*the room I was given*. If any box between it and the row shrink-wraps, every
eviction shrinks the width that decides the next one — a ratchet ending in a 0px
row with nothing visible in it.

When the bar came from a render-slot contribution, one of those boxes was
`slot-render`'s per-contribution cell, and the way to make it grow was
`fill: true` **on the contribution** — in the plugin barrel, two or three files
from the `<AdaptiveBar>` the flag was about, with nothing between them saying so.
Both slot-hosted bars in the repo got it wrong once each. The contract lived in
prose plus a runtime report: the two weakest rungs of the fix ladder.

There is nothing to declare now, so there is nothing to forget. That is the
whole primitive.

## Why the ask has to keep travelling

A relay grows **and forwards**. `flex-1` yields pixels only if the relay's own
parent has slack to share, so a relay that stopped at itself would fix one link
and leave the next one shrink-wrapping — the exact shape of the bug.

**Only boxes that can answer are relays.** A box that is not one is
*transparent, not a break* — React context passes straight through it — so
nothing between the requester and its row has to opt in. That is why `Fill` is
**not** a relay (it grows unconditionally already, so wrapping it would buy
nothing and cost a fiber at ~120 call sites) and why the `slot-render` cell is
one only on its row branch (its `display: contents` branch generates no box, so
counting it would report a link that applied nothing). Such a box still fails to
grow ITSELF, which no bookkeeping can fix; that is what `adaptive-bar`'s
`no-slack` probe is for, and the `relays` count below is how a fault report tells
the two apart.

**A relay must render the same element either way — only its classes may
change.** Growing is a styling answer, so swapping the element (or its React
type) on `growing` unmounts everything below, releasing the very ask that made it
grow, which un-grows it, which mounts it all back. That is the one way to hang a
page with this API, and the test suite pins it.

## Where it stops

`Line` (so `Row` and `Bar`) installs a `Stop`, because a single-line row is the
exact boundary the bar's own contract names — *the growing cell of a single-line
row*. A host that owns such a row without being a `Line` says so itself: the app
tab strip and the prompt toolbar, both `Stack direction="row"`.

`Stack` does **not** stop, and that is not an oversight: a `Stack
direction="row"` is just as often a grouping box *between* the cell and the bar
(Sonata's picker is exactly that), and stopping there would leave the cell never
told.

Forgetting a `Stop` is the cheap direction of the asymmetry, and the trade is
the point: the ask escapes one relay further and some ancestor cell grows into
slack its rigid siblings did not want — invisible. Forgetting the declaration
this replaces broke the bar.

## The acknowledgement, and why a boolean was not enough

`useRequestGrow` returns `{ granted, relays }`.

`granted` exists because of an ordering problem, not as a nicety. A relay
applies the grow in a `setState` from the requester's layout effect, and React
flushes those **after** every layout effect of that commit — including the
requester's own measuring one. `AdaptiveBar` measures there, and its `no-slack`
guard *latches*: judging that first, un-grown reading would condemn a host that
was about to be fine. So each relay composes `granted = growing &&
parent.granted`, which makes the requester's single boolean mean *every box
between me and my row has applied the grow*, and `reconcile` simply returns
until it is true. It settles in one synchronous pass per level, all inside the
same pre-paint layout phase.

With no relay above, `granted` is true on the spot — a bar rendered straight
into its row (a pane header) waits for nobody and costs nothing.

`relays` is diagnosis. `0` means nothing above claimed the ask — either the bar
is not in a slot cell at all, or the nearest box above it is a `Line`/`Row`/`Bar`
whose `Stop` ended the ask because it IS the row, in which case that row is what
needs fixing. `n` means every box this primitive can see relayed, so whatever
swallows the grow is one it cannot — a hand-rolled wrapper. Both sentences are
written into the width faults.

## Why the registration handle is a nested object

The context value carries `{ sink, granted, relays }`, and the descendant's
registration effect depends on **`sink`, not on the value**. The value is
*supposed* to change — that is what `granted` is for — and an effect keyed on it
would re-run on every change, with the cleanup's `unregister` taking the count
straight back down: a relay that flickers forever instead of settling. `sink` is
memoised on `[]`, so keying on it makes that impossible rather than merely
avoided. Same reason [`popup-open`](../../../overlay/plugins/popup-open/CLAUDE.md) memoises its
sink, which this is modelled on throughout — counted registry, render-prop scope,
no-op default, release-as-effect-cleanup.

Nesting rather than splitting into two contexts on purpose: `Line` installs a
`Stop`, so every `Row` in a windowed list pays for whatever providers this has.

## Nothing can oscillate

`growing` counts **mounted requesters**. It is never derived from a measurement,
so no answer the requester computes from its new width can add or remove one.

## The inline axis only

This is the **inline** grow — the row's slack. The block-axis twin still exists
as a hand-declared flag: `fill: true` also tells reorder's edit-mode wrapper to
stay a bounded flex column so a contribution's inner scroll region clamps, and
that one is still detected by a `console.error` rather than asked for. Closing
it the same way (driven by `Scroll`) needs the ask to carry an axis.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The grow request: a widget that sizes itself from the room it is given asks for that room (useRequestGrow), every box in between relays the ask upward (<GrowRelay>, render-prop), and the row stops it (<GrowRelay.Stop>). Replaces the fill flag a contribution had to declare three files away from the <AdaptiveBar> it was about — the ask travels with the widget, so there is nothing left to forget.
- Cross-plugin:
  - Imported by:
    - `apps-core/tab-bar`
    - `primitives/adaptive-bar`
    - `primitives/css/line`
    - `primitives/prompt-editor`
    - `primitives/slot-render`
    - `reorder/area`
- Web:
  - Exports (types): `GrowGrant`
  - Exports (values):
    - `GrowRelay`
    - `useRequestGrow`

<!-- AUTOGENERATED:END -->
