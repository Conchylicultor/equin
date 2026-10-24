# Tree collapse state is view state, not entity state

## Context

Collapsing a node in the Tasks tree changes the row's visible **"Updated"** date to
"just now".

The mechanism: `taskHierarchy.onToggleExpanded` (`tasks-data-view.tsx:67`) calls
`patchTask(id, { expanded: next })`, and `updateTask`
(`tasks-core/server/internal/mutations/tasks.ts:68`) unconditionally stamps
`updatedAt: new Date()` on **any** patch. A pure UI gesture rewrites a domain
timestamp — one that is a sortable, user-visible field.

The misleading date is a symptom. The real defect is that **expand/collapse is
stored on the domain entity** (`tasks.expanded`, `agents.expanded`). Three
consequences already visible in the tree:

- **One flag can't serve two views.** `tasks-data-view.tsx:80-90` exists *only* to
  work around this: `clusterTaskHierarchy` strips the expand hooks so the
  deps-tree cluster doesn't clobber the main list's collapse state.
- **A local gesture costs a DB write + change-feed recompute + a live-state push
  to every connected client.**
- **It pollutes `updatedAt`** — for the toggled row, and (via the parent
  auto-expand blocks at `mutations/tasks.ts:52-57` and `:109-113`) for the parent
  folder whenever a child is created or re-filed.

### The decision: use the primitive that already exists

The data-view primitive **already owns a per-`(surface, view-instance, row)`
expand map**, and already documents it as the home for this state:

- `data-view/web/internal/use-view-ephemeral.ts:11-22` — `${storageKey}:view-state`
  → `{ [viewId]: { query, expanded: Record<rowId, boolean>, collapsedSections } }`
- `data-view/CLAUDE.md` **State split** table — *"Search query, tree expand map"* →
  *"localStorage `${storageKey}:view-state` (per device)"*
- `tree/web/internal/project-rows.ts:94-98` already reads it as the fallback;
  `tree-view.tsx:429-431` already writes to it.

It is unused by tasks/agents purely because the **consumer hook wins the
precedence chain** — supplying `hierarchy.isExpanded` shadows the map. It is live
today for `task-deps-tree`, whose two sources omit the hooks.

So this change **deletes** wiring rather than adding a mechanism. A DB-backed
`view-expand` sub-plugin (mirroring `view-order`) was designed and rejected: it
would key on the identical `(dataViewId, viewId, rowKey)` triple the localStorage
map already uses, while adding a table, endpoint, live resource, global slot and
host fold. It also does not survive its own scale test — see
[Why not a DB-backed plugin](#appendix-why-not-a-db-backed-plugin).

**Outcome:** collapse becomes device-local render state owned by the view;
`updatedAt` stops lying; the `clusterTaskHierarchy` workaround disappears; two
domain columns are dropped.

## Scope

| Tree | Storage today | Action |
|---|---|---|
| Tasks (`tasks-list`) | `tasks.expanded` column | **Migrate** |
| Agents (`agents-list`) | `agents.expanded` column | **Migrate** (identical bug — `handle-update.ts:13` bumps `updatedAt`, `:30` passes `expanded`) |
| Pages sidebar | `page_blocks.expanded` column | **Do not migrate** — see below |
| code-explorer / studio explorer / config nav | local `useState<Set>` | Out of scope (follow-up) |
| task-deps-tree | already the primitive's map | No change |

**Pages is deliberately excluded.** `page_blocks.expanded` is *document content*,
not render state: it is a field of `SerializedBlock`
(`page/plugins/editor/core/serialized-block.ts:14`), is serialized to markdown
(`markdown.ts:225`), and changes block-split semantics
(`define-block.ts:178` — "a collapsed block still splits into a CHILD *when it is
currently expanded*"). Collapsing a Notion toggle is an edit to the page. The open
*product* question — whether the sidebar tree's chevron should be decoupled from
the in-document toggle — is filed as a follow-up, not resolved here.

## Plan

Ordered so the repo compiles and the app works at the end of every step.

### Step 1 — Batch the expand write chain

Required independently of everything else: `useViewEphemeral.setExpanded`
(`use-view-ephemeral.ts:121-129`) `JSON.stringify`s the **whole** per-surface map
inside the `setState` updater. Expand-all over 670 folders currently fans out to
670 single-row calls ⇒ 670 serializations of a map growing to 670 keys —
quadratic. Batching makes it one write.

Change the **internal** chain to a batch shape
(`readonly { id: string; expanded: boolean }[]`):

- `primitives/tree`: `TreeListProps.onToggleExpanded` → `setExpanded(changes)`;
  same on `TreeListContextValue`; the `optimisticExpanded` updater
  (`tree-list.tsx:150-156`) applies a whole batch in one `setState`.
- Collapse the fan-out call sites to a single call each:
  `tree-list.tsx:241-248` (toolbar expand-all), `tree-list.tsx:296-316`
  (reveal-on-select ancestor walk), `tree-view.tsx:498-506`
  (**grouped-path** expand-all — a separate site that bypasses `TreeList`),
  `use-subtree-expand-all.ts:52-62`. `use-tree-row.tsx:166-169` (chevron) wraps
  its single toggle in a 1-element array.
- `useSubtreeExpandAll`'s `patch` argument → batch shape. **Two** callers:
  `tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx` and
  `conversations/plugins/agents/web/components/expand-collapse-all-action.tsx`.
- `data-view`: `DataViewRenderProps.setExpanded` and
  `useViewEphemeral.setExpanded` take the batch and perform **one** localStorage
  write.

`HierarchyConfig.onToggleExpanded(id, next)` stays single-row — the tree adapter
(`tree-view.tsx:429-431`) fans a batch out to N consumer calls, the same shape as
the existing `wrappedOnMove` / `wrappedOnCreate` adapters. It has six callers
today versus `TreeListProps`' one; batching the 1-caller seam is the correct
boundary, and Step 3 removes two of the six.

*No behavior change. Verify expand-all still works on the Tasks tree.*

### Step 2 — Close two reveal gaps in `primitives/tree`

Today the server force-expands a parent folder when a child is created or
re-filed (`mutations/tasks.ts:52-57`, `:109-113`). Step 4 deletes that. Two paths
are **not** covered by the tree's existing reveal-on-select effect and would
silently regress:

1. **Drag-reparent into a collapsed folder — deterministic loss.**
   `tree-list.tsx:255-294` (`onDragEnd`) computes the drop and calls `onMove`; it
   never touches expand state. A drag does not change `selectedRowId`, so the
   reveal effect never runs. The dragged row would simply vanish.
2. **Add-child on a collapsed folder — racy loss.** `use-tree-row.tsx:175-181`
   awaits `create(...)` then calls `ctx.onSelect(id)`, but `TreeList`'s `onSelect`
   (`tree-view.tsx:462-465`) **returns silently** when the id isn't in
   `originalById` yet. If the live-state push hasn't landed, `selectedRowId` never
   changes and the reveal effect never fires.

Both fixes belong in the tree primitive (generic, and they cover the agents tree
for free):

- `use-tree-row.tsx` `addChild`: expand `node.id` after a successful create — one
  call, no dependence on the row having arrived.
- `tree-list.tsx` `onDragEnd`: if `dest.parentId` is non-null and currently
  collapsed, include it in the same batched `setExpanded` from Step 1.

Also add **`useOptionalTreeListContext(): TreeListContextValue | null`** to the
tree web barrel — `useTreeListContext` *throws* without a provider
(`use-tree-row.tsx:70-72`), which Step 3 needs.

*Verify with the server auto-expand still in place (the fixes are idempotent):
collapse a folder → drag a task onto it → it opens and the task is visible;
collapse a folder → "+" → the child appears and enters rename.*

### Step 3 — Cut tasks and agents over to the primitive's map

- `tasks-data-view.tsx`: delete `isExpanded` / `onToggleExpanded` from
  `taskHierarchy`. The `clusterTaskHierarchy` destructure at `:80-90` collapses to
  `export const clusterTaskHierarchy = readOnlyTaskHierarchy` — rewrite the
  comment, which no longer describes reality.
- `agents-list.tsx:118-119`: same deletion.
- Both `expand-collapse-all-action.tsx` files: read `useOptionalTreeListContext()`
  and **`return null` when it is null**. This action is contributed to a
  `defineItemActions` slot rendered by *every* view (list / table / gallery /
  tree), and the tasks surface has a `"recent"` **list** instance — the throwing
  hook would crash it. Self-hiding is also semantically right: expand-all is
  meaningless in a flat list. Reading `ctx.rows` (already
  `{id, parentId, rank, expanded}`-shaped) drops both the `tasksResource` /
  agents subscription and the `folderId → parentId` mapping.

Default stays `defaultExpanded: false`, matching today's DB default. A fresh
device starts collapsed; 678 of 3900 task rows are expanded today, so most of the
tree is collapsed anyway.

*Verify: collapse persists across reload, differs per view instance, and
`updatedAt` no longer moves.*

### Step 4 — Drop the columns and the server auto-expand

**Tasks** — `tasks-core/core/internal/fields.ts:39` (flows into `TaskSchema` /
`TaskListItem` via `fieldsToZodObject`), `server/internal/tables.ts:47`,
`server/internal/resources.ts:251`, `mutations/tasks.ts:31` + `:86` **and both
parent auto-expand blocks** (`:52-57`, `:109-113`), `tasks/core/endpoints.ts:38`
(`UpdateTaskBodySchema`) and `:80` (`TaskResponseSchema` — the wire response of
five endpoints; no external consumers in `cli/` or the MCP surface),
`tasks/web/client.ts:17` (`TaskPatch`). Fixtures:
`task-deps-tree/core/deps-tree.test.ts:25` and the raw SQL `INSERT` in
`tasks/server/internal/deps-tree-move.test.ts:31`.

**Agents** — `agents/server/internal/tables.ts:31`, `core/schemas.ts:18`,
`core/endpoints.ts:36`, `handle-update.ts:30` and its trailing parent auto-expand
block.

`views.ts` needs no edit — it spreads `getTableColumns(_tasks)` and `tasks_v` is a
boot-rebuilt derived view outside the migration chain. The projection's
`satisfies Record<keyof TaskListItem, unknown>` (`resources.ts:259`) is the
compile-time forcing function that surfaces anything missed.

**Bonus fix:** the two parent auto-expand blocks also stamp `updatedAt` on the
*parent* — so creating a child currently bumps the folder's "Updated" too. Deleted
here for free.

`./equin build` generates `ALTER TABLE … DROP COLUMN IF EXISTS "expanded"`
(precedent: `20260413_180905_30e2b38e__drop_worktree_column.sql`). This is
classified `drop-column` destructive, which needs **no flag or approval** to
author — but after it lands on main, other worktrees whose DB forked post-merge
will fail `./equin check` with a `fork-schema-drift` error until they rebase.
Worth one line in the push message.

### Step 5 — Docs

- `data-view/CLAUDE.md` — the State-split table already says expand is
  device-local; add a note that consumer `hierarchy.isExpanded` shadows it, and
  that a DB-backed collapse is an anti-pattern.
- `primitives/tree/CLAUDE.md` — the batch signature, `useOptionalTreeListContext`,
  and the two new reveal behaviors.
- `tasks-core/CLAUDE.md`, `task-list/CLAUDE.md`, agents' CLAUDE.md — expand is no
  longer entity state.

## Verification

1. `./equin build`, then open `http://<worktree>.localhost:9000/agents/tasks`.
2. **The reported bug:** note a task's "Updated" value, collapse its folder,
   confirm the value does not change. Confirm the same for the parent when adding
   a child.
3. **Persistence:** collapse several folders, reload — collapse survives.
4. **Per-view isolation:** collapse a folder in the `tree` instance, switch to the
   `attempted` instance — its own state is independent.
5. **Reveal (Step 2 gaps):** collapse a folder → drag a task onto it → folder
   opens, task visible. Collapse a folder → "+" → child appears and enters rename.
6. **Expand-all:** one click expands/collapses the whole subtree; with 670 folders
   it is a single localStorage write (no lag, no request).
7. **List view:** switch the tasks surface to the `recent` list instance — the
   expand-collapse-all row action is absent, and nothing throws.
8. **Agents tree:** repeat 2-6 at `/agents`.
9. `bun test plugins/tasks/plugins/task-deps-tree/core` and
   `./equin check`.
10. `mcp__singularity__query_db`: confirm `expanded` is gone from `tasks` and
    `agents`.

## Follow-ups (file as tasks, do not build here)

- **Pages:** decide whether the sidebar tree chevron should be decoupled from the
  in-document toggle block. If yes, the sidebar tree drops its expand hooks like
  tasks/agents while `page_blocks.expanded` remains document content.
- **Delete `HierarchyConfig.isExpanded` / `onToggleExpanded` entirely.** After this
  change only three consumers remain, all hand-rolling a local `Set`:
  `code-explorer/web/components/file-tree.tsx:164`,
  `studio/plugins/explorer/web/components/plugin-tree.tsx:115`,
  `config_v2/plugins/settings/web/components/config-nav.tsx:137`. Each maps onto
  the primitive with no new mechanism — studio and config-nav are just
  `defaultExpanded: true`, and code-explorer's ancestor force-expand is exactly
  `TreeList`'s native reveal-on-select. Removing the pair makes "expand is a
  consumer concern" unrepresentable, and its half-wired state
  (`isExpanded` without `onToggleExpanded` ⇒ a silently dead chevron) impossible.
- **Optimistic-override rollback.** `tree-list.tsx:128-148` clears an optimistic
  entry only when server truth matches. With a local map the write cannot fail, so
  this is latent — but it is the reason a DB-backed expand would need explicit
  rollback, and worth a comment.

## Appendix: why not a DB-backed plugin

A `view-expand` sub-plugin mirroring `view-order` was designed in full and
rejected on two measured grounds.

**1. No bounded-write trick is available.** `view-order` keeps writes `O(gesture)`
because ranks are *relative*: a partial write is legal as long as it preserves the
"persisted rows display before seeded rows" invariant. Expand flags are per-row
**independent** — there is no invariant to exploit, nothing to seed. Expand-all
touches N rows because N rows genuinely changed. On the real main DB:

```
3900 tasks · 670 folders · 678 currently expanded
```

`buildTreeOptions` sets `expandAll: true`, so one toolbar click is a **670-row**
write, recomputed by the L4 change feed and pushed to every open tab — across two
tree instances in `tasks-list.jsonc`. That is precisely the failure `view-order`'s
own CLAUDE.md was written to eliminate ("one drag … persisted **3666 rows** and
shipped that whole set to every client").

**2. The cold-load flash is unavoidable.** The resource is keyed
`{ dataViewId, viewId }`, and `boot-snapshot/CLAUDE.md:36-37` restricts snapshots
to *"param-less global resources only"*. So `render(pending ? null : config)`
degrades to **everything collapsed**, then a push expands 678 nodes — a full
re-layout and scroll jump on a 3900-row virtualized tree, on every cold load.
`view-order`'s equivalent degradation is benign (rows in source order, identical
layout height); this one is not.

The only thing the DB version buys over localStorage is cross-device persistence
of collapse state — which is not worth a table, an endpoint, a live resource, a
global slot, a host fold, and the two costs above.
