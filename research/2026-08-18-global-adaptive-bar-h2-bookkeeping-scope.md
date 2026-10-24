# The adaptive bar's H2 bar outlives the row it was about: scoping the promotion record and the barred-rung ledger

## Context

H2 is the adaptive bar's second hysteresis rule, and it is the one that makes an
overflowing row settle at a width that holds still: *a promotion the bar
COMMITTED and then measured as not fitting bars that rung until the row is
genuinely wider than the width that rejected it.* Without it a bar whose widths
are estimated promotes, measures, demotes, promotes again — forever.

It is implemented as two pieces of bookkeeping in
[`web/internal/adaptive-bar.tsx`](../plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx):

- `promotedRef` — the rungs the **last committed pass** promoted into. The
  evidence.
- `blockedRef` — the resulting bars, read by
  [`core/fit.ts`](../plugins/primitives/plugins/adaptive-bar/core/fit.ts)'s
  `isBlocked`.

Both were found stale while reading the file for the convergence work
(`research/2026-08-17-global-adaptive-bar-convergence-premise-scope.md`, which
filed them as follow-ups). Neither is that bug. The symptom of the pair is an
occupant stuck one rung narrower, or parked in the `⋯` panel, until the row is
genuinely resized — and nothing reported, because a barred rung is not a fault,
it is the mechanism working.

## The three defects, and what is actually wrong with each

### 1. `promotedRef` survives every early return

It is cleared in exactly three places: the item unregistering, the converged
branch, and immediately before it is refilled at the foot of a deciding pass.
Every early return in `reconcile` leaves it populated — the `root === null`
return, the `degraded` return, the `collapsed` return, the zero-width return,
the `no-slack` return and the surrender return.

The consumption site then stamps the bar with the **current** round's width:

```ts
blockedRef.current.set(id, { rung: promotedRung, atWidth: available });
```

So: a pass promotes an occupant and commits. The pane collapses before the next
pass — the row measures 0px, `reconcile` returns early, the record survives. The
pane reopens two hundred pixels wider. The first pass there computes a placement
that happens to sit the occupant lower than the surviving `promotedRung`, and a
bar is installed **at a width that never rejected anything**. The wider the row
when the pane reopens, the longer the bar holds.

The premise is not "the record is old". It is that a promotion is evidence
**only against the width, the item set and the widths it was decided at** — and
the file already computes exactly that fact, per round, for the round counter:
`premiseShift` / `isShifted`. The record was simply not wired to it.

### 2. `blockedRef` holds one rung per item, and nothing expires it

```ts
useRef(new Map<string, { rung: number; atWidth: number }>())
```

One entry per item, and `isBlocked` matches on `bar.rung === rung` exactly. Two
things follow:

- **Barring rung 1 unbars rung 0.** The later `set` overwrites the earlier
  entry. Where the new bar's width is *narrower* than the old one's, that loses a
  live constraint: rung 0 rejected at 500px, row shrinks, rung 1 rejected at
  300px, and at 400px both rungs are now free although 500 rejected rung 0.
- **The exact match ignores an implication the ladder guarantees.** Inline widths
  are monotone — a narrower rung is never wider than a wider one — so *a
  rejection at rung j is a rejection at every rung wider than j*. Barring rung 1
  and leaving rung 0 open lets the fit promote straight past the rung it just
  learned does not fit.

And nothing sweeps the map except the item unregistering. A bar's evidence is a
statement about the occupant's **rendered content** at that moment; when the
occupant's own width moves, the rejection is about content that no longer
exists. The file already detects precisely that (`staleOthers`, on
`known.kind === "exact" && known.px !== px`) and throws the fact away. A ladder
re-declaration is worse than stale: rung indices are only meaningful against a
ladder, so a bar recorded against the old one names a different form.

### 3. `available` vs the border box — **already fixed, verified**

The third follow-up ("`available` is the border box while the overflow guard uses
the content box") landed in `ce42e619a` as part of the rigid-occupant work:
`readRowMetrics` now returns `insetPx` and `reconcile` reads
`measure(root) - metrics.insetPx`. Every downstream consumer of `available`
(the fit's budget, H2's `atWidth`, the surrender width, the re-arm comparison)
is the content box, and `widthFollowsContent` is a delta in which the inset
cancels.

It has no regression gate under a real layout engine, which is where the bug
lived — the jsdom suite replaces the measurement seam and never reads a computed
padding. One fixture closes that.

## Approach

### A. The promotion record is episode state, and carries its own width

`promoted` moves out of its free ref and into the `Episode` bundle, beside the
counters, the premise and the trace — it is scoped to exactly the same thing
they are, and `Episode` exists precisely so that "a caller able to reset half of
it" has no spelling. Two consequences fall out with no new machinery:

- `startEpisode` clears it, so every path that ends an episode (a converged
  pass, a surrender re-arm) discards the evidence with the rest.
- The premise-shift branch clears it, so a record made before the row moved is
  never read against the row that replaced it. This is the load-bearing half:
  the shift check runs on **every** deciding pass, so it covers the early
  returns without enumerating them — a pane that collapses and reopens wider
  reads as `resized`, and the record goes.

The record also carries the width it was made at:

```ts
promoted: Map<string, { rung: number; atWidth: number }>
```

and the bar is installed with `promotion.atWidth`, never with the current pass's
`available`. Where the premise held these are the same number by construction;
where a future early return is added they are not, and this is the spelling in
which the wrong one cannot be named at all.

### B. The barred rungs are a ledger, in `core/`, with the implication built in

`blockedRef`'s shape is the defect, so the shape changes. A new pure module —
`core/blocked-rungs.ts`, alongside `core/width-cache.ts`, which it deliberately
mirrors — owns the whole rule:

```ts
/** id → rung → the widest width at which a committed promotion into that rung was undone. */
export type BlockedRungs = ReadonlyMap<string, ReadonlyMap<number, number>>;
export const emptyBlockedRungs: BlockedRungs;

/** Record a rejection. Keeps the WIDEST width per (item, rung): a wider rejection subsumes a narrower one. */
export function barRung(b: BlockedRungs, id: string, rung: number, atWidth: number): BlockedRungs;

/** Is `rung` barred at this width? True when ANY rung at or narrower than it was rejected at a width this row has not yet beaten. */
export function isBarred(b: BlockedRungs, id: string, rung: number, available: number, hysteresisPx: number): boolean;

/** Forget everything about one item — it left, or its ladder was re-declared. */
export function unbarItem(b: BlockedRungs, id: string): BlockedRungs;

/** Drop every bar this width has beaten: the row is genuinely wider, so the bar is discharged by its own terms. */
export function sweepBarred(b: BlockedRungs, available: number, hysteresisPx: number): BlockedRungs;
```

`isBarred` is where the monotone implication lives, and it is the fix for "rung 1
unbars rung 0" *and* for the exact-match hole at once:

> rung `r` is barred ⟺ ∃ `j ≥ r` with `!(available > rejectedAt[j] + hysteresisPx)`

(rung 0 is the widest form, so `j ≥ r` is "at or narrower than `r`", and a
rejection there implies one at `r`.) Per-rung storage makes "one bar per item"
unspellable; the suffix rule means a bar can never be lost by recording a second
one.

`FitInput.blocked` takes `BlockedRungs` and `assign`'s `isBlocked` becomes a
call to `isBarred`. Every existing H2 test in `core/fit.test.ts` keeps its
expected placement under the new rule — checked by hand before writing this —
and they are rewritten to construct through `barRung` rather than a map literal,
so the ledger has exactly one constructor.

Three sweeps, each keyed on a fact the file already computes:

| when | why |
|---|---|
| an item's width moved at the rung it was already sitting at (the `staleOthers` branch) | the rejection was about content that has since changed size |
| a ladder is re-declared, or the item unregisters | a rung index is only meaningful against a ladder |
| the row is genuinely wider than a recorded rejection (once per pass, before the fit) | the bar's own terms are "until the row is wider"; once it is, the bar is discharged rather than dormant |

The last one is not memory hygiene — the ledger is bounded by items × rungs
either way. It is the difference between a bar that expires when its condition
is met and one that lies dormant and reactivates months later, on a row that has
been re-laid-out and re-measured since.

### C. A real-engine gate for the inset (defect 3)

A `adaptive-bar/padded-root` fixture: the same actions-only bar, with padding on
the bar root through the consumer `className` the defect was about. If the inset
were not subtracted, the fit would bless a row wider than its content box, the
row-overflow guard would fire, the remedy would floor every occupant into the
panel — and `rigidIntegrity` fails on a slot that is absent across the sweep,
which is the invariant that catches the *quiet* branch (the measurer page is a
production build, so the dev throw is compiled out).

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/core/blocked-rungs.ts` (new) | the H2 ledger: per-rung storage, the monotone `isBarred`, the sweeps |
| `plugins/primitives/plugins/adaptive-bar/core/blocked-rungs.test.ts` (new) | the implication, the widest-wins merge, the sweeps |
| `plugins/primitives/plugins/adaptive-bar/core/fit.ts` | `FitInput.blocked: BlockedRungs`; `isBlocked` delegates to `isBarred` |
| `plugins/primitives/plugins/adaptive-bar/core/fit.test.ts` | H2 cases construct through `barRung` |
| `plugins/primitives/plugins/adaptive-bar/core/index.ts` | barrel |
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | `promoted` into `Episode` with its own width; cleared by `startEpisode` and by a premise shift; `blockedRef` becomes `BlockedRungs` with its three sweeps |
| `plugins/primitives/plugins/adaptive-bar/web/__tests__/h2-bookkeeping.test.tsx` (new) | a promotion does not survive a collapse-and-reopen; a barred narrow rung does not free the wider one |
| `plugins/primitives/plugins/adaptive-bar/fixtures/**` | `adaptive-bar/padded-root` |
| `plugins/primitives/plugins/adaptive-bar/CLAUDE.md` | prose: what H2's evidence is scoped to, and why |

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar` — the new pure
   suite, the new jsdom suite, and the four existing ones unchanged.
2. `./equin check` — type-check, doc/registry sync, `layout-geometry`
   (the new fixture).
3. `./equin build`.
