# The adaptive bar counts rounds it never ran: scoping `no-convergence` to its premise, and making the fault say what moved

## Context

`reports/adaptive-bar` was wired up this morning
(`research/2026-08-17-global-adaptive-bar-overshoot-guard-false-positive.md`),
and the very first thing it caught was a `no-convergence` fault on an ordinary
healthy surface. One row exists, in the worktree that landed the collector:

```
kind    adaptive-bar          count 4
data    { fault: "no-convergence", label: "More", message: "…still changed after 4 rounds…" }
url     http://att-1786960882-0w66.localhost:9000/agents/c/conv-1786960882-wx5v
```

`no-convergence` means the bar ran `MAX_PASSES` measure-and-decide rounds and the
placement was still changing. Its remedy is the **floor** — every unpinned
occupant at its narrowest rung, everything evictable moved into the `⋯` panel —
so the user briefly sees a toolbar far more cramped than the room actually
requires. This is a pre-existing condition that was invisible until something
registered `adaptiveBarReportSink`; the collector did not cause it.

Two things are wrong, and they are independent:

1. **The round counter counts rounds that were never part of the same search.**
2. **The fault carries no evidence**, so "which occupant's width moved" cannot be
   answered after the fact — by anyone, including the next agent to pick this up.

### 1. `passesRef` is not scoped to the premise it asserts about

`passesRef` in
[`adaptive-bar.tsx`](../plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx)
is incremented on every pass whose placement differs from the committed one, and
reset in exactly two places: a converged pass, and a surrender re-arm. It is
**never** reset when the input the rounds were deciding from changes.

But `reconcile` runs for four different reasons — the row resized, an occupant
resized, the item set or a ladder changed (`version`), or the bar itself just
committed a new placement. Only the last is a round of the same search. A pass
that follows a genuine width change is a *new question*, and answering it
differently is not evidence that the search does not terminate. Today it counts
as if it were, and five such rounds in a row file a fault.

The budget is a hardcoded `MAX_PASSES = 4`, whose docstring argues "a converging
pass costs one rung step, and the ladder is at most three rungs deep". That
argument names the right quantity — the ladder depth — and then hardcodes a
number that does not follow from it. `fit.ts`'s **one estimated step per pass**
rule means an item on a cold cache advances at most one *estimated* rung per
round, so the honest budget is a function of the deepest ladder in the row, not a
constant.

### 2. The fault is unactionable

The payload is `{ fault, label, message }`, and `message` is a constant per
fault kind. So the whole record of a `no-convergence` is the word
`no-convergence` plus a bar label — and the label is `"More"`, the **default**,
which two different bars on that route both use: the app tab strip
(`apps-core/tab-bar`, no `label` prop) and the pinned prompt-template chips
(`conversations/…/prompt-templates`, no `label` prop). They share a fingerprint,
so they would collapse onto one row and the second would hide behind the first's
count.

I drove the live app for a while (viewport sweeps from 1400→560 in 12px steps,
with extra tabs open, on `/agents/c/<id>`) and did not reproduce it. That is the
point: it is transient. A transient fault that records nothing is a fault nobody
can ever diagnose, and the answer is not to keep hunting it by hand — it is to
make the next occurrence explain itself.

## Approach

Three changes, in order of importance.

### A. A round only counts when the premise held

`reconcile` gains one derived value per pass, computed from what it has already
measured — no extra DOM reads:

```ts
/** Everything a decision reads that the decision itself does not cause. */
interface Premise {
  available: number;              // the row's own width
  ids: string;                    // ordered occupant ids, joined
  rungCounts: string;             // each occupant's ladder depth
  /** id → px, for every occupant measured this pass AT A RUNG IT ALSO HELD LAST PASS. */
  widths: ReadonlyMap<string, number>;
}
```

A pass is a **continuation** of the previous one iff `available` is unchanged
(within a sub-pixel epsilon), the ids and rung counts are unchanged, and no width
in `widths` differs from the previous pass's entry for the same id. Otherwise the
premise moved and the round counter resets.

The width clause is the load-bearing one, and its restriction to *unchanged
rungs* is what keeps it airtight. An occupant that just changed rung is
**supposed** to measure differently — that is the whole mechanism — so counting
that as a premise change would reset the counter on every round of the
self-inflicted chain and remove the termination bound entirely. A width that
moved at a rung the item was already sitting at is the opposite: the widget's own
rendered size changed underneath the search, which is exactly the async font /
late icon / self-re-rendering widget the current message speculates about.

This is not a new concept in the file: `staleOthers` is already triggered by
precisely this condition (`known.kind === "exact" && known.px !== px`, line 639).
Today that fact updates the ledger and is then thrown away; it should also be
what tells the counter "these rounds were not about the same row".

### B. The budget comes from the row, and there are three counters

`MAX_PASSES = 4` disappears. Three bounds replace it, counted separately because
they are three different diagnoses, and the fault says which tripped:

- **`rounds` vs `passBudget(items)`** — the search's own cost, and it must be
  derived from the row rather than fixed. The first derivation I tried,
  `2 + maxRungCount`, is a **no-op**: `inlineRungsOf` returns at most
  `["full","compact"]`, so the deepest ladder in this repo is 2 and the formula
  is 4 — the constant it was replacing. The quantity that actually drives rounds
  is the total number of steps the row has to give:
  `2 + Σ(rungCount − 1 + evictable)`, clamped to `[4, 16]`. The clamp's ceiling
  matters: every round is a nested synchronous React update and React's own limit
  is 50.
- **`shifts` vs `MAX_PREMISE_SHIFTS` (6)** — the widths under this bar never
  stopped moving. A real pathology, but not the fit's fault, and worth saying in
  those words.
- **`total` vs `HARD_ROUND_CEILING` (20)** — rounds since the last settled
  answer, and **nothing resets it**. This is the termination guarantee, not a
  belt-and-braces cap. `reconcile` re-enters itself *synchronously* through its
  layout effect, with no frame boundary anywhere in the chain, so a resettable
  counter alone is unbounded: `:hover` is recomputed when a container is
  re-parented out from under the pointer, and a widget with its own measuring
  layout effect re-measures whenever its parent re-renders. Neither is
  expressible as "the search failed"; both are unbounded without this.

All three reset together on a settled answer.

### C. The fault says what moved, and which bar it was

**Evidence.** The bar keeps a bounded ring of its last `TRACE_ROUNDS` (6) rounds:
per round the available width and, per occupant, `{ id, rung, px }`. On a fault
the ring is summarised into the fault body:

```ts
interface AdaptiveBarConvergenceDetail {
  rounds: number;                  // rounds in the episode
  churn: number;                   // premise changes since the last convergence
  widths: number[];                // distinct `available` values seen
  moved: { id: string; rung: number; from: number; to: number }[];  // ≤ 4
  cycled: boolean;                 // the placement sequence repeated
}
```

`moved` is the answer to the question this task was filed to ask, and the bar is
the only thing in the system that can answer it. The message becomes e.g.

> …after 6 rounds. The row held 444px throughout and occupant
> `tmpl-a1b2` measured 91.7px then 135.7px at the same rung — its own rendered
> width moved between rounds.

**Identity.** Every fault gains `origin` — the innermost UI-context node above
the bar's root, via `collectLineage` from
[`primitives/ui-context`](../plugins/primitives/plugins/ui-context/web) (a
neutral leaf, so no cycle). Measured on the running app rather than assumed:

| bar | `origin` |
|---|---|
| the app tab strip | `apps-core.tab-bar@apps.tab-bar` |
| the pinned prompt-template chips | `conversations.conversation-view.prompt-templates@prompt-editor.floating-action` |

`nearestSource` (the build-stamped `<file>:<line>` the element picker uses) reads
like the better name and is **wrong here**: the nearest stamped element above a
bar root is the picker's own marker span or a primitive the consumer composed,
so it is the same constant for every bar in the app. Also measured, not assumed.

`origin` and `overflow` join the fingerprint; `originPath` (which embeds
per-instance pane ids) and the evidence are carried but excluded, or one defect
in two panes would split into two rows.

### D. The remedy: keep the best answer the search produced

`no-convergence` now commits the **widest placement the search measured (never
estimated) as fitting at this width**, and falls back to the floor only when it
produced none. A search that runs out of rounds has usually blessed several
perfectly good placements along the way, and the floor throws all of them away —
which is what made a transient fault cost the user their whole toolbar.

`row-overflow` keeps the floor unconditionally: the engine has just contradicted
the fit's arithmetic, so "the widest placement the fit blessed" is exactly the
claim under suspicion.

And the floor itself stops evicting outside `panel` mode. `clip` drops its
evictions into a hidden parking dock, so flooring a clip bar hides every occupant
it holds — strictly worse than the clipping that mode already accepts.

### Two smaller defects fixed on the way

- **`measureTrigger` could cache a 0 permanently.** The hidden-reveal branch
  cached unconditionally while the visible branch guarded on `px > 0`; a hidden
  element reports no resize, so nothing could ever repair it, and every later fit
  would under-reserve the `⋯` by one button's width.
- **An unmeasurable occupant could be evicted into permanent ignorance.**
  `staleOthers` downgrades an item's other rungs when its current one measures
  differently, so an occupant at its compact rung whose content changes leaves
  rung 0 with no exact width and nothing wider to bound it — `unbounded`.
  `doesFit` was then false forever, every evictable occupant went to the panel,
  the placement was stable, so the bar **converged on the floor, filed nothing,
  and could never recover** (only an inline node is measurable). `assign` now
  refuses to demote an item it cannot size: it contributes 0, so demoting it
  cannot reduce a total it was never counted in. Pinned in `core/fit.test.ts`.

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | the `Episode` bundle (three counters, premise, trace, best), premise capture + comparison, `commitSurrender`, `originOf`, the trigger-width guard |
| `plugins/primitives/plugins/adaptive-bar/web/internal/diagnostics.ts` | `MAX_PASSES` → `passBudget()`; `WIDTH_EPSILON_PX`, `TRACE_ROUNDS`, `MAX_PREMISE_SHIFTS`, `HARD_ROUND_CEILING`; `AdaptiveBarFault` gains `origin`/`originPath`/`overflow`/`evidence` |
| `plugins/primitives/plugins/adaptive-bar/core/round-trace.ts` (new) | the round ring, `premiseShift`, `summarizeRounds`, `describeEvidence` — pure, exercisable without a layout engine |
| `plugins/primitives/plugins/adaptive-bar/core/fit.ts` | `passBudget()`; `isDemotable` refuses an item it cannot size |
| `plugins/reports/plugins/adaptive-bar/{core,web,server}/**` | payload + fingerprint + collector + task body + Debug → Reports line |
| `plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-churn.ts` (new) | drive a URL through a slow width sweep and report each bar's occupancy and any squeezed occupant — the repeatable version of the hand-driving this investigation needed |
| `plugins/primitives/plugins/adaptive-bar/CLAUDE.md`, `plugins/reports/plugins/adaptive-bar/CLAUDE.md` | prose |

## One thing worth knowing before writing a fixture for this

**At a row that holds its width, the fit cannot fail to settle.** H2 bars a rung
whose committed promotion was measured and undone until the row is genuinely
wider, so an oscillation at one width runs out of moves within a round or two —
*even when the occupants' own widths keep moving*. What defeats that is a row
whose width is also changing, because every width change un-bars those rungs.

That is why the faulting fixtures in both jsdom suites drag the row as well, and
it is worth stating because the obvious fixture (flip the occupants' widths at a
fixed width) now correctly produces no fault at all — which is the property, not
a broken test.

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar`:
   - `core/fit.test.ts` — `passBudget` derives from the row and is clamped; an
     item that cannot be sized is kept in the row rather than evicted into
     permanent ignorance.
   - `web/__tests__/premise.test.tsx` — widths that settle after eight rounds file
     nothing (the regression); a premise that never settles still stops the bar
     and the fault names the occupant that moved; the remedy keeps occupants in
     the row.
   - `web/__tests__/termination.test.tsx` — a fault is still one report and a
     stop, never a render loop; the re-arm and `MAX_SURRENDERS` are unchanged.
2. `./equin check` — boundaries (adaptive-bar → ui-context is a new edge),
   type-check, doc/registry sync.
3. `./equin build`, then
   `bun plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-churn.ts --url http://<worktree>.localhost:9000/agents/c/<id>`
   and a `query_db` on the worktree for `kind = 'adaptive-bar'`: a healthy sweep
   files nothing.

## Follow-ups (filed as tasks)

- **The width ledger's axiom is not enforced.** `core/width-cache.ts` is built on
  "an occupant's width at a rung is a property of the occupant", but the occupant
  containers are ordinary flex items (`flex: 0 1 auto`) and several widgets hold
  truncating leaves, so the layout engine may squeeze one behind the fit's back
  and the ledger would store a placement-dependent number. I probed the live app
  (starving the tab strip to 180px and reading the occupants back in the same
  frame) and **it does not currently happen** — which is why this is a follow-up
  and not a change to every bar in the app. The new evidence field will say so
  outright if it ever starts.
- **H2's `blocked` map holds one rung per item and is never swept**, and
  `promotedRef` survives every early return in `reconcile`, so a promotion
  committed before a pane collapse can install a bar at a width that never
  rejected it.
- **`available` is the border box while the overflow guard uses the content
  box**, so a consumer `className` adding padding to the bar root makes the fit
  believe in room that does not exist.
- **An occupant that renders nothing at its compact rung can flip forever**:
  `assign` omits absent items from the placement and `rungOf` reads a missing
  entry as rung 0, so absent → dropped → read as present → demoted → absent. The
  round budget now terminates it, but the cycle itself is still expressible.
