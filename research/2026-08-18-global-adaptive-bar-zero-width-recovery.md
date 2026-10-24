# A rendered 0px row is a question, not a verdict — the bar re-asks instead of latching

Status: implemented (2026-08-18)

## Context

`no-slack` is the adaptive bar's guard for "my host is lying about the width it
hands me". Its remedy is the most expensive act the primitive can take: the
**ceiling** — every occupant back in the row, CSS clips — **latched for the life
of the mount**. While it is latched the surface has no overflow behaviour at all.

The guard has two trip points in `reconcile`
(`plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx`):

- **A — the 0px branch**: `available <= 0` with occupants relocated out of the
  row, on a row that generates a box.
- **B — the differential probe**: hide what the row holds, re-read the row, put
  it back. The direct test of the premise, and definitive.

Yesterday's change ([`…-unrendered-host.md`](./2026-08-18-global-adaptive-bar-unrendered-host.md))
taught branch A to tell a row that generates **no box** (a `display: none`
keep-alive tab) from one that does. Its follow-up 1 is this document: **branch A
still cannot tell apart the two things a *rendered* 0px row can mean, and it
latches anyway.**

- **The ratchet's terminal state.** The host shrink-wraps to the bar, every
  eviction shrank the width that decided the next one, and the row has ratcheted
  itself empty. Latching is correct.
- **A merely over-full row.** `flex-1` is `flex: 1 1 0%`. When a row's *other*
  items over-fill their container, free space is negative, and a cell whose base
  size is 0 has no basis on which to absorb a share of the shrinkage — so it
  resolves to exactly **0px while fully rendered**. Nothing is wrong with the
  host. There is simply no room at this width, and there will be again when the
  row widens. Latching is destructive: the bar never decides again.

Branch B is correctly silent in the second case — hiding the occupants does not
change a width that comes from negative free space — and it *cannot run* in the
first case's terminal state, because its `inline.length > 0` precondition fails
once everything has been evicted.

## The idea

Do not decide the ambiguity from a number that cannot carry the answer.
**Restore the conditions under which the guard that *can* answer it will run**,
and let it. The recovery is not a remedy; it is an experiment, and both of its
outcomes are informative.

Branch A commits the ceiling **once, unlatched** — every occupant back in the
row — clears the "premise verified at" watermark and reserves a probe. The next
pass splits cleanly:

| | what the next pass reads | what happens |
|---|---|---|
| shrink-wrapping host | a positive width (its own content) | the probe runs, `widthFollowsContent` is true, **branch B faults with the accurate message and latches** |
| over-full row | still 0, but now with `evicted.length === 0` | **nothing is latched**; one non-latching report says the row is over-full, and the bar decides again the moment it widens |

## What was built

### 1. Branch A becomes a bounded, gesture-aware recovery

```ts
if (available <= 0) {
  if (evicted.length > 0 && isRendered(root)) {
    // Re-admitting is a re-parent. Under a live pointer that releases capture
    // and kills the gesture, so it waits — every release bumps, so this is
    // deferred, never dropped. `immovable` is excluded: it never clears.
    if (order.some(({entry}) => entry.holds > 0 || entry.popupOpen || entry.pointerPinned)) return;

    if (zeroRecoveriesRef.current < MAX_ZERO_RECOVERIES) {
      zeroRecoveriesRef.current += 1;
      slackVerifiedAtRef.current = null;                                       // or the wider re-admitted width reads as verified and the probe never runs
      slackProbesRef.current = Math.min(slackProbesRef.current, MAX_SLACK_PROBES - 1); // RESERVE a probe; `n - 1` would manufacture budget
      episodeRef.current.promoted.clear();                                     // H2's evidence was about the placement being discarded
      setPlacement(EMPTY_PLACEMENT);
    } else {
      setDegraded(true);
      failLoudly({ kind: "no-slack", /* exhausted-recovery */ });
    }
  } else if (zeroRecoveriesRef.current > 0 && !overFullReportedRef.current && isRendered(root)) {
    overFullReportedRef.current = true;
    reportFault({ kind: "no-slack", /* over-full; nothing latched */ });
  }
  return;
}
```

`EMPTY_PLACEMENT` is exactly what `degraded` renders — `rungOf` reads a missing
entry as rung 0 — so "the ceiling, unlatched" needs no second code path, and it
can never be a no-op commit: `evicted` requires `placement.has(id)`, which an
empty map cannot satisfy.

### 2. The over-full row is reported, not silenced

The first draft let the over-full row pause silently. That was wrong, and it
inverted the change's purpose: an over-full row **never reaches the exhaustion
counter** (its second pass has nothing evicted), so it would have become
permanently and completely silent — while at 0px with `overflow-hidden` every
occupant *and* the `⋯` trigger are clipped to invisibility. A surface showing
nothing with nothing filed is the outcome these guards exist to prevent.

So the answer the recovery comes back with is filed: `reportFault`, not
`failLoudly` — no throw, no latch — once per mount, and only *after* a recovery,
which is what makes it evidence rather than a guess. `no-slack` carries it
without strain; its own definition is "some ancestor is shrink-to-content, **or a
sibling took the grow slot**". The remedy it names is the bar's siblings.

### 3. The bound, and the honest termination argument

`MAX_ZERO_RECOVERIES = 3`, cleared by a pass that converges **without faulting**
(placed after the `row-overflow` check, which needed an early `return` inside
that branch so a faulting convergence does not refund).

The argument written into the constant is deliberately *not* "this is what makes
it terminate":

- A recovery's follow-up pass runs at a real width and commits a different
  placement, so it costs one `episode.total` like any other pass. A recovery loop
  is therefore **already** bounded by `HARD_ROUND_CEILING`, ending in a
  `no-convergence` surrender.
- What `MAX_ZERO_RECOVERIES` decides is the **diagnosis**: whether a bar that
  cannot get an answer says `no-slack` (true — the width reading is the problem)
  or `no-convergence` (a misdiagnosis blaming the fit for a host's arithmetic).
- It is cleared at exactly the instant `episode.total` is, so it introduces no
  new termination claim — it inherits one already proven and already tested.
- A monotonic per-mount cap was rejected: a single drag oscillating around the
  collapse point burns one per crossing, reinstating the permanent latch,
  conditioned on gesture history.
- Three, with React's nested-update margin as the ceiling rather than a UX
  budget: each recovery costs ~2 nested synchronous updates on top of an episode
  already allowed to run to `HARD_ROUND_CEILING`.

### Two shapes worth knowing

- Branch A is unreachable in `scroll` mode (nothing is evictable, so `evicted` is
  always empty) and for a `collapsed` bar (its early return sits above the
  measurement — and a recovery there would fight the collapsed branch for ever,
  which is why that ordering is now commented).
- In `panel` mode the terminal ratchet never reaches 0 either: the `⋯` trigger is
  un-hidden whenever something is evicted, so the row keeps a real width. Branch
  A's ratchet case is a `clip`-mode shape — consistent with the evidence, where
  every branch-A row came from the `clip` prompt-template bar.

## Tests

`web/__tests__/no-slack.test.tsx`, 47 vitest cases in the plugin, all passing:

1. **An over-full row recovers instead of latching** — the case that used to
   assert the fault now asserts the non-latching report, everything re-admitted,
   and, the load-bearing half, **that it evicts again when the width comes back**.
   Plus: it says it once.
2. **Many collapses keep it deciding** — the oscillation a monotonic counter
   fails.
3. **The terminal ratchet still latches, via branch B** — a host that gives a
   width, is narrowed until everything is evicted, then becomes content-driven.
   Asserts branch **B's** message, which is what proves the hand-off (and the
   reserved probe) rather than branch A guessing right.
4. **A host no guard can get a true answer out of** — 0 whenever anything is
   evicted, a fixed width otherwise, so the probe always says "the premise
   holds". Latches after `MAX_ZERO_RECOVERIES` with the exhausted message, and
   does not loop.
5. **A gesture defers the recovery** — an occupant pinned by a pointer while
   parked in the dock is not dragged back out; the release is what lets the
   recovery run.
6. The hidden-host cases pass verbatim — the proof that the recovery sits below
   the `isRendered` guard and did not swallow the `display: none` case.

## Verification beyond jsdom

- `e2e/adaptive-bar-overfull-row.ts` (manual, new): discovers the bars on
  whatever route it is pointed at, narrows until one relocates, injects a rigid
  over-wide sibling into the bar's own row until its cell measures ~0 (asserted,
  not assumed), waits real frames, removes it, and asserts the bar still
  relocates, still re-admits on widening, and still evicts on narrowing.
- `./equin check` (type-check, lint, layout-geometry). The
  `adaptive-bar/host-stops-giving-room` fixture goes through branch **B** and is
  unaffected.

## Docs

- `plugins/primitives/plugins/adaptive-bar/CLAUDE.md` — the `no-slack` bullet
  rewritten as two filters and a re-ask; the gesture defer; the remedy list now
  names the third (ceiling without latch) and the fourth (report, commit
  nothing); the "committing and stopping are one act" doctrine qualified (the
  recovery commits the search's *input*, not an answer). Pre-existing drift fixed
  while in there: "the four faults" listed four of five, and "every fault throws
  in dev" contradicted `reportFault`.
- `plugins/reports/plugins/adaptive-bar/CLAUDE.md` — `no-slack` now arrives in
  two flavours and **only the message tells them apart**, since the fingerprint
  deliberately excludes `message`; that collapse onto one row is intended and is
  now stated rather than left to be discovered.
- `plugins/reports/plugins/adaptive-bar/server/internal/adaptive-bar-task.ts` —
  the filed task's own prose: the second way in, the non-latching flavour, and
  the sibling-side fix that the three shrink-wrap remedies did not cover.

## Follow-up still open

**A render-slot contribution whose component hosts an `AdaptiveBar` must declare
`fill: true`.** Nothing enforces it, and both slot-hosted bars in the repo have
got it wrong once each. The facet/docgen pipeline already knows each
contribution's component, so a `check` could answer "does this component
transitively render an AdaptiveBar" statically — rung 3 on the fix ladder, where
the contract is rung 5 plus a runtime report today. Carried over from
[`…-unrendered-host.md`](./2026-08-18-global-adaptive-bar-unrendered-host.md).
