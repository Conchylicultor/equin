# Record `paste` and `bulkMove` on the unified undo stack

## Context

In the pages block editor, **Cmd+Z after a paste does not undo the paste** — it
silently consumes an older history entry instead. Reproduced in a real browser
on a fresh blank page:

1. Type three blocks → `["one", "two", "three", ""]`
2. Select `one`+`two` in block-selection mode, Cmd+C, Cmd+V
   → `["one", "two", "one", "two", "three", ""]` (the paste itself is correct)
3. Cmd+Z → `["one", "two", "one", "two", "three"]`

The pasted blocks are still there; what was reverted is the *previous* structural
edit (the Enter that created the trailing empty block). So undo walks backwards
through pre-paste history while the paste stays behind: a user trying to undo a
mis-paste destroys earlier work and can never remove the paste.

**Root cause.** The provider's `paste`
(`plugins/page/plugins/editor/web/block-editor-context.tsx:874`) delegates to
`store.paste`, and `pasteThroughOps` (`web/block-store.ts:134`) mints the
forest's ids and calls `store.dispatch` **directly**. It therefore never reaches
the provider's `dispatchOp` (`:928`) — the only path that calls
`recordStructural`. No undo entry for the paste is ever created.

This used to be blocked for a real reason (paste minted *server* ids, so no
inverse was computable client-side). That blocker is gone: paste is now a
`BlockOp` whose ids are minted client-side and whose after-state is exactly
`applyBlockOp`'s output.

**Scope.** Fix `paste`; close the same gap for `bulkMove`; add a per-mutation
recording test as the guardrail. Designing the guardrail surfaced two further
defects that this plan also fixes because they make the guardrail meaningless
otherwise (§2a finding, §3). `bulkDuplicate` stays open with a follow-up task —
it is the only mutation that genuinely still mints server ids.

**Intended outcome.** Every mutation reachable from the editor's context except
`bulkDuplicate` puts exactly one entry on the shared undo stack; `BlockStore` no
longer exposes a write path that can silently skip recording; and a table-driven
test makes the next omission fail loudly.

---

## The end state

Today's `BlockStore` write surface and its recording status:

| method | recorded? |
| --- | --- |
| `dispatch` | n/a — the pipeline itself (undo/redo replay goes here) |
| `move` | ✅ `recordStructural` at `:915`, with a client-predicted rank |
| `bulkDelete` | ✅ `recordStructural` at `:852`, with a hand-computed after-state |
| `bulkMove` | ❌ |
| `bulkDuplicate` | ❌ |
| `paste` | ❌ — **and it does not even need to be a store method** |

After this plan: `paste` is gone from the interface entirely (it is a `BlockOp`,
so `dispatch` is its only home), `bulkMove` follows `bulkDelete`'s shape, and
`bulkDuplicate` is the single documented remaining gap.

---

## Part 1 — Paste through `dispatchOp`

Everything the op path needs already exists and is unused:

- `OP_LABELS.paste = "Paste blocks"` (`block-editor-context.tsx:60`)
- `opFocusId`'s `case "paste"` returning `null` (`:86-90`)
- `buildOverlayOp`'s `case "paste"` delegating to `buildPasteOverlayOp`
  (`web/internal/optimistic-block-ops.ts:324`)
- the composite store's `dispatch` already routes paste ops:
  `resolveOpOwnerPage` (`web/internal/composition.ts:260`) and
  `translateOpForStore` (`:358`) both handle `"paste"`

### 1a. Move the op construction into the provider

Replace `paste` at `block-editor-context.tsx:874-884` and **relocate it below
`dispatchOp`** (`:945`) — it now closes over `dispatchOp`, so leaving it above
would be a TDZ error:

```ts
const paste = useCallback(
  (args: { blocks: SerializedBlock[]; afterId: string | null; parentId?: string | null }) => {
    const forest = withMintedIds(args.blocks);
    if (forest.length === 0) return;
    // `parentId` defaults to the PAGE's own id, not null: the reducer's forest
    // excludes the page row, so the page id is how "the content top level" is
    // addressed (see the `paste` op's `parentId` doc).
    dispatchOp({
      kind: "paste",
      forest,
      afterId: args.afterId,
      parentId: args.parentId ?? pageId,
    });
  },
  [dispatchOp, pageId],
);
```

`withMintedIds` comes from `core/serialized-block.ts` (already exported via
`../core`).

**Return type changes from `Promise<string[]>` to `void`.** All four call sites
discard the value (`block-editor.tsx:684`, `:708`, `:1020`,
`components/block-forest-paste-plugin.tsx:68`), and after this change the ids
would be an *absorbable failure*: `dispatchOp` correctly drops an op the reducer
refused (a missing anchor — `applyPaste` returns `blocks` unchanged), so
returning "the ids that were pasted" would be a lie in exactly the case a caller
would want to know about. Update the four call sites to plain calls and the
`BlockEditorContextValue.paste` signature at `:292`.

Bonus: this also removes a stuck-op path. Today a missing-anchor paste POSTs an
op both sides refuse, so it never confirms and eventually files a divergence
report. Through `dispatchOp` the empty diff is dropped before the network.

### 1b. Delete `paste` from the store seam

- `web/block-store.ts` — delete `pasteThroughOps` (`:134-154`), the `paste`
  member of the `BlockStore` interface (`:107-111`), and both implementations
  (`:250-257`, `:414-421`). Drop the now-unused `buildPasteOverlayOp` and
  `SerializedBlock` imports; keep `withMintedIds` (the memory `bulkDuplicate`
  still uses it).
- `web/composite-block-store.tsx` — delete the routed `paste` (`:283-301`), its
  entry in the `useMemo` store object, and the `SerializedBlock` import.
- `web/internal/optimistic-block-ops.ts` — `buildPasteOverlayOp` loses its last
  external consumer (verified: the only references are `block-store.ts` and its
  own file; no test names it); un-export it. This is the structural half of the
  fix: with no exported paste-overlay builder and no `store.paste`, a paste can
  only reach the pipeline through `dispatchOp`.

### Routing equivalence (verified)

| case | old path | new path |
| --- | --- | --- |
| `afterId` set | composite `paste` → `rowOwnerPage` | `resolveOpOwnerPage` → `rowOwnerPage` (same call) |
| anchorless, `parentId` null/undefined | `insertOwnerPage(rows, null, …)` → base page; owner store sets `parentId = its pageId` | provider sets `parentId = pageId` (base); `insertOwnerPage(rows, basePageId, …)` → base (the page row is absent from its own feed, so it returns `parentId`) |
| anchorless, `parentId` = an expanded page-link anchor | composite translates via `translateUnionParentId` | `translateOpForStore` rewrites `op.parentId` anchor → real page id (`:358-363`) |

`args.parentId ?? pageId` is `??`, so the `parentId: null` that
`fileDropPosition` (`block-editor.tsx:954`) returns for a top-level drop is
handled identically to today. With `afterId` set, `applyPaste` ignores
`op.parentId` entirely (`core/block-ops.ts:945`), so the default is inert there.
The memory path is unaffected: `MemoryProviderHost` passes the same `pageId` to
both `useMemoryBlockStore` and `BlockEditorProviderInner`.

---

## Part 2 — Record `bulkMove`

`bulkMove` (`block-editor-context.tsx:858`) is a pass-through with no recording
and no optimistic overlay. It needs no new machinery — it is
**`bulkDelete`'s shape plus `move`'s rank prediction**, both already in the file.
The missing piece is the rank algebra, currently duplicated between
`useMemoryBlockStore.bulkMove` (`web/block-store.ts:350`) and
`handleBulkMoveBlock` (`server/internal/handle-bulk-move-block.ts`).

Extracting it turned up three real divergences, not just duplication:

1. **The memory store has no cycle guard.** The server refuses
   `parentId ∈ moving` and `isDescendant(rows, root, parentId)` with two
   distinct 400s (`handle-bulk-move-block.ts:28-38`); the memory store has
   neither. The drag path cannot currently produce it (`currentTarget()` returns
   `null` inside `bulk.subtree`), so it is latent — but in-memory mode would
   build an orphaned cycle.
2. **Root order is nondeterministic and the two sides disagree.** *(verified)*
   `selectionRoots` preserves **input array order**
   (`primitives/plugins/tree/core/internal/tree.ts:62-64`). The server feeds it
   `loadPageBlocks`, a plain `select` with **no `ORDER BY`**
   (`server/internal/forest.ts:60`) — i.e. Postgres heap order, which `UPDATE`s
   rewrite. So which moved root gets which minted rank is effectively arbitrary,
   and a multi-block drag can silently scramble the selection's internal order.
   The client would feed `rowsRef.current`, which is a **global rank sort**
   (`block-editor.tsx:398`) — and this plugin's own CLAUDE.md documents that a
   global rank sort is *not* document order. So client prediction and server
   mint disagree for any selection spanning parents. Recording an undo entry off
   a prediction that disagrees with the commit is not sound, so this must be
   fixed here: order the roots with `inDocumentOrder` (`core/block-ops.ts:374`),
   exactly as `foldIndent`/`foldOutdent` already do and for the same reason.
3. **The rank window's source legitimately differs.** The server computes it
   over `loadLiveSiblings(tx, parentId)` — every live row with that `parent_id`,
   *unscoped by page* — because a destination `page` row's children are absent
   from the page-scoped `rows`. This one must stay parameterized.

### 2a. `planBulkMove` + `applyBulkMove` in `core/block-ops.ts`

**Home: `core/block-ops.ts`.** `core/block-forest.ts` is the declared home of
shared bulk/insert logic and `planForestInsert` is the structural twin — but the
helper needs `inDocumentOrder`, which lives in `block-ops.ts`, and `block-ops.ts`
already imports `block-forest.ts`; putting it there means a cycle or relocating
`documentOrder`. `block-ops.ts` already imports every input (`Rank`,
`isDescendant`, `selectionRoots`, `subtreeIds`, `rankWindow`) — zero new imports.
Put it next to the folds.

**Named `plan*`, not `fold*`.** "Fold" in this file means a per-element fold with
*partial* refusal (`foldIndent` skips a blocked block and cascades; `Fold =
{next, moved}`). `bulkMove` is all-or-nothing — a destination inside the moving
selection has no correct partial answer — so a `moved` subset would imply a state
that cannot occur. `plan*` also matches `planForestInsert`.

**It returns placements, not nodes**, so the server can adopt it (it needs
`parkRanks`-shaped rows plus per-row `UPDATE`s, not a forest). A second tiny
applier keeps the two clients byte-identical — which is a correctness
requirement, not DRY: if the provider's predicted `after` and the memory store's
committed rows differ, the recorded undo patch is wrong.

```ts
/** Where one selection root lands. Field-compatible with `parkRanks`' RankPlacement. */
export interface BulkMovePlacement {
  id: string;
  /** The parent the row sits under NOW — the scope `parkRanks` parks it in. */
  currentParentId: string | null;
  parentId: string | null;
  /** Stored string form, like every `BlockNode.rank`. */
  rank: string;
}

export type BulkMoveRefusal = "empty-selection" | "into-selection" | "into-own-subtree";

export interface BulkMovePlan {
  /** In DOCUMENT order. Empty iff `refusal !== null`. */
  placements: BulkMovePlacement[];
  /** The selection roots, document-ordered (what each writer re-reads / notifies). */
  roots: string[];
  expandParentId: string | null;
  refusal: BulkMoveRefusal | null;
}

export function planBulkMove(
  blocks: BlockNode[],
  args: { ids: readonly string[]; parentId: string | null; afterId: string | null },
  destSiblings: BlockNode[] = blocks,
): BulkMovePlan;

/** Apply a plan to a forest: reparent + re-rank each placement, open the destination. */
export function applyBulkMove(blocks: BlockNode[], plan: BulkMovePlan): BlockNode[];
```

Body — the server's current arithmetic verbatim, plus the document-order sort:

```ts
const moving = new Set(args.ids);
const roots = inDocumentOrder(blocks, selectionRoots(blocks, moving));
if (roots.length === 0) return refused("empty-selection");
if (args.parentId !== null) {
  if (moving.has(args.parentId)) return refused("into-selection");
  for (const root of roots) {
    if (isDescendant(blocks, root, args.parentId)) return refused("into-own-subtree");
  }
}
const movingSubtree = new Set(roots.flatMap((r) => subtreeIds(blocks, r)));
const [prev, next] = rankWindow(destSiblings, args.parentId, args.afterId, movingSubtree);
const ranks = Rank.nBetween(prev, next, roots.length);
const byId = new Map(blocks.map((b) => [b.id, b]));
const placements = roots.map((id, i) => ({
  id, currentParentId: byId.get(id)!.parentId, parentId: args.parentId, rank: ranks[i]!.toJSON(),
}));
return { placements, roots, expandParentId: args.parentId, refusal: null };
```

Document `destSiblings` hard: *"MUST be the COMPLETE live sibling set under
`parentId` — every row with that parent, unfiltered by page and by type. It
defaults to `blocks` because a client holds its page's forest whole; the server
MUST pass `loadLiveSiblings(tx, parentId)`, since a destination page row's
children are absent from a page-scoped load and a window over it would mint
`"a0"` straight onto that sub-page's existing first child."*

**Guards return a reason, they do not throw.** A pure core helper must not throw
`HttpError` (wrong layer) and must not silently no-op (the server owes the user
two distinguishable 400s). The clients treat any refusal as drop-before-record —
the same discipline `dispatchOp` uses for an empty reducer diff (`:936-940`).

`applyBulkMove` deliberately does **not** recompute `pageId`, the same in-page
invariant `applyMove` documents (`:1069`); the server keeps
`recomputePageIdSubtree`, and the composite store already refuses cross-page bulk
moves outright (`composite-block-store.tsx:261-267`). It also does **not** run
`pruneEmptyAnchors` — `bulkMove` bypasses the reducer on both sides, matching
`bulkDelete`'s hand-computed after-state.

### 2b. Adoption

**Memory store** (`web/block-store.ts:350`) — collapses to four lines
(`planBulkMove` → bail on `refusal` → `commit(fromNodes(applyBulkMove(…), cur))`),
gaining the cycle guard and document ordering it lacks today.

**Provider** (`block-editor-context.tsx:858`):

```ts
const bulkMove = useCallback(
  (args: { ids: string[]; parentId: string | null; afterId: string | null }) => {
    if (args.ids.length === 0) return;
    // Positional intent goes to the store (the server owns rank authority), but
    // this editor holds the page's forest whole, so it can predict the placement
    // locally for the undo record — exactly as `move` does. No optimistic
    // overlay: the forward write is still the bespoke endpoint, like `bulkDelete`.
    const before = rowsRef.current;
    const plan = planBulkMove(toNodes(before), args);
    if (plan.refusal) return;
    const after = fromNodes(applyBulkMove(toNodes(before), plan), before);
    recordStructural(before, after, "Move blocks", null);
    store.bulkMove(args);
  },
  [store, recordStructural],
);
```

`focusId: null` for the reason `bulkDelete` passes null — focus lives on the
selection container, not in a row. `"Move blocks"` is a literal, mirroring
`"Delete blocks"` (`bulkMove` is not a `BlockOp`, so it has no `OP_LABELS`
entry). The composite path needs nothing new: recorded patches carry union-space
parents, which `groupPatchByOwnerPage` + `translatePatchForStore` already handle
(`composition.ts:270-334`), including detached-persist into a collapsed page.

**Server** (`handle-bulk-move-block.ts`) — adopts it, keeping `parkRanks`,
`recomputePageIdSubtree`, the by-id re-read and the both-scopes `blocksChanged`
fan-out. Only the *planning* moves:

```ts
const plan = planBulkMove(rows.map(rowToNode), body, destSiblings.map(rowToNode));
if (plan.refusal === "empty-selection") return;
if (plan.refusal === "into-selection") throw new HttpError(400, "Cannot move blocks into the selection");
if (plan.refusal === "into-own-subtree") throw new HttpError(400, "Cannot move a block into its own subtree");
await parkRanks(tx, { placements: plan.placements });
```

**The one real cost: the plan call moves INSIDE the transaction**, because the
window comes from `loadLiveSiblings(tx, …)`. Two observable consequences, both
benign but both to check: the 400s now abort an open (empty) transaction rather
than firing before it, and `requireLiveParent`'s 404 now *precedes* the
"into own subtree" 400 instead of following it. **Check
`server/internal/parent-liveness.test.ts` for an assertion on that precedence.**
If moving the transaction boundary is rejected on review, the fallback is: the
two clients adopt the helper and the server keeps its own composition — that
deduplicates 2 of 3 but leaves divergence (2) live on the server, which is the
main reason to share at all.

### Hazards — checked; one new instance, no new class

- **Cmd+Z before the forward push lands (checked, safe in the primitive).** With
  no overlay the rows are still pre-move, so the undo patch is already reflected
  and `applyOverlayOp` throws `OpNoLongerApplies`. That only drops the op from
  the *rendered* fold (`optimistic-mutation/web/internal/overlay.ts:108-141`);
  `dispatch` calls `runMutate` unconditionally
  (`use-optimistic-resource.ts:411-427`), so the inverse patch is still POSTed,
  and it confirms immediately on the resolve edge — no zombie, no divergence
  report.
- **The residual race is at the server**, between two fire-and-forget POSTs with
  no ordering guarantee. If the patch commits first it is a no-op write and the
  bulk-move then wins — the undo is silently lost. This is **not a new class**:
  `move` (the same gesture at N=1) and `bulkDelete` are already exactly this
  shape. Shipping `bulkMove` unrecorded is strictly worse than shipping it with a
  race it shares with its own N=1 twin. Out of scope; the honest fix is the
  endgame below.
- **Predicted ranks in the redo patch.** The wire carries no rank, so a redo
  writes the client's predicted keys, which can differ from the server's mint and
  collide with an untouched sibling's `(parent_id, rank)`. Same exposure `move`
  already has, and fixing divergence (2) shrinks it. Transient collisions on the
  undo patch itself are already handled — `handlePatchBlocks` parks re-ranked
  rows (`handle-patch-blocks.ts:129-157`).
- **Endgame, for the CLAUDE.md, not this plan:** promote `bulkMove` to a real
  `BlockOp` exactly as `paste` was. `OpEffect.reparent` already expresses it and
  `buildOverlayOp`'s move arm already predicts it; the missing pieces are a
  reducer arm, `opBlockIds`/`resolveOpOwnerPage`/`translateOpForStore` arms, and
  `parkRanks` inside `handle-apply-block-op`. That collapses forward write, undo
  and redo onto one endpoint and one optimistic instance, killing the race.

---

## Part 3 — Fix the data-blind apply-guard

Designing the guardrail surfaced a second live defect. `isPatchReflected`
(`web/internal/optimistic-block-ops.ts:148-172`) compares `parentId`, `type`,
`rank`, `expanded` — deliberately **not `data`** — and `applyOverlayOp` throws
`OpNoLongerApplies` whenever it returns true (`:277-279`). A
`BlockEditorAPI.update(data)` patch changes only `data`. Therefore:

- **Memory mode: the forward `update` and its undo are both silently swallowed.**
  `useMemoryBlockStore.dispatch` catches `OpNoLongerApplies` and keeps the
  current rows (`block-store.ts:304-309`), so a to-do checkbox, callout color or
  image-width edit in `persist={false}` mode does *nothing at all*.
- **Server mode: correct but never optimistic.** The overlay drops the patch, so
  the edit is invisible until the server push; `isConfirmedBy` returns true
  immediately, so it confirms cleanly and files no report. A fast localhost hides
  it, which is why it has gone unnoticed.

**The predicate cannot simply be tightened** — it doubles as the *confirmation*
predicate against server truth, where `data` legitimately differs
(`parseBlockData` normalization, a lagging `data.text` projection). Tightening it
would make ops stop confirming.

**Fix: split it.** Both predicates live in the same file, so this touches no
primitive:

- `isPatchReflected(blocks, patch)` — unchanged, structural columns only. Stays
  the `isConfirmedBy` predicate in `useServerBlockStore` (`block-store.ts:190`).
- new `isPatchAbsorbed(blocks, patch)` — the structural check **plus** a deep
  equality on `data`. Used by `applyOverlayOp` (`:278`) only, as the apply-guard.

Document the asymmetry on both: the guard asks "would applying this change
anything *here*", confirmation asks "does server truth prove my write landed",
and `data` belongs in the first question but not the second.

**One risk to verify while implementing:** `projectText` patches are `updateOnly`
and data-only, so under the strict guard they become overlay-applied instead of
dropped. That should be inert — "bound editors never re-read `data.text` from a
patch", the editor's CLAUDE.md — but confirm against
`e2e/crdt-typing-verify.ts` and `e2e/crdt-undo-verify.ts` that no echo or
double-apply appears.

---

## Part 4 — The guardrail: a per-mutation recording test

New `plugins/page/plugins/editor/web/__tests__/structural-undo.test.tsx`,
auto-discovered by the root `vitest.config.ts`.

Mountable in jsdom **provider-only** — `BlockEditorProviderInner` renders
`children` and nothing else, and nothing on the memory path touches Lexical,
live-state, TanStack Query, `surfaceId` or the network:

```tsx
<PluginProvider plugins={[]}>
  <UndoRedoProvider>
    <BlockEditorProvider pageId="page-1" persist={false} initialBlocks={seed}>
      <Harness sink={ctxRef} />
    </BlockEditorProvider>
  </UndoRedoProvider>
</PluginProvider>
```

- `PluginProvider` (`@plugins/framework/plugins/web-sdk/core`) is **mandatory**:
  `useAnchorTypes`/`useBlockHandles` call `Editor.Block.useContributions()`,
  which throws without `PluginRuntimeContext` (`web-sdk/core/slots.ts:28-31`).
  An **empty** plugin list is the right fidelity — anchor types only affect the
  childless-anchor prune and split/merge refusals, handles only `wrapOnConvert`.
  Precedent: `primitives/plugins/app-shell/web/__tests__/toolbar-contribution-driven.test.tsx:28-40`.
- `UndoRedoProvider` is a plain scoped-store context — no `surfaceId`, no
  shortcuts binding (the test calls `ctx.undo()` directly, which is how
  `TabSurface` already separates the stack from the key bindings).
- **No other providers and no `vi.mock`s.** Start with zero; the neighbouring
  tests' mocks were for provider-level network paths this harness never enters.

**The load-bearing shim.** `rowsRef` is populated by a *consumer* effect —
`BlockEditorInner` calls `setRows`/`setFlatOrder` (`block-editor.tsx:405-408`,
verified). Without it every mutation reads an empty `rowsRef` and no-ops. So
`Harness` must mirror the same derivation (`[...ctx.blocks].sort(Rank.compare)`,
byte-for-byte what `BlockEditorInner` feeds it) and call both setters in an
effect. This is the folder's sanctioned pattern — `block-selection.test.tsx`'s
`FakeBlockEditor` stands in for a block's Lexical editor for the same reason.
State the fidelity caveat in the file header. Do **not** render the real
`<BlockEditor>`: it would need every block type registered plus Lexical + a Yjs
binding per row in a layout-less DOM, against the folder's convention.

Seed with `MemoryBlockEditor`'s own recipe verbatim
(`block-editor.tsx:337-347`: `planForestInsert` + `withMintedIds` + `fromNodes`)
so fixture rows are shape-identical to production's, over a forest with **depth**
(`A`, `A/A1`, `B`, `C`) — a flat seed lets a same-parent rank sort masquerade as
document order and would hide divergence (2). Stub `crypto.randomUUID` with a
counter for readable assertions.

**The invariant is a quadruple, not a pair.** "`canUndo` flipped + undo restores
the prior rows" passes *vacuously* when the forward mutation did nothing — which
is exactly how the `update` bug in Part 3 has been hiding. Assert:

1. the forward mutation **changed** the row set,
2. `canUndo` went `false → true`,
3. `undo()` restores the prior set **exactly** (compare
   `{id, parentId, type, rank, expanded, data}` tuples),
4. `redo()` reproduces the post-mutation set.

Table-driven over one `expectRecorded(mutate)`, each case in its own `render()`
so the stack starts empty and the 500 ms coalesce window cannot merge cases.
Cases: `paste`, `bulkMove`, `bulkDelete`, `move`, `indentBlocks`/`outdentBlocks`
(plus a fully-refused set recording **nothing**), `insert`/`insertFirst`,
`unwrapBlock`, `convertTo`, `update` (green only after Part 3), and `split` at
offset 0. Also assert the two deliberate exclusions stay excluded: `setExpanded`
and `projectText` must not flip `canUndo`.

**Exclude `merge`/`mergeNext`, deliberately and in the header.** With no mounted
focus handle, `mergeBlock` takes the offscreen branch into
`appendRunsToBlockDoc`, which `fetchEndpoint`s two doc endpoints
(`use-collab-block-doc.ts:760-787`) — a different subject needing endpoint mocks.
Merge and split-with-doc-edit belong to `e2e/crdt-undo-verify.ts`.

Drive everything through `await act(async () => …)`: `undo()` fires
`void runGuarded(...)` and `split` defers its record one microtask.

### Plus one e2e phase for the reported sequence

Add a phase to `e2e/copy-paste-verify.ts` (which already builds the
three-typed-block fixture and does the selection copy/paste): after the paste,
press Cmd+Z and assert the pasted blocks are gone **and** the trailing empty
block survives — the exact inverse of the reported symptom, against the real
optimistic + push pipeline.

---

## Files touched

| file | change |
| --- | --- |
| `core/block-ops.ts` | add `planBulkMove` + `applyBulkMove` (+ their types) next to the folds; export from `core/index.ts`; fix the stale `pruneEmptyAnchors` doc at `:508-512`, which still lists `paste` among the paths that "bypass the reducer" — `applyBlockOp` prunes after every op including paste |
| `web/block-editor-context.tsx` | `paste` → `dispatchOp` (moved below it), returns `void`; `bulkMove` predicts + records; context signature for `paste` |
| `web/block-store.ts` | delete `pasteThroughOps` + `paste` from the interface and both stores; memory `bulkMove` adopts the helper |
| `web/composite-block-store.tsx` | delete the routed `paste` |
| `web/internal/optimistic-block-ops.ts` | un-export `buildPasteOverlayOp`; add `isPatchAbsorbed` and use it in `applyOverlayOp` (Part 3) |
| `server/internal/handle-bulk-move-block.ts` | adopt `planBulkMove` inside the transaction; keep `parkRanks` / `recomputePageIdSubtree` / notify |
| `web/components/block-editor.tsx`, `web/components/block-forest-paste-plugin.tsx` | 4 `paste` call sites drop the `await`/`void` |
| `core/block-ops.test.ts` | `describe("planBulkMove")`: document-order determinism (shuffle the input array → identical placements), both refusals, same-parent reorder, `destSiblings ≠ blocks`, plan∘apply round trip |
| `web/internal/optimistic-block-ops.test.ts` | `isPatchAbsorbed` vs `isPatchReflected` — the data-only case is absorbed by one and reflected by the other |
| `web/__tests__/structural-undo.test.tsx` | new |
| `e2e/copy-paste-verify.ts` | undo-after-paste phase |
| `plugins/page/plugins/editor/CLAUDE.md` | rewrite the "Not recorded" paragraph (only `bulkDuplicate` remains); drop the "Paste is an op" bullet explaining why `store.paste` bypasses `dispatchOp`; note the apply-guard vs confirmation asymmetry; note the `bulkMove`-as-`BlockOp` endgame |

`docs/plugins-details.md` / `plugins-compact.md` regenerate via `./equin build`.

## Follow-up task to file (`add_task`)

**Record `bulkDuplicate` on the undo stack.** The last unrecorded editor
mutation. It mints ids **server-side** (`insertForest`,
`server/internal/forest.ts:97`, whose comment explains that server-minting is
what makes it the duplicate path), so no client-computed after-state exists.

- *(recommended)* mint client-side and reuse the paste op — the memory store
  already implements exactly this (`serializeSubtree` + `withMintedIds` +
  `planForestInsert`, `block-store.ts:380-409`). Also makes duplicate optimistic
  and lets `insertForest`'s server-minting path be deleted. Open design
  question: N selection roots means N anchors, hence N ops and N undo entries
  where the user expects one. Either extend the `paste` op to carry multiple
  `{forest, afterId}` placements (one op, one entry — cleanest) or add
  transaction grouping to the `undo-redo` primitive.
- *(rejected)* await the endpoint and record from the returned rows — the record
  would land asynchronously, leaving exactly the window where Cmd+Z hits the
  wrong entry. That is this bug, reintroduced narrower.

## Verification

1. `./equin build`
2. `bun test plugins/page/plugins/editor/core/block-ops.test.ts` and
   `bun test plugins/page/plugins/editor/web/internal/optimistic-block-ops.test.ts`
3. `bun run test:dom plugins/page/plugins/editor` — the per-mutation invariant
4. Server handler tests, incl. `server/internal/parent-liveness.test.ts` (the
   4xx-precedence change in §2b)
5. `bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts` — includes the repro
6. `bun plugins/page/plugins/editor/e2e/paste-optimistic-verify.ts` — paste is
   still optimistic (`dispatchOp` records *before* dispatching; this must not
   have cost the instant overlay)
7. `bun plugins/page/plugins/editor/e2e/block-selection-verify.ts` — selection
   drag/reorder with the new refusal path
8. `bun plugins/page/plugins/editor/e2e/crdt-undo-verify.ts` and
   `crdt-typing-verify.ts` — text/structure interleaving, and the Part 3 risk
   (projection patches now reaching the overlay)
9. Manual at `http://<worktree>.localhost:9000/pages`: the reported sequence
   (three blocks → select two → copy → paste → Cmd+Z removes exactly the two
   pasted blocks; Cmd+Shift+Z restores them); a multi-select drag reorder then
   Cmd+Z; a to-do checkbox toggle in a `/prompt`-free page and in the website
   `editor-toy` demo (memory mode — broken today, per Part 3); all of it once
   more inside an expanded nested page.
10. `./equin check`
