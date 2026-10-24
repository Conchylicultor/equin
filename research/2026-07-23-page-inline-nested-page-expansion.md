# Inline nested-page expansion — one editor, page boundary as data

## Context

Sub-page and page-link blocks currently render as clickable leaf rows: opening the target page navigates away (Miller-column pane swap). The goal is Notion-beyond: expanding such a block splices the target page's blocks **into the same BlockEditor as fully editable nested blocks** — one flat list, one selection/DnD/caret space, one undo stack. The page boundary becomes *data* (which per-page feeds are mounted), not component structure (no nested editor instances).

This is the chosen end-state (user decision, over per-page nested `<BlockEditor>` mounts). It is cheap because the architecture already agrees:

- One `page_blocks` table; pages are `type="page"` rows inside the parent's `parentId` tree. `page_id` is a denormalized "nearest page ancestor", recomputed server-side on every reparent (`recomputePageIdSubtree`, `editor/server/internal/page-id.ts:100`).
- A sub-page's shell row (id = the child pageId) is already present in the parent's `blocksResource({pageId})` feed as a void leaf; the child's content is a disjoint partition (`handle-list-blocks.ts`).
- `expanded` is a first-class column on every block row (`tables.ts:41`); `flattenTree` already prunes collapsed subtrees (`block-editor.tsx:97`); chevron = `hasChildren || handle?.collapsible === "always"` (`block-row.tsx:60-65`).
- Per-block Lexical + Yjs docs are keyed by blockId only (`use-collab-block-doc.ts`, `editor-collab`) — fully page-agnostic. Focus handles, DnD, selection, undo are blockId-keyed over whatever flat array exists.
- `BlockEditorProviderInner` (`block-editor-context.tsx:432`) is storage-agnostic behind the `BlockStore` interface (`block-store.ts:82-111`) — the injectable seam this design plugs into.

**Decisions (user-confirmed):** implement Stage 1 (sub-page) + Stage 2 (page-link) together; undo targeting a collapsed page does a *detached persist*; one-time migration collapses existing `type="page"` rows.

## Architecture: the composite BlockStore

The entire composition is a **third `BlockStore` implementation** fanning N per-page stores into one union. `BlockEditorProviderInner`, `BlockRow`, the render path (`block-editor.tsx:298` sort → `buildTree` → `flattenTree`), reducers, overlay ops, undo stack, and the CRDT layer need **zero changes**.

### New modules

- `plugins/page/plugins/editor/web/composite-block-store.tsx` — the composite host component (dynamic feed mounting + `BlockStore` composition).
- `plugins/page/plugins/editor/web/internal/composition.ts` — pure helpers (`deriveMounts`, `remapUnionParents`, `groupOpTargetsByPage`, `translateOpForStore`) — bun:test-able.

### Feed mounting (dynamic hook count)

`ServerProviderHost` (`block-editor-context.tsx:372`) becomes `CompositeServerProviderHost(basePageId)`:

```
feeds:  Map<pageId, FeedSnapshot>          // {data, serverData, pending, store}
mounts: Map<mountedPageId, anchorBlockId>  // deriveMounts(basePageId, feeds)
store:  composite BlockStore over feeds + mounts

renders one <PageFeedMount pageId onSnapshot/> per mount key
        + <BlockEditorProviderInner store={composite} pageId={basePageId} serverSync/>
```

Each `PageFeedMount` calls exactly one `useServerBlockStore(pageId)` and publishes its snapshot via an effect keyed on `[data, serverData, pending]` (reference-stable through `useOptimisticResource` memoization); unregisters on unmount. `setFeeds` bails on reference-equal snapshots (enforce with a test — convergence guard). Standard mount/unmount pattern for a varying hook set (same idiom as the per-block collab registry).

### deriveMounts — which pages subscribe (pure BFS)

Walk from the base feed: every `type="page"` row with `expanded` → identity mount (`row.id → row.id`); every `type="page-link"` row with `expanded` and a valid `data.pageId` → translated mount (`data.pageId → row.id`). Push-driven fixpoint at expansion depth. **Collapsed pages are never in `mounts` → never subscribed** (the perf bound). Guards (Stage 2):

- **Once-per-surface**: a given page mounts at most once; further expanded links to it render collapsed (with a subtle "already expanded" affordance deferred).
- **Cycle**: a page in its own expansion ancestry never mounts. Sub-pages need neither (strict tree).

### Union composition

- `data` = `remapUnionParents(concat(feeds.data), mounts)`. Sub-page: identity (child top-level rows carry `parentId = shellId` already — `handle-turn-into-page.ts:73`). Page-link: rewrite child `parentId === mountedPageId → anchorBlockId` so content nests under the link block.
- `serverData` = concat — drives union `serverIds` (collab doc-init FK gate) and `projectText`'s `liveRowsRef` with no further changes (both read off the one store).
- `pending` = base feed only — a loading expanded child contributes no rows yet but must not blank the editor.
- Global `Rank.compare` sort stays correct: cross-page rows never share a `parentId`, so every sibling comparison stays within one `(parent_id, rank)` space. (The sidebar's `docRank` problem does not apply — that was cross-parent-space comparison.)

### Write routing

Every row carries its own denormalized `pageId`; route each write to the owning page's store. Boundary keystroke guards (below) ensure every structural op stays within one page.

| Composite method | Owner resolution | Notes |
|---|---|---|
| `dispatch({tag:"op"})` | op's target ids → their `pageId` (all equal by the guards); `translateOpForStore` un-remaps anchor→real pageId for page-link mounts before dispatch | Overlay effects computed over the union are byte-identical to single-feed (verified vs `optimistic-block-ops.ts:224-274`) |
| `dispatch({tag:"patch"})` | upsert/delete ids → `pageId` | Covers `projectText`/`update`/`convertTo`/`setExpanded` + undo/redo patches. **Detached persist**: if the owning page is unmounted (undo after collapse), POST straight to that page's `/patch` with no overlay — data stays correct, invisible until re-expanded |
| `move(id, dest)` | source row's page (overlay only) | Endpoint is id-scoped (`POST /api/blocks/:id/move`), already cross-page: server recomputes `page_id` + notifies both pages. Cross-page DnD works with no precise optimistic prediction (fire-and-forget + push, as today) |
| `bulkDelete(ids)` | group by `pageId`, per-page calls | Matches bulk-delete's `WHERE page_id` ownership guard; never half-applies. Deleting a shell routes to its container page; the server cascade crosses the boundary (`collect-subtree.ts`) and soft-deletes the partition |
| `bulkMove` / `bulkDuplicate` / `paste` | anchor page (afterId/parentId/first root) | v1: assert all roots share the anchor's page, **fail loudly** otherwise (crash task) — no silent half-apply |
| `insert` / `insertFirst` | base page (unchanged, `block-editor-context.tsx:926-951`) | Bare append keeps base-page semantics |

`applyInsert` (`core/block-ops.ts:721`) needs no change and is *more* correct over the union: an inner-page top-level insert finds the shell present → `parent.type === "page"` → `pageId = parent.id`; the same op over the owning feed alone hits the existing "parent not found ⇒ parent IS the page" inference. Both agree.

### Mount-translation seams (built in Stage 1, identity until Stage 2)

- `remapUnionParents(rows, mounts)` — identity for sub-pages; parentId rewrite for page-links.
- `translateOpForStore(op, mount)` — the single seam translating union-space anchors back to real ids before a store dispatch.

Stage 2 then only teaches `deriveMounts` about page-link rows + guards and fills these two seams — no provider/reducer/routing change.

## Keystroke / reducer boundary audit

Uniform principle: compare against the **row's own** `pageId`, never the context scalar. One real hazard class: a structural op silently spanning two pages.

| Site | Change |
|---|---|
| `keystroke-intent.ts:88` `isIndented(node, pageId)` | → `node.parentId !== null && node.parentId !== node.pageId` (per-row; drop the ctx param). Fixes Backspace/Shift-Tab/empty-Enter wrongly outdenting an inner page's top-level block across the boundary. Tab-outdent at `:188` inherits the fix |
| `:164` Backspace → `merge` | Additionally require `prevVisibleLine(node).pageId === node.pageId`, else `nav left`. Guards `[A, subpage(B,C), D]`: Backspace at D must not merge into C (cross-page) |
| `:182` Delete → `mergeNext` | Additionally require `nextVisibleLine(node).pageId === node.pageId`, else `nav right` |
| `block-editor-context.tsx:964` `mergeBlock` | Defensive backstop: bail if `source.pageId !== target.pageId` |
| `applyMerge`/`applySplit` `PAGE_BLOCK_TYPE` guards, `applyInsert`, DnD `computeDrop`, memory-store `insertScopePageId` | No change (guards remain the backstop; DnD flows through the cross-page-capable move endpoint; memory mode doesn't compose) |

Boundary UX that falls out: Backspace at the first block of an expanded page → no prev sibling → `nav left` → caret lands on the shell/link row (void, focusable). Enter at the end of an inner page's last block splits within that page. The shell row remains structurally un-splittable/un-mergeable (void handle + reducer guards, unchanged).

## Block-type + server changes

- `sub-page/core/sub-page-block.ts` — add `collapsible: "always"` (toggle precedent). Required: a collapsed page has no mounted children, so `hasChildren` is false — without it no chevron would ever show. Chevron (gutter, `block-row.tsx:97`) and click-to-open (row body) already coexist spatially. `SubPageBlock` component unchanged.
- `page-link/web/components/page-link-block.tsx` (Stage 2) — resolved-link row gains the same chevron behavior via its own `expanded` column (per-link-block state — correct for a page linked from two places); guard states ("already expanded elsewhere", cycle) render collapsed.
- `editor/server/internal/handle-turn-into-page.ts` — explicitly set `expanded: true` on the converted row, so Turn into → Page deterministically keeps content visible inline.
- **Data migration** — one-time `UPDATE page_blocks SET expanded = false WHERE type = 'page'`. Existing sub-pages start collapsed; column default stays `true` (content blocks need it). Follow the `database/migrations` convention for a hand-authored data migration; goes through `./equin build`, never the runner directly.
- **No other server changes.** `{pageId}` path params are read-scope + notify keys; the composite routes to the right page. *Recorded follow-up (clean end-state):* derive pageId from anchor block ids server-side on `/op` + `/patch` (as `moveBlock` already does), killing both the path param and the client routing table.

## Explicit non-goals / unaffected surfaces

- `persist={false}` memory mode does not compose (single synthetic page; `MemoryProviderHost` unchanged; document in editor CLAUDE.md).
- read-only-view, history (per-page serialization), search/backlinks (per-block projection + `blocksChanged`), trash (cascade already crosses boundaries): unaffected — composition is an editor-surface concern.
- Undo entries remain a single per-tab, mount-scoped stack — one spliced editor keeps all entries; collapsed-page replay = detached persist (above).

## Performance

Subscriptions = expanded pages reachable from the base (collapsed contribute nothing — their `PageFeedMount` never renders). Union render is O(total visible blocks), same as one large page. Registry churn: one guarded `setFeeds` per feed push. Push-driven throughout, no polling.

## Files touched

**Stage 1 (sub-page):**
- New: `editor/web/composite-block-store.tsx`, `editor/web/internal/composition.ts` + `composition.test.ts`
- Changed: `editor/web/block-editor-context.tsx` (ServerProviderHost → composite host; mergeBlock backstop), `editor/web/internal/keystroke-intent.ts` (+ its test), `sub-page/core/sub-page-block.ts`, `editor/server/internal/handle-turn-into-page.ts`, one data-migration SQL
- Unchanged, verified: `BlockEditorProviderInner`, `block-editor.tsx` render path, `core/block-ops.ts`, `optimistic-block-ops.ts`, all server write endpoints, undo stack, CRDT layer

**Stage 2 (page-link):** `composition.ts` (`deriveMounts` page-link branch + guards, fill both translation seams), `page-link/web/components/page-link-block.tsx` (chevron + guard states)

## Risks

1. **Registry convergence** — `setFeeds` must bail on reference-equal snapshots or a push loops a render; locked by a vitest test.
2. **Cross-page multi-select bulk move/duplicate** — v1 fails loudly on mixed-page roots rather than half-applying (per fail-loudly principle); per-page batching is a follow-up if it bites.
3. **Detached persist** replays an undo into an invisible page — non-diverging by construction (straight `/patch`, no overlay), but note it in the editor CLAUDE.md.
4. **Migration semantics** — collapsing all existing page rows also affects any page row that appears as a child in another page's tree; that is exactly the sub-page set, intended.

## Verification

- **bun:test**: `composition.test.ts` — deriveMounts BFS (nested, collapsed-excluded, page-link mounts, once-per-surface + cycle guards); remapUnionParents (identity + page-link rewrite); per-page grouping; mixed-page bulk throws. `keystroke-intent.test.ts` — multi-page union fixtures: per-row `isIndented`; Backspace at D in `[A, subpage(B,C), D]` → nav-left not merge; Delete before a shell → nav-right; Backspace at the first inner block → nav-left. `block-ops.test.ts` — applyInsert under a present shell → `pageId = shell.id` (union/single-feed agreement).
- **vitest jsdom** (`editor/web/__tests__/`): two mock feeds compose into one union; child rows nest under the shell; dispatch/bulkDelete route to the correct mock store; detached persist path for an unmounted page.
- **e2e** (`bun e2e/screenshot.mjs` against `http://<worktree>.localhost:9000/pages/...`): expand a sub-page (chevron → children appear); type in a child block; Enter creates a sibling **in the child page** (assert via `query_db`: new row's `page_id` = child); Backspace at the first child → caret on the shell, no merge; drag a base block into the expanded child (then `query_db`: `page_id` recomputed); collapse → Cmd+Z → `query_db` shows the patch landed (detached persist); Stage 2: expand a page-link, verify nesting under the link row and that a second link to the same page renders collapsed.
- `./equin build` + manual pass on the worktree URL.
