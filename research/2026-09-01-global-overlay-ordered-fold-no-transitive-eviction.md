# The overlay is an ordered fold: no transitive eviction

## Context

On 2026-09-01 ~12:55 local, a user typing in the Pages app saw the block they were
typing vanish, then reappear ~90 s later, alongside a burst of slow-op
notifications. No data was lost and no report was filed.

**Incident evidence.** Host duress tripped 12:54:32 (load 29.9/18 CPU,
~245k decompressions/s), main backend event-loop p99 2993 ms, and live-state push
delivery ran 14–94 s late (`deliver:page-blocks`, `deliver:page-block-doc`,
`deliver:tasks` at 85 s). `POST /api/pages/:pageId/blocks/patch` took 11 s. On page
`block-b4f38ca7…` the DB shows the Enter at 10:55:38 UTC minting
`block-d088b561`, its text landing only at 10:57:15. The `reports` table contains
**zero** `optimistic-divergence` rows, ever — and the reporting path is fully wired
(`plugins/reports/plugins/optimistic-divergence/`, present in both generated
registries). A block visibly disappeared and nothing reported it, which localises
the eviction to the one overlay exit that is exempt from reporting.

**Root cause — cascade confirmation.** `reconcile`
(`plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts:220`) drops
a resolved op A when a newer same-target op B is `confirmed` (`supersededBy`, `:184`).
Its justification is a containment argument: *"a snapshot reflecting a newer write to
a target already CONTAINS the older resolved write's effect on that target"*. That
argument rests on premises the code does not check, and **all three fail**:

1. **B's confirmation is real evidence.** The page editor's `isPatchReflected`
   (`plugins/page/plugins/editor/web/internal/optimistic-block-ops.ts:257`) excludes
   `data` (`fieldsReflected:176`) and skips updates naming absent rows
   (`patchLanded:232`), so a patch naming only `data` — the debounced text
   projection — returns `true` against **any** snapshot, including an empty one. The
   snapshot did not *reflect* B; it merely failed to *contradict* it.
2. **A committed before B.** `retry(opId)` re-fires an op **in place**
   (`optimistic-mutation/CLAUDE.md:140`), so a retried op sits earlier in the pending
   order while committing later. The ordering premise is broken by the primitive's
   own retry path.
3. **B's evidence covers A's rows.** `sameOverlayTarget` is an **intersection** test
   (`optimistic-block-ops.ts:119`), not a subset. In the incident's own shape the
   split targets `{parent, newId}` and the projection targets `{newId}`: they
   intersect, absorption fires, and nothing vouches for the `parent` row the split
   also rewrote.

So the split was evicted on no evidence, the render fell back to stale server truth
without it, and the block reappeared only when a genuinely current push landed.

**The general statement.** The overlay is `data = pendingOps.reduce(apply, serverTruth)`
— an *ordered fold*. Removing a middle element changes the composition: dropping B
while A remains renders `A(base)` instead of `B(A(base))`, a state the user never
created. This holds **even with perfect evidence about B**. Cascade is transitive
eviction, and transitive eviction on a fold is unsound in principle, not merely
under-evidenced in practice.

This is the last non-causal exit. The 2026-07-11 never-revert rewrite
([`research/2026-07-11-global-never-revert-optimistic-edits.md`](2026-07-11-global-never-revert-optimistic-edits.md))
closed miss-limit eviction and rollback-on-failure and made denial causal (Rule B) on
the principle that *pending local edits are never visually reverted*; the editor's own
docs already assert the invariant this violates (`page/editor/CLAUDE.md:2646`: "an op
leaves the overlay only for a causal reason").

**Intended outcome.** An op leaves the overlay only for a reason that is *causal* and
*local to itself*, and never in a way that reorders the fold.

## The fix

Two changes in the pure state machine, `overlay.ts`. Nothing else changes — no hook
change, no consumer change, no public API change.

### 1. Delete supersession-by-content

Remove `supersededBy` (`:179-190`) and its branch in `reconcile` (`:242-245`), and the
`sameTarget` parameter threaded for it.

Justification that nothing is lost: with symmetric tokens, a causally-gated cascade is
provably redundant with Rule-B denial. If B is causally proven (`W > B.ack`) and A
committed first (`B.ack > A.ack`), then `W > A.ack` — exactly denial's precondition,
and A is unconfirmed by assumption, so denial drops it on the same pass. The only
branch that was *not* redundant is `hasAck(B)` with no watermark present, and rule 2
covers that case without evicting anything.

### 2. Add the ordering rule

> **An op may not LEAVE the overlay while an older, still-pending, same-target op
> survives this pass.**

- Gates **every** exit route — content, `hasAck`, coarse, and denial. Gating only
  content leaves the fold hole open through the ack channel: A deletes X, B recreates
  it, the net recompute produces no value change, so a standalone `{kind:"ack"}` frame
  confirms B *exactly* at `ackPass` while the cached pre-A snapshot shows X; drop B,
  replay A, X vanishes.
- **A denied older op does not block.** The snapshot provably lacks its effect, so the
  base is past it, not stale with respect to it.
- **Evicts nothing.** A wrong answer costs a deferred confirmation, never a reverted
  edit — the safe direction, and the never-revert policy's own preference.
- **Liveness.** Blocking runs strictly older→newer over array order, so the waits-for
  graph is a total order restricted to same-target pairs — a DAG, no cycle spellable.
  The oldest op on each target has nothing older, so it is decided exactly as today;
  when it leaves, its successor becomes oldest. Every chain drains from the front.
- **A blocked op counts no miss.** A miss is "a fresh snapshot arrived and still
  doesn't reflect the op" (`overlay.ts:68`) — evidence of non-confirmation. A pass we
  declined to evaluate is information-free, and counting it would file a `stalled`
  report about a verdict we never formed. The front of each chain still counts misses,
  so the investigation signal survives.

`sameTarget` keeps its shape, its required-ness, and its intersection semantics — only
its meaning moves from *licence to evict* to *reason to wait*. Intersection is the
correct relation for blocking (over-blocking only defers), which is why deleting
cascade removes the need for the subset relation absorption would have required.

### 3. Report classification (denial noise)

With cascade gone, a normal undo→redo files a `superseded` report: A (`delete X`) is
oldest, unblocked, unconfirmed, and denied once `W > A.ack`. That is technically
accurate but semantically wrong — the client superseded its own write; nobody lost a
race. Suppress the report (not the drop) when a newer same-target op confirmed in the
same pass. Classification being wrong costs a mis-filed report, never a lost edit,
which is the right place for a heuristic.

## Code shape

The blocking test needs each op's **final** fate before newer ops consult it, and that
fate includes denial. So `confirmPass` can no longer precompute a `confirmed[]` array
for a decision-making `reconcile`. Split the other way:

```ts
type Verdict =
  | "confirmed"      // drop, silent
  | "denied"         // drop, into `dropped` (reported)
  | "denied-silent"  // drop, self-supersession — not reported (§3)
  | "unconfirmed"    // keep, +1 miss (stalled latch)
  | "pending"        // keep, NO miss — unresolved (in flight, or failed)
  | "blocked";       // keep, NO miss — never evaluated

decideVerdicts(pending, sameTarget, evaluate): Verdict[]     // one forward loop, oldest first
reconcile(pending, verdicts, countMisses): ReconcileResult    // pure partition
```

`blocked(j)` iff ∃ `i < j` with `sameTarget(i, j)` and
`verdict[i] ∈ {pending, unconfirmed, blocked}` — i.e. an older op that SURVIVES this
pass. A just-confirmed or just-denied older op **unblocks**: it is leaving the fold.
Because the loop runs oldest-first, each op's fate is fixed before any newer op reads
it. The per-edge difference is carried by the `evaluate` callback (the resolve edge
evaluates only the resolving op), so the blocking rule itself is written once.

**A failed op is a survivor, and therefore parks its juniors.** A failed `mutate`
leaves an op unresolved — that is how never-revert keeps it rendered — so it holds
verdict `pending` and blocks newer same-target ops. A network failure self-heals on the
next reconnect edge; an HTTP failure parks them until the user hits Retry. The juniors
keep rendering correctly throughout (the fold is intact, which is the point) and accrue
no misses, and the surface is already in `error` because of the failed op. This is a
real change in overlay occupancy from the previous behaviour, where those juniors could
confirm and leave.

**Coarse mode has no ordering rule**, deliberately: `sameTarget` is the consumer's
declaration of which ops interact, and a coarse consumer supplies none, so there is no
relation to block on and no sound way to guess one. Not a regression — coarse never had
a cross-op rule. The rule is exactly as wide as the `sameTarget` a consumer supplies.

`reconcile` loses both its `sameTarget` and `denyWatermark` parameters and becomes a
pure partition plus the miss/latch bookkeeping — all the deciding moves into the loop.
It keeps the existing **return-by-identity when nothing changed** contract.

**`ReconcileResult` gains no arm.** `dropped` stays exactly the report channel
(`use-optimistic-resource.ts:253`), so `confirmed` and `denied-silent` are simply
absent from both output lists.

### Why blocking rather than absorbing, through the ack door

There is a tempting stronger rule: when B is confirmed by `hasAck` and an older
same-target A can be *token-ordered* against it (`cmp(B.ack, A.ack) > 0`), **absorb** A
alongside B rather than blocking B. That proves the departure instead of deferring it,
and it drains the pair immediately.

**Deferred, not rejected as unsound** — the design below is correct and cheap, but it
is a drain optimisation on top of a rule that is already correct without it.

Absorption on `sameTarget` would be unsound: the ack claim is deliberately narrow
(`resource-runtime/CLAUDE.md:334-337`) — *"for each W ∈ ackTx, every row of this tuple's
view that W wrote has been re-read post-commit"* — and `sameTarget` is an
**intersection**, so A may write rows B never wrote and B's ack says nothing about
those. The incident's own pair is that shape: split writes `{blockId, newId}`, the
projection writes `{newId}` only, and absorbing A would discard A's effect on the
**origin row**.

The sound relation is a subset, and it can be made to **fail closed** without widening
anything:

```ts
export function coversOverlayTarget(newer: BlockOverlayOp, older: BlockOverlayOp): boolean {
  if (older.tag !== "patch") return false;   // only a patch's target set is EXACT
  const covered = new Set(overlayOpTargets(newer));
  return overlayOpTargets(older).every((id) => covered.has(id));
}
```

Only a patch may be absorbed, because only a patch's targets are exact
(`creates ∪ updates ∪ deleteIds`, straight off `diffBlocks`' minimal diff). A structural
op's come from `opBlockIds`, an under-approximation by construction — and under a subset
test an omission on the **older** side makes it pass when it should fail. Refusing them
costs nothing: the inverse pair is patch/patch, and `optimistic-block-ops.test.ts:695`
already pins that the pair shares its full id set.

*(Amended 2026-09-02: `opBlockIds` is now `opNamedIds`, and a structural op's target set
is no longer built from it alone. The guard still stays — see the amendment at the end of
this section.)*

This also dissolves the ack-scoping worry: with a true subset, A's rows = A's declared
rows ⊆ B's declared rows ⊆ B's actually-written rows, so the ack claim covers them —
scoped deltas included, no FULL-frame precondition.

Left out of this change because the gain is small: the ordering rule already renders
correctly while an inverse pair waits, and the pair drains as soon as any
watermark-carrying frame arrives, which `page-blocks` emits on every value-changing
push. Absorption only shortens that wait, and it costs a second consumer-supplied
relation on the public args. Revisit if deferral measurably fails.

**If it is ever taken up**, the doc comment on `overlayOpTargets` must carry *both*
statements: a target set that is not exact is safe for the symmetric `sameTarget`
(monotone toward less cascading) and dangerous for `covers`'s **older** argument
(monotone toward more absorption, on rows nothing vouches for). One statement without
the other is how the old claim gets carried across.

**Amended 2026-09-02.** A structural op's target set is now the union of what the reducer
measurably wrote and what the op names
([`research/2026-09-02-page-overlay-ops-declare-rows-they-write.md`](2026-09-02-page-overlay-ops-declare-rows-they-write.md)),
so it is no longer an under-approximation by construction. The objection to absorbing it
changed shape rather than going away: the set is exact only against the base the op was
**predicted** on, which need not be the base it replays against. The counterexample this
section originally carried — A = split of `P` minting `N` and adopting `P`'s visible
children while declaring only `{P, N}` — therefore no longer constructs, because a
split's adopted children are in the set now. One that still does:

- A = split of a **collapsed** `P`, minting `N`. Nothing is adopted at dispatch, so A's
  set is `⊇ {P, N}` and names no child.
- B = a `bulkMove` naming exactly `{P, N}`.
- An expand lands between A's dispatch and A's replay, so A's replay adopts
  `C1..Ck` after all.

A naive `covers(B, A)` passes, A is absorbed, and the adoption is discarded — the
children render at their pre-split parent. The `older.tag !== "patch"` guard is still what
makes that unspellable.

While here: "only a patch's target set is exact" is a **provenance** argument, not a shape
one, and reading it as a shape one is how it would get generalised wrongly. `applyPatch`
and the server writer both cascade `deleteIds` to descendants, while the target set names
only the ids the patch itself lists. The claim holds because every patch in the wild comes
from `patchesFromDiff(diffBlocks(before, after))`, whose `deletedIds` is already the
post-cascade set. A hand-built patch deleting a subtree root would break it.

Blocking needs none of that: over-blocking only defers, so intersection is the correct
— and conservative — relation.

The cost of deferring is that an inverse pair can sit in the overlay until something
drains it. It does drain: A (`delete X`) will never confirm by content once B has
recreated X, but Rule-B denial drops it as soon as any watermark-carrying frame with
`W > A.ack` arrives, and `page-blocks` emits a FULL `update` frame carrying a watermark
on every value-changing push. Standalone ack frames occur only when a recompute
produces no value change, which is not the steady state of a live editor. The render is
correct throughout the wait. Revisit absorption only if draining measurably fails.

All three edges (`confirmPass`, `resolvePass`, `ackPass`) call `decideVerdicts` with
the inputs they already hold — `snapshotWatermark` from `getResourceWatermark` and
`hasAck` are already passed at every call site
(`use-optimistic-resource.ts:309, 336, 377`).

**Files:**

- `plugins/primitives/plugins/optimistic-mutation/web/internal/overlay.ts` — the whole
  change.
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`
  — only if the report-suppression rule needs a signal threaded to `reportOutcomes`
  (`:251-266`).

## Rejected alternatives

Record these — each was seriously considered and each would be re-proposed otherwise.

- **A causal floor on content confirmation** (reject a confirmation when
  `W < op.ackWatermark`). Fixes the incident and case 3, and is not unsound — it is a
  statement about one snapshot and evicts nothing. Rejected because it **wedges under
  the exact load it exists to survive**: `xmin` is the lowest still-running xid, so one
  long transaction pins it low cluster-wide for its lifetime, and `SOURCE_TX_CAP = 64`
  makes the runtime suppress the *entire* `sourceTx` set on overflow
  (`resource-runtime/core/runtime.ts:1889-1899` — "a missing ack is safe; a torn set is
  not"), so heavy churn kills `hasAck` too. Both routes dead at once ⇒ nothing
  confirms, the overlay grows at the user's edit rate for the whole episode, and
  replay goes O(pending × rows) per push with an O(pending²) same-target scan. It
  converts a database-side slowdown into a client-side quadratic during duress.
  It also contradicts `live-state/CLAUDE.md:250-252` outright: *"An absent watermark
  means 'no causal floor': confirming by content is fine, denial is forbidden."*
  (Note: `live-state/CLAUDE.md:260` forbids comparing *two watermarks* and explicitly
  exempts Rule B — do not cite it as calling the floor unsound; that would mislead the
  next reader into thinking Rule B is in question.)
- **A three-state `isConfirmedBy` verdict** (`confirmed | absent | no-evidence`).
  Over-engineering for one consumer, and it does not touch the defect, which is
  transitivity, not vacuity. Under it, every absence-shaped predicate (`remove`,
  `unwrap`, every `deleteIds` clause) answers `no-evidence` against an empty base too —
  by construction, not by mistake. The causal path already performs that routing.
- **Gating cascade on causal proof** instead of deleting it. Either redundant with
  denial (watermark branch) or unsound (the retry-in-place ordering break). Keeping the
  concept buys nothing.
- **A check/lint rule detecting a tautological predicate.** Statically impossible —
  `isConfirmedBy` is a closure over hook state, there is no consumer registry, and
  `Data` is arbitrary. A runtime probe against `resource.initialData` can only classify,
  never fail, since absence-shaped predicates are unfalsifiable against an empty base
  by construction.
- **Keeping the `data` exclusion but treating its output as proof.**
  `fieldsReflected`'s `compareData: false` is well-reasoned and stays — server
  normalisation and the ~1 s `data.text` projection lag would otherwise strand ops.
  What changes is only that its unfalsifiable output may no longer speak for a
  different op.

## Accepted residue

**The rule's coverage is exactly as good as `sameTarget` is accurate.**
`overlayOpTargets` deliberately under-approximates (`optimistic-block-ops.ts:91-98`):
merge rewrites an unnamed target row, split omits adopted children. So A = `merge`
(rewrites unnamed row T) and B = a patch on T do not register as same-target; B is not
blocked, an unentitled snapshot can confirm it, and A replays over T without B's
change. This is **not a regression** — cascade does not fire on that shape today
either — and it is narrow (needs the unnamed side effect, a stale-but-plausible
snapshot, and conflicting effects on one row). The right fix is at a better rung:
widen `overlayOpTargets` to name the rows an op really writes. Filed as a follow-up.

**Closed 2026-09-02.** An overlay op's target set is now the union of what the reducer
measurably wrote (a before/after diff over the op's own predicted output) and what the op
names, built once per dispatch by `predictOp`:
[`research/2026-09-02-page-overlay-ops-declare-rows-they-write.md`](2026-09-02-page-overlay-ops-declare-rows-they-write.md).
The shape above — A = `merge` rewriting an unnamed row T, B = a patch on T — now registers
as same-target, so B waits for A. What remains is narrower: the set is frozen at DISPATCH,
against the base the op was predicted on, so at replay the rows the op really writes can be
a strict superset (adoption from a racing expand, `prevVisibleLine` resolving elsewhere, a
cascade that grew). That bound is inherent — `sameTarget(a, b)` sees only the two ops,
never a base, and blocking must be decided before the replay that would measure it.

## Verification

1. `./equin test plugins/primitives/plugins/optimistic-mutation` — new
   `overlay.test.ts` cases, each named for the shape it pins:
   - **The incident.** Older unreflected `create` op + newer vacuously-confirmed
     data-only patch on an intersecting target, against a stale snapshot ⇒ the create
     survives and still replays. (This test fails on today's code — it is the
     regression gate.)
   - **Case 3.** A = `delete X` (ack 100), B = `create X` (ack 110). At `W ≤ 100` A is
     unconfirmed and undeniable, so it blocks B; both replay ⇒ X present. At
     `100 < W ≤ 110`, X absent ⇒ A confirmed, B unconfirmed, replays ⇒ X present. At
     `W > 110`, A denied and B confirmed leave together ⇒ X present.
   - **The ack fixture.** B confirmed by `hasAck` with no watermark, older A neither
     confirmable nor deniable ⇒ B is blocked, both replay ⇒ X present. Pins that
     blocking gates the ack route.
   - **Tokenless older sibling.** Same as above but A carries no `ackWatermark` at all
     ⇒ B is still blocked (blocking asks nothing about tokens), both replay ⇒ X
     present. This is the case an absorb-through-the-ack-door rule would strand, and
     it is why the rule blocks rather than absorbs.
   - **Liveness.** The oldest op on a target is never blocked; a chain of same-target
     ops drains front-first over successive passes.
   - **No miss for a blocked op**; the front of the chain still accrues them and files
     one `stalled`.
   - **Report classification.** A denial with a newer same-target op confirmed in the
     same pass files no `superseded` report; a denial without one still does.
2. `./equin test plugins/page/plugins/editor` — add the same-block tautology case
   to `optimistic-block-ops.test.ts` (its `:701` case covers only disjoint blocks).
3. `./equin test plugins/primitives/plugins/optimistic-mutation/web/__tests__` —
   the hook's jsdom suite still green (keep-rendered on both reject kinds, `online`
   auto-retry, superseded drop + sink kind).
4. `./equin check` then `./equin build`.
5. Real-app gate: extend
   `plugins/page/plugins/editor/e2e/split-typing-verify.ts`, which already documents
   reproducing under host load ("Rerunning this under host load (a few concurrent
   `./equin build`s) reproduces the original conditions"). Type through several
   Enters while the box is loaded; no block may disappear at any point. Watch
   Debug → Reports for `optimistic-divergence` rows — under the fix a `stalled` row is
   acceptable (the op stayed rendered), a `superseded` row on a plain typing flow is
   not.

> All `./equin test` / `build` invocations must run with `run_in_background: true`.

## Follow-ups (file as tasks, not part of this change)

1. ~~**Widen `overlayOpTargets` to name the rows an op really writes** (merge's rewritten
   target, split's adopted children), closing the accepted residue above.~~ **Done
   2026-09-02** —
   [`research/2026-09-02-page-overlay-ops-declare-rows-they-write.md`](2026-09-02-page-overlay-ops-declare-rows-they-write.md).
2. **Browser log ingress is unaccounted during duress.** `POST /api/logs/emit` hard-429s
   while the latch is set (`log-channels/server/internal/handle-emit.ts:12`), so
   browser-emitted channels — `live-state.jsonl` among them — thin out for the whole
   episode (~589 lines vs ~11,000 in a comparable window). The browser buffers and
   retries with backoff and marks its own drops in band, but that buffer is per-tab and
   in-memory: a tab that reloads or closes mid-episode loses it with **no trace
   anywhere**, and the server counts nothing about the 429s. Unlike traces, slow-ops and
   reports, log-channels is outside the shed engine's accounting, so no `duress-shed`
   report ever names it. "What browser observability did episode X cost us" is currently
   unanswerable.
3. **A block vanishing from a user's screen alerted nothing.** The cascade exit is
   exempt from reporting by design, so the front-door invariant ("every durable failure
   signal lands in Reports or on the Timeline") did not hold. This change removes that
   exit, but the general question — how a client-side render regression gets a signal —
   is worth its own pass.
