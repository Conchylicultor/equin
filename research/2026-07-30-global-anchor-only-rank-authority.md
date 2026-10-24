# Anchor-only rank authority: let group-by and manual order coexist

## Context

The Pages sidebar's default view (`config/apps/pages/page-tree/pages-sidebar.jsonc`)
turns `groupBy: "origin"` on so agent-written pages segregate into their own
section. That silently suspends drag-reorder: `tree-view.tsx` drops `onMove`
whenever `groupActive`, and `data-view-body.tsx` gates `rowOrderEnabled` on
`!activeState.groupBy`. The user sees no cause — reordering just stops working.
The `starred` field's `groupable: false`
(`plugins/apps/plugins/pages/plugins/starred/web/components/starred-field.tsx:45`)
is a workaround for the same gate on the Favorites list.

Both suspensions exist for one stated reason: a per-section `TreeList` sees only
its own roots, so a rank it mints can collide with a hidden root in another
section.

### The suspension is guarding the wrong thing

Two facts found while investigating:

1. **Pages never mints a rank.** `pages-sidebar.tsx:203` already discards
   `dest.rank` and sends `{ parentId, targetId, zone }`; `handle-move-block.ts`
   mints server-side via `rankAdjacentTo` against the complete sibling set. For
   the very consumer the suspension is hurting, the hazard does not exist.

2. **The hazard is not about grouping.** The tree adapter hands `TreeList` a
   *filter-applied* set (`visibleProjected` → `sortedProjected`,
   `tree-view.tsx:256-295`). So `dest.rank` is equally wrong under an active
   filter — today, silently — for the only two consumers that still trust it
   (`tasks/task-list`, `conversations/agents`). Grouping is the third instance of
   a class, and the class is: **a rank minted client-side over whatever subset the
   client happens to hold.**

`plugins/primitives/plugins/rank/CLAUDE.md` already declares this illegitimate
("a client must send positional intent — an anchor id — and never a client-minted
rank"). `dest.rank` survives only because two consumers never migrated. So the
fix is to make it unrepresentable, not to widen the set it is computed over.

**Outcome:** grouping stops suspending drag anywhere; the `starred` opt-out and
the Pages config trade-off note both go away; two latent filter-order bugs are
fixed as a side effect.

---

## Stage 1 — One shared anchor→rank server helper

`rankAdjacentTo` exists three times: `page/editor/server/internal/forest.ts:166`
(the canonical pure shape), `conversations/.../queue/server/internal/queue-ranks.ts`,
and `rank/server`'s narrower `rankAfterSibling` (takes `afterId`, not
`(targetId, zone)` — the shape the DnD contract actually emits).

- **New** `plugins/primitives/plugins/rank/server/internal/adjacent.ts` —
  `rankAdjacentTo(rows, parentId, targetId, zone, excludeIds)`, lifted verbatim
  from `forest.ts:146-196` (keep its doc comment, it states the invariant) but
  generic over `readonly { id: string; parentId: string | null; rank: Rank | string }[]`.
  Export from the `rank/server` barrel.
  - It stays in `server/`, not `core/`, **on purpose**: the placement is what
    carries "only a holder of the complete sibling set may mint". A pure function
    in `core/` would be reachable from the browser, which is the bug.
- Delete `forest.ts`'s copy; `handle-move-block.ts` imports the shared one.
- Migrate `queue-ranks.ts`'s copy if its sibling-set semantics match; if they
  genuinely differ, leave it and say why in the queue's CLAUDE.md.
- Update `plugins/primitives/plugins/rank/CLAUDE.md` ("When to use this vs tree's
  `computeDrop`" — `rankAdjacentTo` becomes the DnD-move entry).
- Unit tests: `rank/server/internal/adjacent.test.ts` (bun:test), moving over the
  boundary cases `forest.ts` covers.

## Stage 2 — Anchor-only tree DnD contract

Make client-minted ranks impossible to express across the tree boundary.

**`plugins/primitives/plugins/tree/core/internal/tree.ts`**
- Add `resolveDropParent(rows, draggedId, zone, targetId): { parentId } | null` —
  rank-free: `child` → `target.id`, `before`/`after` → `target.parentId`, `null`
  for an unknown target.
- **Keep `computeDrop`** (rank-returning). It has one legitimate caller:
  `page/editor/web/block-editor-context.tsx:895`, which holds the *complete*
  unfiltered forest and predicts the rank only for the optimistic overlay + undo
  record — the store still sends positional intent. Re-document it as
  "complete-set holders only; every projection uses `resolveDropParent`".

**`plugins/primitives/plugins/tree/web/internal/tree-list.tsx`**
- `onMove` dest → `{ parentId: string | null; targetId: string | null; zone: "before" | "after" }`.
  Call `resolveDropParent`; keep the `isDescendant` cycle guard and the
  `child` → `{ targetId: null, zone: "after" }` normalization at `:280-287`.

**`plugins/primitives/plugins/data-view/core/internal/types.ts`**
- `HierarchyConfig.onMove` dest loses `rank`. This is the type-level forcing
  function — the two rank-trusting consumers become tsc errors.

**`plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`**
- `wrappedOnMove` (`:373-401`) drops `rank` from its dest type; the alias
  translation logic is unchanged.

**Consumer migrations**
| Consumer | Change |
|---|---|
| `apps/plugins/pages/plugins/page-tree/.../pages-sidebar.tsx:203` | No behavior change — trim the now-obsolete "never `dest.rank`" comment. |
| `tasks/plugins/task-list/web/internal/tasks-data-view.tsx:66` | `patchTask(id, { folderId, rank })` → a `moveTask` anchor endpoint mirroring `moveBlock`; server mints with `rankAdjacentTo` over the complete `folderId` sibling set. |
| `conversations/plugins/agents/web/components/agents-list.tsx:122` | `patchAgent(id, dest)` → anchor fields; `agents/server/internal/handle-update.ts:39` stops storing `body.rank` verbatim and mints over the complete `parentId` sibling set. |
| `tasks/plugins/task-deps-tree/.../deps-sources.tsx` | Already ignores rank — type-only churn. |

**Tests to update**
- `tree/core/internal/tree.test.ts` — the `computeDrop` property/simulation suites
  keep testing `computeDrop`; add a `resolveDropParent` suite.
- `data-view/plugins/tree/web/internal/project-rows.test.ts:95-105` — the alias
  duplicate-rank case currently asserts `computeDrop` returns `null` (a silently
  swallowed drag). With no client rank on the drop path that hazard is gone;
  retarget the test at what still matters — aliases render last in display order.
  Keep the minted-rank behavior in `project-rows.ts`; only its failure mode
  changes.

## Stage 3 — Un-suspend the tree under group-by

**`tree-view.tsx:440-441`** — drop `groupActive` from the gate:

```ts
const onMove = sortActive || !hierOnMove ? undefined : wrappedOnMove;
```

`sortActive` stays: a field sort genuinely overrides rank order, so a drag would
have no visible effect (Notion's model).

Cross-section drag is already unrepresentable in the tree and needs no new code:
`TreeList` mounts its own `RankReorderDndContext` (`tree-list.tsx:358`), so the
grouped path gets one DnD context per section. Document that as the reason rather
than leaving it as an accident.

Also correct by construction under partition:
- `isDescendant` runs per-section, and `bucketRowsByRootSection` keeps every
  descendant in its root's section — a subtree is never split.
- A `before`/`after` drop resolves against the target's *true* sibling set
  server-side, so a root landing between two same-section roots is placed
  correctly even when other sections' roots interleave in global rank order.

**Docs/config to update**
- `plugins/primitives/plugins/data-view/plugins/tree/CLAUDE.md` — the "Group-by"
  bullet's DnD-suspension paragraph.
- `config/apps/pages/page-tree/pages-sidebar.jsonc` — delete the "Trade-off:
  grouping suspends the tree's drag-reorder" note (verify the `// @hash` /
  `config:overrides-authored` check still passes after editing).
- `plugins/apps/plugins/pages/plugins/agent-origin/CLAUDE.md:37`.

## Stage 4 — Un-suspend the flat views under group-by

`dest.groupKey` is plumbed through `list-view.tsx:306` / `table-view.tsx:276` and
**no consumer reads it** — an unused capability. So express the capability by
handler presence (the same convention `HierarchyConfig` uses for read-only trees)
rather than adding a flag.

**`data-view/core/internal/types.ts`**
- `ManualOrderConfig.onMove` dest drops `groupKey`.
- Add optional `onReseat?(id, dest: { groupKey, targetId, zone })` — "persists a
  cross-section move as a group-field write plus a reorder". Absent ⇒ the view
  refuses cross-section drops.

**`primitives/rank-reorder/web`**
- `useRankReorderItem(id, rank, group?)` — pass `disabled` to both `useDroppable`
  calls when a drag is active whose group differs and cross-group is not allowed.
  A disabled droppable paints no indicator, so the refusal is *visible* rather
  than a silent no-op.
- `RankReorderProvider` gains optional `onReseat`; it publishes the active drag's
  group through a small context that `useRankReorderItem` reads, and cross-group
  scoping derives from `onReseat == null`. The tree uses
  `RankReorderDndContext` directly (no provider, no group context) so it is
  unaffected — its sections are already separate contexts.
- Update `rank-reorder/CLAUDE.md` "Composition with group-by".

**`data-view/web/components/data-view-body.tsx:209-214`** — drop the
`!activeState.groupBy` clause from `rowOrderEnabled`; keep the other four (each
is a real structural exclusion). Update the comment to say cross-section drops
are refused unless the config supplies `onReseat`.

`view-order` needs no change: `row-order-contribution.tsx` is already anchor-only
and `CollectRowOrder` feeds it the **full** ordered set (`row-order.tsx:96-106`,
filter-applied / search-excluded / sort-suppressed), which is not partitioned —
so `computeMoveWrites` resolves a within-section drag correctly today.

**`apps/plugins/pages/plugins/starred/web/components/starred-field.tsx:44-45`** —
remove `groupable: false` and its comment; the reason is gone.

## Stage 5 — Make the one remaining suspension visible (small)

After stages 3–4 the only thing that suspends manual order is an active field
sort. Make it say so: a muted line in
`data-view/web/components/sort/sort-builder-popover.tsx` when the surface has a
manual order and `sort.length > 0` — "Manual drag order is overridden while a
sort is set. Clear the sort to reorder." This is the last silent cause.

---

## Verification

1. `./equin build` — regenerates docs/registry; runs `./equin check`
   (`type-check` catches every unmigrated `dest.rank` consumer;
   `plugins-doc-in-sync` / `config:overrides-authored` catch doc + config drift).
2. Unit tests:
   ```bash
   bun test plugins/primitives/plugins/rank/server/internal/adjacent.test.ts
   bun test plugins/primitives/plugins/tree/core/internal/tree.test.ts
   bun test plugins/primitives/plugins/data-view/plugins/tree/web/internal/
   bun test plugins/primitives/plugins/data-view/plugins/view-order/core/internal/
   ```
3. **Pages tree (the reported bug)** — `http://<worktree>.localhost:9000/pages`
   with the default `groupBy: "origin"` view: drag a page within the **Mine**
   section, confirm it lands where dropped and survives reload; confirm no drop
   indicator appears when dragging toward the **Agent** section.
4. **Cross-check the latent filter bug** — on the Tasks tree, set a filter that
   hides some siblings, drag a visible row between two visible neighbours, clear
   the filter: the row must sit exactly where it was dropped relative to the
   previously-hidden rows (this is what silently corrupted before).
5. **Favorites list** — with `starred` groupable again, set a group-by on the
   Favorites list view and confirm drag-reorder still works within a section.
6. Rank integrity after a grouped drag:
   ```sql
   -- no two live siblings may share a rank
   SELECT parent_id, rank, count(*) FROM page_blocks
   WHERE deleted_at IS NULL GROUP BY 1,2 HAVING count(*) > 1;
   ```
   via `query_db`.
7. Optional repeatable flow:
   `plugins/apps/plugins/pages/plugins/page-tree/e2e/grouped-reorder.ts` using the
   shared e2e harness (drag under group-by, assert order after reload).

## Notes / risks

- **Stage 2 is the load-bearing one** and is a breaking type change across four
  consumers. Stages 3–5 are cheap once it lands; if the work has to be split,
  land 1+2 first (they fix real bugs on their own) and 3–5 after.
- `HierarchyConfig.getRank` may become unnecessary for `TreeList` once it no
  longer sorts by rank (display order comes from the consumer's row order).
  Deliberately **out of scope** — removing it touches every tree consumer. Worth
  filing separately.
