# Block ops declare the rows they write, not only the rows they name

## Context

The optimistic overlay is an ordered fold, `data = pendingOps.reduce(apply, serverTruth)`.
The [2026-09-01 ordering rule](2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md)
keeps that fold intact by making an op **wait**: an op may not leave the overlay while an
older, still-pending, same-target op survives the pass. "Same-target" is the consumer's own
relation — for the page editor, `sameOverlayTarget` in
`plugins/page/plugins/editor/web/internal/optimistic-block-ops.ts`.

That doc filed its own residue, and this is it:

> The rule's coverage is exactly as good as `sameTarget` is accurate. `overlayOpTargets`
> deliberately under-approximates: merge rewrites an unnamed target row, split omits adopted
> children. […] The right fix is at a better rung: widen `overlayOpTargets` to name the rows
> an op really writes.

Concretely: a patch variant's targets are exact (`creates ∪ updates ∪ deleteIds`), but a
structural op's come from `opBlockIds(op)` — a pure function of the op, so it can only name
what the op *mentions*. The reducer writes more than that: split adopts the origin's visible
children, merge rewrites the unnamed target row `T` and re-ranks adopted children,
`revealAround` flips `expanded` on ancestors, `pruneEmptyAnchors` deletes emptied containers,
delete cascades subtrees, unwrap promotes children. So two ops that genuinely interact in the
fold can fail to register as same-target — a merge rewrites `T`, a later patch on `T` is
confirmed vacuously by an unentitled snapshot and leaves, and the merge then replays over `T`
without it.

Not a regression (the same hole exists today), but it is the one gap the ordering rule cannot
cover, and it is the reason the deferred "absorb through the ack door" optimisation still has
to refuse structural ops outright.

**Intended outcome:** an overlay op declares every row it writes, so the ordering rule's
coverage stops depending on which rows an op happened to mention.

## The change

### 1. `targets` is a union, not a replacement

```
targets = writtenIds(before, after)  ∪  opNamedIds(op)
```

The obvious design — replace `opBlockIds` with the reducer's own before→after diff — is
**wrong**, because the diff is *smaller* than the named set in real cases:

| op | named today | diff-derived |
|---|---|---|
| split at offset 0 with a tail (identity arm) | `{blockId, newId}` | `{newId}` — the origin is returned untouched |
| split at END of line, projection caught up | `{blockId, newId}` | `{newId}` — `withRuns` writes byte-identical `data.text` |
| partially-refused `indent` / `outdent` | all `blockIds` | only the ones that moved |
| `bulkMove` | whole selection incl. descendants | only the roots that moved |

Dropping `blockId` from an end-of-line split would *re-open* the incident's own shape (a later
patch on the origin row would no longer be blocked). The union is monotone: coverage never
decreases against today, and it gains merge's `T`, split's adopted children, delete's cascade,
unwrap's promotion, and the ancestors `revealAround` opens.

Over-approximating is the sanctioned direction — `optimistic-mutation`'s own docs say
intersection, not subset, and over-matching only defers a departure.

**Accepted cost, stated so it is not rediscovered:** a wider relation also widens
`classifySelfSupersession`, so marginally more denials are reclassified `denied-silent` and
fewer `superseded` reports are filed. That trades report precision for fold integrity, which
is the direction the primitive already chose. If the report signal ever matters, the fix is a
narrow relation for classification and a wide one for blocking — at the primitive, not here.

### 2. One prediction per dispatch: `predictOp`

`buildOverlayOp(op, rows, ctx)` re-runs the reducer that its callers *already ran* one line
earlier (`fromOpResult`), so a wrong `(before, after, ctx)` triple is spellable at every call
site. Replace both with one function that derives everything:

```ts
// web/internal/optimistic-block-ops.ts
export function predictOp(
  op: BlockOp,
  before: Block[],
  ctx: BlockOpContext = {},
): { after: Block[]; written: string[]; vars: BlockOverlayOp };
```

- One `applyBlockOp` run per dispatch instead of two.
- `after` has no parameter, so it cannot disagree with `before` or be built with a different
  `ctx` — the rung-1 form of the hazard `buildOverlayOp`'s doc comment currently warns about.
- `predictMoves` reads the before/after maps instead of re-running the reducer.
- `fromOpResult` and `buildOverlayOp` stop existing; `buildPatchOverlayOp` is unchanged.

`written` is returned **separately** from `vars.targets` because the union makes `targets`
never empty, while `written.length === 0` is exactly "the reducer refused this op" — the test
`dispatchOp` uses today via its own `diffBlocks` call, which goes away.

### 3. `BlockOverlayOp` carries the set

```ts
export type BlockOverlayOp =
  | { tag: "op"; op: BlockOp; effect: OpEffect; targets: ReadonlySet<string> }
  | { tag: "patch"; patch: BlockPatch };
```

`overlayOpTargets` returns `v.targets` for the op arm and keeps deriving for the patch arm — a
patch's set is exact from the patch itself, so storing it would only let it drift. A
`ReadonlySet` (not an array plus a memo) because exact sets are bigger — a paste now names its
whole forest — and `blockedByOlder` is O(pending²) calls. Nothing serialises `vars`
(`describeOp` returns a string; the divergence report carries no raw vars), so a Set is free.

**`OpEffect` and `isReflected` are deliberately untouched.** Confirmation and the apply-guard
keep exactly the semantics that shipped yesterday; only the blocking relation widens.

### 4. `opBlockIds` → `opNamedIds`

The two functions will sit one module apart, which is precisely when the misreading recurs. The
new name says what it is: the rows an op **names**, never a write set.

## What this closes, and what it does not

**Closed:** the residue case, for every merge that actually rewrites `T`. `applyMerge` writes
`withRuns(T, mergeRuns(...))` (plus `expanded` and the adopted children's ranks), so `T` lands
in `writtenIds`, the later patch on `T` intersects, and it is blocked until the merge leaves.

**Correctly excluded:** an empty childless merge (Backspace on a blank line) writes `T`
byte-identically, so `T` is absent from `targets`. That is right, not a miss — the merge's
replay cannot clobber a patch on a row it does not write.

**Still open — prediction vs. replay.** `targets` is frozen at dispatch against the rows the op
was predicted on. At replay the base can differ, so the *actual* written set can be a strict
superset: adoption that appeared because a racing expand landed, `prevVisibleLine` resolving to
a different `T'`, a cascade that grew, `pruneEmptyAnchors` firing. This is inherent —
`sameTarget(a, b)` sees only `vars`, never a base, and blocking must be decided before replay.
It is narrower than today's gap but not zero.

**Therefore absorption stays deferred, and the docs must record a *change of objection*, not a
removal.** Before: an op's targets are an under-approximation *by construction*, so
`coversOverlayTarget`'s subset test is unsound in principle. After: they are exact *against the
base they were predicted on*, which need not be the base the op replays against — so the subset
test is unsound in *fact*, over a narrower but real set of interleavings. The
`older.tag !== "patch"` guard stays. Constructible counterexample to write down: A = split of a
**collapsed** `P` (no adoption at dispatch, `targets ⊇ {P, N}`); B = a `bulkMove` naming exactly
`{P, N}`; an expand lands in between, so A's replay adopts `C1..Ck`. A naive `covers(B, A)`
passes and the adoption is discarded.

While there: the existing claim "only a patch's target set is exact" is a **provenance**
argument, not a shape one. `applyPatch` (and the server writer) cascade `deleteIds` to
descendants, while `overlayOpTargets` returns only the named ids. It holds today because every
patch in the wild comes from `patchesFromDiff(diffBlocks(before, after))`, whose `deletedIds` is
already the post-cascade set. A hand-built patch deleting a subtree root would break it.

## Files

- **`core/block-diff.ts`** — factor the per-column comparison out of `changedFields` into one
  private table (`parentId`/`type`/`expanded` → `!==`, `rank` → `String()`, `data` →
  `dataEqual`), then add `writtenIds<T extends …>(before: readonly T[], after: readonly T[])`
  = inserted ∪ changed ∪ deleted, both sides pinned to one type parameter. Header comment must
  say **why rank is compared by string**: `fromNodes` mints a fresh `Rank` per row, so `!==`
  here would mark every row written and turn `sameTarget` into a tautology.
- **`core/block-ops.ts`** — rename `opBlockIds` → `opNamedIds`; rewrite its doc to "the rows an
  op NAMES — never a write set; `writtenIds(before, after)` is the write set, and `predictOp`
  unions the two."
- **`core/index.ts`** — export `writtenIds`; rename the `opBlockIds` export.
- **`web/internal/optimistic-block-ops.ts`** — `targets` on the op arm; `overlayOpTargets`
  returns it; `predictOp` replaces `buildOverlayOp` (fold `buildForestOverlayOp` into it);
  `predictMoves` onto before/after `Block` maps; add `narrowDeleteOverlayOp(v, blockIds)` so
  `composition.ts` never spells the literal.
- **`web/block-editor-context.tsx`** — delete `fromOpResult`; `dispatchOp` (~1146),
  `applyOverlay` (~1329) and the mounted-merge dispatch (~1495) each call `predictOp` once;
  `dispatchOp`'s refusal test becomes `written.length === 0`.
- **`web/internal/composition.ts`** — `splitOpByOwnerPage` uses `narrowDeleteOverlayOp`;
  `translateOpForStore`'s rebuild carries `targets` (ids are never anchor-translated). Fix the
  justification: a per-page op carries the whole gesture's union-space set, and a foreign-page
  id can only produce a spurious match between two ops already in that page's list — which
  only defers.
- **Server dead code** (`server/internal/{handle-apply-block-op,handle-patch-blocks,notify-structural-change}.ts`)
  — `notifyStructuralChange` passes no `blockId`, and `blockId != null` is the only gate on
  `notifyBlockChange`'s `type` branch, so `primaryType` reduces to
  `blocksChanged.emit({ pageId })` and both handlers' `touchedTypes` / `primaryType`
  derivations are dead. Drop the `primaryType` parameter, emit directly, and delete both
  derivations. `notifyBlockChange` keeps its four other callers, three of which do pass
  `blockId`, so its page branch stays live.

### The one dangerous line

`predictMoves` moves onto `Block` maps, where `rank` is a `Rank` instance. `PredictedMove.rank`
is a **string** and `movedTo` compares `String(b.rank) === m.rank`. Emit `String(next.rank)` and
compare `String(prev.rank) === String(next.rank)`. Emitting a `Rank` there silently breaks
`isReflected` for every reparent op: nothing ever confirms, ops stick, and a `stalled`
divergence report follows.

## Tests

`core/block-diff.test.ts`

1. **The rank trap** — `writtenIds(rows, rows.map(r => ({ ...r, rank: Rank.from(String(r.rank)) })))`
   is `[]`. Highest-value test here; identity comparison would make every row "written".
2. Inserted ∪ changed ∪ deleted, one of each in a single diff.
3. **One definition of changed** — property test over fuzzed row pairs:
   `writtenIds([a],[b]).length > 0 ⟺ Object.keys(changedFields(a,b)).length > 0`.

`web/internal/optimistic-block-ops.test.ts`

4. **The residue case** — `[T(text), M(text)]`, `merge{blockId: M}` vs a patch on `T` ⇒
   `sameOverlayTarget` true (fails today). Negative twin: an **empty** childless `M` ⇒ `T` is
   not a target, with the comment saying why that is correct.
5. **Split adoption** — split of `P` with visible children `C1,C2` names both in `targets`.
6. **The union is monotone** — identity split (`position: 0`, non-empty tail): `written` is
   `["NEW"]` yet `targets` still contains `blockId`. Same for an end-of-line split against a
   caught-up projection, and for a partially-refused `indent`.
7. **Paste names its whole forest** while `effect.create.ids` stays roots-only — both asserted
   in one test so they cannot be conflated.
8. Rename the existing `"structural ops target the rows the BlockOp names"` to
   `"… names OR writes"` — its title is the claim that changed. Update the ~14 two-arg
   `buildOverlayOp` call sites to `predictOp(...).vars`.

`web/internal/composition.test.ts`

9. The four hand-built `{tag:"op"}` literals become tsc errors under the required `targets` —
   fix them, and add: the delete fan-out preserves `targets`, and `translateOpForStore` leaves
   `targets` untouched while rewriting `effect.moves`.

`web/__tests__/structural-undo.test.tsx` needs no change; it is the net that catches a
`predictOp` whose `after` disagrees with what the store applies.

## Docs to update (this is half the point of the change)

- `plugins/page/plugins/editor/CLAUDE.md` — the paragraph at ~:1254 ("`opBlockIds`' split case
  stays `[blockId, newId]`, deliberately omitting adopted children") is currently the statement
  of the residue and becomes wrong. Replace with the union rule and the prediction-vs-replay
  bound.
- `plugins/primitives/plugins/optimistic-mutation/CLAUDE.md` — the "Coverage is exactly as good
  as `sameTarget` is accurate … Accepted residue" bullet (~:327) gets its follow-up marked done
  *with the remaining bound*; the deferred-absorption bullet (~:362) gets the change-of-objection
  wording.
- `research/2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md` — "Accepted
  residue" points here; "Why blocking rather than absorbing" gets the new counterexample and
  the provenance caveat on "only a patch's target set is exact".
- Autogen blocks (`plugins-doc-in-sync`) regenerate on build.

## Verification

1. `./equin test plugins/page/plugins/editor` — the suites above; test 4 is the
   regression gate (red before, green after).
2. `./equin test plugins/primitives/plugins/optimistic-mutation` — the ordering-rule
   suite must stay green; this change only feeds it a wider relation.
3. `./equin check` (type-check, boundaries, `plugins-doc-in-sync`), then
   `./equin build` — both with `run_in_background: true`.
4. Real-app gate: `plugins/page/plugins/editor/e2e/split-typing-verify.ts` against
   `http://att-1788274995-733s.localhost:9000`. Type through several Enters, indent/outdent, and
   Backspace-merge under host load (a couple of concurrent builds). No block may disappear, and
   Debug → Reports must show no `optimistic-divergence` rows — a `stalled` row would mean an op
   stopped confirming, which is the failure mode a wrong `predictMoves` rank produces.
5. Sanity on the widening: with several pending ops on one page, ops should still drain (the
   oldest on a target is never blocked). A chain that stops draining would show as growing
   overlay occupancy and eventually a `stalled` report.
