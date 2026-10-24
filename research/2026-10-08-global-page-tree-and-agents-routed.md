# Page tree, page-links and agents onto routed collections, and deleting the legacy resource surface

**Status:** plan, awaiting approval.
**Follows:** P8 (steps 16·0–24): `research/2026-10-08-global-scoped-change-routing-p8-steps-23-24.md`, and Resources page items 3 and 9.
**Verified at:** HEAD `863fafa6fa`. Two workflows produced the evidence:
- four area mappers, each with an adversarial verifier;
- a three-design judge panel scoring correctness, architecture and cost.

---

## 1. Context

After P8, the task tree and the conversation lists are routed `all` collections. Three DB-backed resources still run on the legacy path, where **any write to a table they read reloads every tuple in full**:

| Key | Today | Write load on main |
|---|---|---|
| `pages` | `resourceDescriptor` + flat `defineResource({mode:"push"})`, read with `useResource` (20 sites). `loadPages` re-mints `docRank` per sibling group. | Every `page_blocks` write re-runs the membership select and a recursive CTE over the whole forest (~700 writes a day), including the ~1 s `data.text` typing projection. |
| `page-links` | Same spelling; DISTINCT `(source, target)` over `page_links`. One reader, the sidebar alias map. | Every `page_links` write. |
| `agents` | `serveValue` over `agents_v`, `preload: "boot"`, L2-persisted. | Every `agents` write; low traffic. |

These three are what keep the following alive:
- the `live:legacy-descriptors-pinned` check and `PINNED_LEGACY_DESCRIPTORS`;
- `ResourceDescriptor.initialData` and `resourceDescriptor`'s `initialData` parameter;
- `useResource`'s placeholder path;
- the `live/no-legacy-resource-spelling` debt exemptions. There are **11 entries in 11 manifests, covering 21 paths** (17 web, 4 core/server), not 12. All cite the dropped `task-1791372067670-epcpji` and "item 3".

**Outcome.**
- All three resources are routed `all` collections, so a write refreshes only the rows it changes.
- A keystroke in a page costs **0** live-state queries, down from 2 global ones today.
- Every legacy item listed above is deleted.
- The Read-set pane's Legacy FULL section loses `pages`, `page-links` and `agents`.

## 2. The core problem: `docRank`

**Why `docRank` exists.**
- The sidebar orders sub-pages in document order.
- A sub-page sits either directly in its parent page, or inside a content block: on main, 19 pages sit under one content block and 1 under two (a to-do inside a to-do).
- A row's `rank` is only comparable with the ranks of rows under the same direct parent. So siblings in one sidebar group come from different rank spaces, and their raw ranks can collide.
- `loadPages` fixes this on every load: `docOrderPaths` computes rank paths, the loader sorts each group, then mints a fresh `Rank.nBetween(group.length)` per group.

**Why that does not survive routing.** A routed collection refreshes only the rows a write names. `docRank` breaks that in two ways:
- one page insert changes every sibling's `docRank`;
- dragging a content block that holds a sub-page moves the sub-page without any write to the sub-page's row.

**Decision (D1): store the order as a real column, maintained at the one structural-write chokepoint.**
- `page_blocks.doc_rank` is a `rank_text` column, kept for page rows in the page's own `page_id` partition.
- The server re-mints only the pages whose position changed. After that, a reorder is an ordinary row write, which routing already handles.
- This reverses the documented rule that "docRank is never persisted".
- It still **never appears in a request body**: clients keep sending positional intent (`moveBlock { parentId, targetId, zone }`).
- Rejected: shipping each page's ancestor chain through `closureJoin` and re-minting on the client. That would need a new `parent_id` index (the dependents probe measured 757 ms without one), an A37 fix that touches tasks, and a compiler change to the closure seed. It also probes on every structural edit and still re-mints whole groups.

## 3. Decisions

| # | Decision |
|---|---|
| D1 | `doc_rank` is a persisted, writer-derived column (§2, §4.1). |
| D2 | **Rename all three keys:** `pages` → `pages.tree`, `page-links` → `page-links.sources`, `agents` → `agents.roster`. All three are non-keyed today. Reusing a key passes the C39 sub-ack, but the old client then throws `no keyOf registered` on the first keyed delta (`notifications-client.ts:2035-2041`). A renamed key gives old tabs `unknown-key`, which shows the skew/Reload prompt. The `agents` L2 row is swept as unusable. |
| D3 | `page-links` becomes its **own links-owned collection**. It cannot fold into the page row: `links/server` already imports `editor/server` (`links/server/index.ts:7`, `tables.ts:2`, `delete-hook.ts:9`, `resources.ts:11`), so editor joining `_pageLinks` would create an import cycle. |
| D4 | `pages.tree` and `page-links.sources` keep today's **no preload**: no L2 row, and no work while the Pages app is closed. `agents.roster` keeps `preload: "boot"`. |
| D5 | Point readers of pages move to `useLiveRow(pagesTree, id)`; whole-set readers use `useLive`. The `stale` value on the error arm survives, because `useLive` returns the same `ResourceResult` (`use-resource.ts:256-274`). |
| D6 | **Kept:** `useResource` and `useResources` (the substrate of `useLive` and `useOptimisticResource`), and the flat `defineResource({…})` overload plus the runtime's private `acceptAnyParams` (no production caller remains, but about 95 test sites use them). Removing the test-only overload is out of scope. |
| D7 | `agents_v` stays: five REST handlers read it. `AgentSchema` keeps `isFolder`, bound as `expr(prompt IS NULL)`, because the schema is also the HTTP contract. |
| D8 | `GET /api/pages` becomes a plain select of live pages ordered by `(page_id, doc_rank)`, so no second order derivation survives. Its only caller is the auto-icon e2e. |

## 4. Design

### 4.1 `doc_rank` (page/editor)

**Schema** (`editor/server/internal/tables.ts`):
- add `docRank: rankText("doc_rank")`, nullable, so content blocks hold NULL;
- `touchedBy: docRank: false`, so a re-mint does not move Recent pages' `updatedAt`;
- the migration is generated by `./equin build`;
- no unique index on `(page_id, doc_rank)`. The reconcile asserts uniqueness of its own output instead, and throws otherwise.

**Invariant I-DR.** For each partition P (live page rows sharing `page_id`; NULL is the root partition), ordering by `doc_rank` equals the order `docOrderPaths` + `comparePaths` give today: rank-ordered DFS pre-order, stopping at nested pages.

**Maintenance inside `withPageForest`** (`page-forest.ts:144-178`). It is the only producer of `PageForestTx` (tsc enforces it, and the `page-editor/no-adhoc-forest-write` lint closes the back door). After `fn(ctx)` and before `currentTxId`, it reconciles the **dirty partitions**:
- **Recording dirty partitions:**
  - Marks go only in the **lowest-level mutators**, so composite writers inherit them: `insertBlocks`, `updateBlockFields` (only when it writes `parentId`, `rank`, `type`, `pageId` or `deletedAt`, and recording both the old and new `page_id`), `trashBlockRoots`, `untrashBlockRoots`, `deleteBlockRoots`, and `recomputePageIdSubtree`.
  - `recomputePageIdSubtree` uses `UPDATE … RETURNING` to record both the old and new partitions. This closes the turn-into-page and cross-page-move gap the judges found (`page-id.ts:107-145`).
  - Marks are recorded through a module-private `WeakMap<PageForestTx, Set<scope>>`.
- **Reconcile per dirty partition P:**
  1. Run `docOrderPaths(tx, { pageIds: [P] })`: the existing upward CTE, seeded only by P's live sub-pages.
  2. Sort in JS with `comparePaths`. The collation note at `page-doc-order.ts:51-56` still applies.
  3. Run `planDocRanks` (new, pure, in editor `core/`). It keeps the longest strictly-increasing run of the existing keys and re-mints each other run with `Rank.nBetween(prev, next, n)`, returning only the changes.
  4. UPDATE only those rows. A page row turned into a content block gets `doc_rank = NULL`.
- **What it costs:**

  | Write | Extra work |
  |---|---|
  | Data-only (typing projection, rename, icon, kind, `expanded`) | 0 queries |
  | Structural op in a page with no sub-pages | 1 indexed CTE, 0 rows returned |
  | Drag that reorders k sub-pages | at most k UPDATEs, usually 1 |

**Boot reconcile** (editor `onReadyBlocking`, after migrations). The barrier completes before the gateway hot-swaps traffic.
- It runs the global `docOrderPaths()`, then `planDocRanks` per partition, and writes the changes. This is idempotent and cheap: about 110 rows.
- The first boot of each database (main and each fork) is the backfill.
- On any later boot, a change means some writer bypassed the marks. It is written and **filed as a report** (fail loudly).

**Docs:** rewrite `core/schemas.ts:67-84` and the editor CLAUDE.md section "The sidebar's ordering space is docRank". Delete the stale story-gallery / blog-panel mentions (`resources.ts:39`, `page-doc-order.test.ts:227`).

### 4.2 `pages.tree`

**Declaration** (`editor/core/resources.ts`). It replaces `pagesResource`, and `PageRowSchema` is unchanged:

```ts
liveCollection("pages.tree", {
  row: PageRowSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: { reason: "the sidebar renders every page; the [[ and link pickers filter by title locally" },
  },
});
```

**Order.**
- `createdAt` satisfies A29, which requires a base column.
- It never changes, so a `doc_rank` U is an in-place upsert with no `orderOf`.
- The client orders by `docRank`, as it does today.

**Serve** (`editor/server/internal/page-rows.ts`, following the `*-rows.ts` precedent of `task-rows.ts` and `agent-launch-rows.ts`):
- `from: _blocks`;
- `where: type = 'page' AND deleted_at IS NULL`;
- the 9 block wire columns, bound by name;
- `docRank`, bound to `doc_rank` and claimed `notNull`, which I-DR backs. A leaked NULL fails `RankSchema` decode loudly.

Confirm the exact binding spelling (by name, or an `expr` used to claim non-null) at implementation time. `serveCollection` then spreads `served.declare`, which replaces `Resource.Declare(pagesLiveResource)` at `editor/server/index.ts:147`.

**Deleted:** `pagesLiveResource`, `loadPages`'s JS mint and its barrel exports.

**Routing per write.** The identity route reads every column except `trash_entry_id`, so the change-feed puts a gate on it.

| Write | Loads |
|---|---|
| Typing projection on a content block | 0 (value role, non-member dropped) |
| Rename / icon / cover / kind | 1-row refill |
| Toggle drag that reorders sub-pages | Refill of exactly the re-minted rows |
| Create / restore / turn-into-page | 1 refill + 1 `orderOf` |
| Trash | Exit, 0 loads |

**Readers** (20 call sites across 18 files):
- `useLive(pagesTree)`: sidebar, `usePageOptions`, breadcrumb, delete action, recent pages.
- `useLiveRow(pagesTree, id)`: header, cover, kind control, `useResolvePage`, `usePageTitle`, `useBlockTarget(Title)`, and the page-link block, inline node and the four chips (`page-link-chip` ×2, `instructions-page-chip`, `page-ref-chip`), plus prompt-origin.
- `usePageOptions`' public type moves off `mapResource` / `matchResource`, and so do its two callers (`page-link-block.tsx:119`, `inline-page-link-plugin.tsx:82`).
- Check each reader for loading→`[]` collapse, as `live-state/no-pending-data-collapse` requires. `page-kind-control` keeps waiting for the push.

### 4.3 `page-links.sources` (page/links)

**Declaration:**

```ts
liveCollection("page-links.sources", {
  row: { id, linkedFrom: string[] },
  id: "id",
  all: {
    orderBy: [["id", "asc"]],
    unbounded: { reason: "one row per live page" },
  },
});
```

**Serve:**
- `from: _blocks`, `where: type = 'page' AND deleted_at IS NULL`;
- `childrenJoin` over `_pageLinks`:
  - `fk: targetPageId`, which satisfies A37 through the non-partial `page_links_target_idx`;
  - `where: source <> target`;
  - aggregate `array_agg(DISTINCT source_page_id ORDER BY source_page_id)`, with `sqlType: 'text[]'`, `notNull`, `ifNone: ARRAY[]::text[]` and the decoder `parsed(z.array(z.string()), …)`. This follows the tasks `dependencies` precedent (`task-rows.ts:126-140`).

**Routing.**
- A `page_links` write refills the target row only.
- Typing writes skip at the gate: this route reads only `id`, `type` and `deleted_at`.
- Edges into a trashed target drop out naturally.

**Sidebar.** `getAliasParents: b => sourcesById.get(b.id) ?? NO_LINK_PARENTS`. A loading or error state still means "no aliases", as an enrichment does today (`pages-sidebar.tsx:82`).

**Deleted:** `pageLinksLiveResource`, `pageLinksResource`, and `PageLinkEdgeSchema` / `PageLinkEdge`, which lose their only users.

### 4.4 `agents.roster` (conversations/agents)

**Declaration:**

```ts
liveCollection("agents.roster", {
  row: AgentSchema,
  id: "id",
  all: {
    orderBy: [["rank", "asc"], ["createdAt", "asc"]],
    unbounded: { reason: "hand-grown roster, rendered whole" },
  },
  preload: "boot",
});
```

**Serve** (`agents/server/internal/agent-rows.ts`):
- `from: _agents`;
- `isFolder: expr(sql\`(${prompt} IS NULL)\`, { decoder: Boolean, sqlType: "boolean", notNull: true })`, the precedent at `conversation-rows.ts:35-40`.

**Readers.** The six `useLive(agentRows)` readers keep their `ResourceResult<Agent[]>` type. The by-id readers (`panes.tsx:45,87`, `agent-detail`, the avatars) move to `useLiveRow`.

**Docs.** The agents CLAUDE.md claim at `:15-22` that "serveCollection cannot bind" is stale; rewrite it.

## 5. Legacy deletions, once all three have landed

**primitives/live-state:**
- delete `resourceDescriptor`, `ResourceDescriptorOptions`, `acceptAnyParams` and `ResourceDescriptor.initialData` (`core/resource.ts:15-17,35-48,123-130,167-189`) and their barrel exports;
- remove `useResource`'s placeholder path (`use-resource.ts:360-361,384-401,603-604`; the `enabled` gate becomes "gated unless on-demand");
- remove `queryResult`'s `landed` parameter (its one caller is `use-resource.ts:681`);
- drop `gate` if it proves redundant without a placeholder; otherwise keep it and say why;
- rewrite the stale placeholder comments: `notifications-client.ts`, `resolvable.ts:25`, `resource-utils.ts:17`, `optimistic-mutation` `use-optimistic-resource.ts:295,581`, `overlay.ts:568`, `live-state-stale-drop-kind.ts:35`.

**Type brands:** remove `initialData?: never` from `window.ts`, `live-collection.ts`, `live-value.ts`, `window-descriptor.ts` and query-resource `contracts.ts`, together with their `"initialData" in` assertions.

**network/live:**
- delete `check/legacy-descriptors(.test).ts`;
- in `check/index.ts`, delete `:1` (the `typescript` import), `:13-17`, `:155-185` and the `legacyDescriptorsPinned` export entry. `contributedColumnsServed` stays.
- The lint rule keeps the deleted names listed (D38). Fix its header comment, and the CLAUDE.md claim that `lint/index.test.ts` enforces stale entries: that file does not exist, and the real enforcer is unused-exemption detection.

**Tooling:**
- `resource-vocabulary`: delete the `resourceDescriptor` entry (tsc forces it) and the doc at `:144-146`;
- `eager-tier-gen.test.ts` and `parse-resources.test.ts`: rewrite their fixtures to `liveValue(…)`;
- `parse-resources.ts` keeps its flat-form branch while the overload exists (D6), but its comment no longer names `pagesResource`.

**Tests built on `resourceDescriptor`:** `use-resource-gate-latch`, `use-resource-error-gate`, `notifications-http-fetch`, `notifications-subs` and `overlay.test` move to `allResourceDescriptor` or `liveValue` fixtures.

**Exemptions:**
- delete each of the 11 debt entries together with its file's migration (type-check reports unused exemptions);
- nine manifests become empty and are deleted;
- `page-tree` and `editor` keep their other entries.

**Docs:**
- root `CLAUDE.md:252-256`, the old-spellings line;
- `network/live/CLAUDE.md:770-783` ("Declared legacy-full (item 9)");
- `live-state/CLAUDE.md:54-72` and its other placeholder mentions;
- `server-core/CLAUDE.md:175`;
- `resource-runtime/CLAUDE.md:17-19`;
- the links, agents, prompt-origin, active-data/page-link and artifacts/page CLAUDE.md files.

Then regenerate the autogen and `docs/plugins-details.md` with a build.

## 6. Build sequence

Each step ends green on `./equin check` and on `./equin test` over the plugins it touches.

| # | Step | Behaviour change |
|---|---|---|
| 1 | `agents.roster`: declaration, `agent-rows.ts`, readers, docs, oracle + parity + C39 tests | `agents` becomes routed |
| 2 | `doc_rank`: column, `planDocRanks`, the marks, reconcile in `withPageForest`, boot reconcile + drift report, writer oracle. The old `pages` resource still serves; `GET /api/pages` switches to the column (D8). | The column is maintained; no reader change yet |
| 3 | `pages.tree`: declaration, `page-rows.ts`, 20 reader sites, `usePageOptions` type, 8 of the 11 exemption entries | Page tree becomes routed |
| 4 | `page-links.sources` + sidebar alias map + the links exemption, which deletes the links manifest | page-links becomes routed |
| 5 | §5 legacy deletions, docs, autogen | None intended |
| — | One background `./equin build` and the e2e at the end. **STOP** for review. | |

## 7. Verification

**Unit / property:** `planDocRanks` output is strictly ordered and unique; it changes nothing when the input is already ordered, changes one row for one move, and fills NULLs.

**Writer oracle** (editor, db-test-fixture). Random sequences of `applyBlockOp` (move, indent, outdent, bulkMove, paste, splice, unwrap), patches, trash/restore, cross-page moves and turn-into-page. After each step:
- I-DR holds against the global `docOrderPaths()`;
- the boot reconcile is a no-op;
- the depth-2 case is covered (drag the outer to-do of a to-do-under-to-do);
- a query counter shows a data-only patch issues 0 reconcile queries.

**Routed oracles** on the shared tree harness (`tasks-core/server/testing/tree-oracle.ts` pattern):

| Collection | Write | Expected loads |
|---|---|---|
| pages | typing projection | 0 |
| pages | toggle drag | refill of only the reordered page ids |
| pages | rename | 1 |
| pages | insert | 1 refill + 1 `orderOf` |
| pages | trash | exit |
| page-links | edge insert/delete | the target row only |
| agents | rename | 1 |
| agents | rank move | 1 refill + 1 `orderOf` |

Each oracle also converges to a fresh FULL.

**Parity:**
- `pages.tree`, grouped and sorted by `docRank`, equals the old `loadPages` order on a seeded forest;
- `page-links.sources` equals the old DISTINCT loader;
- `agents.roster` equals `agents_v`.
- Rewrite the read-set assertion at `page-doc-order.test.ts:347-356` onto the new key.

**C39:** a `subscribeAsOldDescriptor` test per old key (`pages`, `page-links`, `agents`) asserts `unknown-key`.

**After deploy:**
- **Routed trigger layouts:** `page_blocks` gains a gated layout and `page_links` / `agents` gain routed layouts.
- **Read-set pane** (`/debug/read-set`): the three new keys appear under routed, and none of them under Legacy FULL.
- **e2e** `page-tree-live-verify.ts` (new, in page-tree `e2e/`):
  - typing in a text block produces no `pages.tree` frame;
  - dragging a to-do that holds a sub-page produces one `pages.tree` upsert for that sub-page, and the sidebar order follows;
  - renaming produces one upsert;
  - adding a `[[link]]` produces one `page-links.sources` upsert.
- **Boot:** after the backfill, a second boot reports no drift.

## 8. Risks

1. **A missed dirty mark is silent until the next boot reconcile, which reports it.** Mitigations:
   - the marks sit only in the lowest-level mutators, including `recomputePageIdSubtree`;
   - the writer oracle fuzzes every op kind against `docOrderPaths`;
   - the boot drift report.
2. **An old backend writing during a hot-swap does not maintain `doc_rank`.** It lasts at most until the next structural write in that page or the next boot, and the boot reports it.
3. **The `page_blocks` gate compares `data` (jsonb) on every UPDATE statement.** This is per-statement trigger CPU, far below today's 2 global queries per write. Measure it after deploy.
4. **Reader churn (20 sites).** The result type is unchanged (`ResourceResult`), and the `stale` error arm is preserved.

## 9. Known limits

- About 24 other DB-backed `serveValue`s, and the external entries with a read-set, stay legacy-FULL by design. Values are never routed (`compile-value.ts:177-183`), so `applyLegacyFullChange` and the pane's Legacy FULL section stay.
- The flat `defineResource` / `defineExternalResource` overloads stay, for tests only (D6).
- A37's `leadsIndex` accepts partial indexes (`grouped.ts:1133-1146` ignores `where`). This is a real latent hole that this plan does not depend on. File it as its own task.
