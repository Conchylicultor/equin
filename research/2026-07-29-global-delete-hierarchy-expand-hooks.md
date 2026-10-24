# Delete `HierarchyConfig.isExpanded` / `onToggleExpanded`

Follow-up to
[`2026-07-28-global-tree-collapse-state-as-view-state.md`](./2026-07-28-global-tree-collapse-state-as-view-state.md),
which moved tasks and agents off the pair. This finishes the job by removing the
pair itself.

## Context

`HierarchyConfig.isExpanded` and `.onToggleExpanded`
(`data-view/core/internal/types.ts:70,77`) are **independently optional**.
Supplying only one yields a chevron that writes to the data-view primitive's own
expand map and then reads its value back off the row — a toggle that silently
does nothing. Nothing prevents that half-wired state, and no check can: the
defect is that the API admits it.

`isExpanded` also **shadows** the primitive's per-`(surface, view-instance, row)`
expand map entirely (`project-rows.ts:94-98`), so any consumer supplying it opts
out of the one mechanism designed for this state.

Deleting the pair makes both problems unrepresentable rather than merely
discouraged. That requires every remaining consumer to drop it.

### There are four consumers, not three

The prior doc's follow-up listed three. It missed the Pages sidebar.

| Consumer | Backing store today | Action |
|---|---|---|
| `code-explorer/web/components/file-tree.tsx:164` | local `useState<Set>`, empty (all collapsed) + a render-time ancestor union for the selected file | migrate |
| `studio/explorer/web/components/plugin-tree.tsx:115` | local `useState<Set>` seeded to every expandable id, re-exported through its own React context | migrate |
| `config_v2/settings/web/components/config-nav.tsx:137` | local `useState<Set>` of **collapsed** ids, empty (all expanded) | migrate |
| `pages/page-tree/web/components/pages-sidebar.tsx:181` | the `page_blocks.expanded` **DB column** | migrate (decoupled — see below) |

None of the first three is expressing domain state: two are saying nothing more
than "start expanded", and code-explorer's ancestor force-expand duplicates
`TreeList`'s native reveal-on-select (`tree-list.tsx:323-347`).

### Pages: the sidebar arrow and the in-document arrow are one switch

A sub-page has an expand arrow in **two** places, and today both write the same
`page_blocks.expanded` row:

1. the **sidebar tree** arrow, which reveals sub-pages in the nav;
2. the **in-document** arrow on the sub-page row inside its parent's body, which
   mounts the child page's full content inline, live and editable
   (`sub-page-block.ts:22` `collapsible: "always"` → `composition.ts:62-98`
   `deriveMounts` subscribes a whole extra block feed per expanded page row).

So a sidebar nav gesture today embeds a child page's content into its parent's
document, stamps `updatedAt`, and fans out `blocksChanged` — a search reindex
plus a debounced history snapshot (`handle-update-block.ts:33-51`, `notify.ts`).
It is the same class of bug the prior change fixed for tasks, with an added
visible document side effect. It also can't differ between the sidebar's two view
instances or across devices.

**Decision: decouple.** The sidebar tree drops its hooks and uses the device-local
expand map like every other nav tree. `page_blocks.expanded` stays exactly as it
is — genuine document content, driven only by the in-document arrow. This matches
Notion (its sidebar arrow reveals nav children; it does not embed the page). No
schema change, no editor change: three lines leave `pages-sidebar.tsx`.

*Accepted consequences:* expanding in the sidebar no longer mounts the sub-page
inline in its parent's body and no longer marks the page edited; expanding a
sub-page in a document no longer moves the sidebar arrow; sidebar expansion
becomes per-browser rather than server-shared.

### One affordance needs a new home

code-explorer toggles a folder when its row **body** is clicked
(`file-tree.tsx:211-217` → its local `toggle`), using the state it is about to
lose. This is re-homed in the tree primitive as a **stateless predicate**
(`expandOnActivate`, Step 1) — it carries no state, so unlike the pair it cannot
be half-wired. config_v2's config nav gets the affordance for free: its group
header rows are click-inert today (`config-nav.tsx:119-131` returns early).

## Plan

Ordered so the repo compiles and the app works at the end of every step.

### Step 1 — `expandOnActivate` in the tree primitive

A predicate on the tree row: "activating this row toggles its expansion instead
of selecting it."

- `primitives/tree/web/internal/types.ts` — add
  `expandOnActivate?: (row: T) => boolean` to **`TreeListProps`** and to
  **`TreeListContextValue`**.
- `tree-list.tsx` — thread it into `ctxValue` (~`:353`).
- `use-tree-row.tsx:180` — `select` becomes conditional:
  `expandOnActivate?.(node) ? toggleExpanded() : ctx.onSelect(node.id)`.
  Putting it here (not in `TreeList`'s `onSelect`) is load-bearing: `onSelect` is
  also called **programmatically** by `createAtRoot` / `addChild` / reveal, which
  must keep navigating. Only a real body click routes through `select`.
- `data-view/plugins/tree/web/internal/types.ts` — add
  `TreeViewOptions.expandOnActivate?: (row: TRow) => boolean`.
- `tree-view.tsx` — forward it, unwrapping the projection
  (`(p) => !p.alias && !!options.expandOnActivate?.(p.__row as TRow)`); an alias
  is a reference leaf and must never toggle.

*No behavior change yet — nothing sets it.*

### Step 2 — migrate the four consumers

**2a. `code-explorer/web/components/file-tree.tsx`**
- Delete `expanded`, `effectiveExpanded`, `toggle`, the `ancestorsOf` helper
  (`:112-120`, now unused), and both hierarchy hooks. `hierarchy` reduces to
  `getParentId` + `getRank` and can drop its `useMemo` dependency on the set.
- `handleActivate` becomes `onSelect(row.path)` for files only; add
  `expandOnActivate: (r) => r.isDir` to `treeOptions`.
- Ancestor reveal is already covered — `selectedRowId={selectedPath}` is passed
  (`:226`), which drives `TreeList`'s reveal-on-select.
- Add `defaultExpanded`? **No** — collapsed-by-default matches today.
- **Give `FileTree` a `storageKey?: DataViewId` prop** (default `FILE_TREE_VIEW`),
  mirroring `PluginTreeProps.storageKey`, which already documents the rule ("a
  second surface rendering this tree MUST pass its own marker"). Two mounts share
  the id today — `code-explorer/web/components/file-tree-view.tsx:48` (whole
  worktree) and
  `plugin-meta/plugin-view/file-tree/web/components/file-tree-section.tsx:33`
  (one plugin's subtree). Harmless while expand was mount-local; once it
  persists, the two surfaces would share one map over overlapping paths. Have
  `file-tree-section.tsx` call `defineDataView("plugin-view.file-tree")` and pass
  it; `./equin build` seeds the new config, which must be authored
  (`{ "views": [{ "id": "tree", "name": "Tree", "view": { "type": "tree",
  "visibleFields": ["name"] } }] }`) and its `// @review` marker deleted.
- *Accepted:* the code-explorer pane is keyed per worktree but the map is not —
  all worktrees share one expand map. Repo paths coincide, so this is desirable.

**2b. `studio/explorer/web/components/plugin-tree.tsx`**
- Delete the `expanded` state, `collectAllExpandableIds`, `collectSubtreeIds`,
  `toggle`, `expandDescendants`, `collapseDescendants`, `ctxValue`, the
  `<PluginTreeProvider>` wrapper, and both hierarchy hooks.
- Add `defaultExpanded: true` to `treeOptions` — the seed was "every node with
  children, expanded". This is also strictly better: the old lazy `useState`
  initializer never re-seeded, so nodes arriving after first mount stayed
  collapsed.
- Delete `explorer/web/context.ts` and drop `usePluginTree` from
  `explorer/web/index.ts`.
- Rewrite `explorer/plugins/expand-collapse/web/components/expand-collapse-button.tsx`
  on the **existing precedent**
  (`tasks/task-list/web/components/expand-collapse-all-action.tsx`):
  `useOptionalTreeListContext()` → `return null` when absent, then
  `useSubtreeExpandAll(ctx.rows, node.id, ctx.setExpanded)` for `willCollapse` +
  `toggle`. Keep its own `MdUnfoldLess`/`MdUnfoldMore` button (distinct hover
  styling); only the state source changes. Its local `collectSubtreeIds`
  duplicate goes away — the hook owns that walk.
- `closure-tree-section.tsx` already passes its own `storageKey`, so it gets an
  independent map for free.

**2c. `config_v2/settings/web/components/config-nav.tsx`**
- Delete `collapsed` and both hooks; add `defaultExpanded: true` (empty
  collapsed-set ≡ all expanded).
- Add `expandOnActivate: (r) => !r.registration` and drop the matching early
  return from `handleActivate`.
- Bonus: the four authored view instances (`tree` / `conflicts` / `reorder` /
  `views`) get **independent** expand state; today they share one mount-local set.

**2d. `pages/page-tree/web/components/pages-sidebar.tsx`**
- Delete `isExpanded` / `onToggleExpanded` (`:181-183`). Nothing else changes —
  `page_blocks.expanded`, `updateBlock`, and the editor's inline mounting are all
  untouched.

*Verify each tree: collapse survives reload, differs per view instance, and the
Pages sidebar no longer writes on a chevron click.*

### Step 3 — delete the pair

- `data-view/core/internal/types.ts` — remove `isExpanded` and
  `onToggleExpanded` from `HierarchyConfig`.
- `project-rows.ts:94-98` — precedence collapses to
  `expanded?.[id] ?? defaultExpanded ?? false`.
- `tree-view.tsx:414-435` — `setTreeExpanded` collapses to the `setExpanded`
  pass-through; the `Promise.all` fan-out and the comment explaining the two
  destinations go with it. `DataViewRenderProps.setExpanded` is typed optional but
  the host always supplies it (`data-view-body.tsx:300`) — **make it required**
  and drop the `?.`, since an absent value was never reachable.
- The compile errors are the checklist: `tsc` names every remaining supplier.

### Step 4 — remove `optimisticExpanded` (separable)

`tree-list.tsx:137-171` keeps a local override Map plus a cleanup effect that
clears entries once "server truth" confirms them — carrying a
`react-hooks/set-state-in-effect` suppression (`:149`).

It existed for an **async, failable** write through `hierarchy.onToggleExpanded`.
With the pair gone, the only sink is `useViewEphemeral.setExpanded` — a
synchronous `setState` in the DataView host, batched into the same commit as the
click, that cannot fail. `TreeList` has exactly one call site
(`tree-view.tsx:476`), so there is no other consumer to keep it alive.

Delete the state, the effect, the suppression, and the `scoped` overlay map
(`:189-198`); `wrappedSetExpanded` becomes `setExpanded`.

### Step 5 — docs

- `data-view/CLAUDE.md` — "Hierarchy": drop the omit-unless-domain-data paragraph
  and the dead-chevron warning (both now moot); state that expand is always the
  view's own map. Keep the "State split" anti-pattern note, dropping its
  `isExpanded`-shadows-the-map sentence.
- `data-view/plugins/tree/CLAUDE.md` — the "Expand state" bullet is **already
  stale** ("server-persisted when `hierarchy.isExpanded` … are supplied … local
  component state … does not expose `ViewState.setExpanded`"); rewrite it, and
  document `expandOnActivate` under "Options".
- `primitives/tree/CLAUDE.md` — drop the closing paragraph of "Expand state is
  written in batches" (it describes the deleted fan-out); document
  `expandOnActivate` and why it lives in `select`, not `onSelect`.
- `pages/page-tree/CLAUDE.md` — the sidebar chevron is device-local view state;
  `page_blocks.expanded` remains document content driven by the in-document
  arrow, and the two are deliberately decoupled.
- `studio/explorer/CLAUDE.md` + `expand-collapse/CLAUDE.md` — the context is gone;
  row badges read the tree context.

## Verification

1. `./equin build`, then exercise each tree at
   `http://<worktree>.localhost:9000`.
2. **Pages** (`/pages`) — collapse/expand a page in the sidebar: its "Updated"
   time must not move, and opening its parent page must show the sub-page row
   still collapsed (no inline content). Then expand that row *in the document*:
   the child's content mounts inline and the **sidebar arrow does not move**.
   Reload: sidebar collapse persists, document collapse persists.
3. **code-explorer** — click a folder's body: it toggles. Click a file: it opens.
   Open a deep file by path so it is selected: its ancestors auto-expand
   (reveal-on-select). Collapse a few folders, reload — collapse survives. Open
   a plugin's "Files" section in Studio: its expand state is independent of the
   Explorer's.
4. **studio explorer** (`/studio`) — first paint is fully expanded; the per-row
   expand/collapse-descendants button still toggles its subtree; collapse
   survives reload; the closure-tree section's state is independent.
5. **config nav** (`/settings`) — first paint fully expanded; clicking a group
   header row toggles it; collapse persists across reload and differs between the
   Configs / Conflicts / Reorder / DataView view instances.
6. **Regression** — repeat the prior doc's checks on Tasks (`/agents/tasks`) and
   Agents: expand-all is one click with no lag, collapse persists, `updatedAt`
   does not move.
7. `bun run test:dom plugins/primitives/plugins/data-view`,
   `bun test plugins/primitives/plugins/data-view/plugins/tree`,
   `bun test plugins/primitives/plugins/tree`, then `./equin check`.
8. `rg "isExpanded|onToggleExpanded"` returns nothing outside `page/` (the
   editor's own document-content field).

## Follow-ups (file as tasks, do not build here)

- **The expand map never prunes.** `${storageKey}:view-state` accumulates a key
  per toggled row forever — unbounded for a file tree keyed by path. Pre-existing
  (true for tasks today), but the file tree makes it easy to hit. Wants a bounded
  policy (drop keys absent from `rows` on write, or an LRU cap).
- **`writeLocal` writes localStorage inside its `setState` updater**
  (`use-view-ephemeral.ts:99-109`) — a side effect React may run twice under
  StrictMode. Pre-existing; harmless (idempotent) but wrong-shaped.
