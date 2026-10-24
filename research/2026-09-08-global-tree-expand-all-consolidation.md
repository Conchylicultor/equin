# Tree expand/collapse-all: one implementation, three surfaces

## Context

Two things are missing in the tree view, and one thing is written too many times.

**Missing 1 — the group header.** When a tree DataView is grouped, each group
gets a section header (the group's value plus a row count). There is no way to
fold or unfold everything inside one group; the only expand-all is the
whole-view one hoisted into the toolbar above every section.

**Missing 2 — the Pages sidebar row.** A page with sub-pages has no
"fold/unfold everything under this page" affordance. The tasks list, the agents
list and the Studio plugin tree all have one — because each of those three
plugins wrote its own copy and contributed it as a per-app action. Pages never
did, so Pages goes without.

**Written too many times.** The audit below found the same computation
implemented five times across the codebase. It is not domain logic: it needs
only the tree's own rows, the row's id, and the tree's own `setExpanded`.
Nothing about a task, an agent or a plugin node enters into it. That it lives in
consumer plugins at all is the defect — which is why a fourth consumer (Pages)
silently went without the feature rather than inheriting it.

The intended outcome: **one** expand-all implementation, owned by the tree
primitive; every tree row with children gets the affordance for free; the group
header gets a scoped one; and the three consumer copies are deleted so a sixth
copy has nothing to copy from.

---

## Audit: every expand-all in the codebase

### The shared pieces that already exist

| Piece | Location | What it is |
|---|---|---|
| `ExpandAllButton` | `plugins/primitives/plugins/collapsible/web/internal/expand-all-button.tsx` | The unfold/fold icon button (`MdUnfoldMore` / `MdUnfoldLess`), `compact` \| `full`. |
| `useSubtreeExpandAll` | `plugins/primitives/plugins/tree/web/internal/use-subtree-expand-all.ts` | `(rows, rootId, setExpanded) → { willCollapse, toggle }` for ONE row's subtree. |
| `useExpandAll` | `plugins/primitives/plugins/collapsible/web` | Flat set of ids. Unrelated to trees — correctly separate. |

### The five implementations

1. **Whole tree, toolbar** — `TreeList`
   (`plugins/primitives/plugins/tree/web/internal/tree-list.tsx`). Computes
   `nodesWithChildren` / `allExpanded` / `expandAll`, renders `ExpandAllButton`
   when `toolbar.expandAll` is set. Opt-in; taken by file-tree, config-nav,
   Studio plugin-tree, task-deps-tree, tasks, agents. **Not** by Pages.

2. **Whole tree, grouped** — `TreeView`
   (`plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx`,
   grouped branch). A byte-for-byte re-implementation of #1, hoisted above the
   sections because the grouped path renders one `TreeList` per section and
   suppresses each one's toolbar. Legitimate need, duplicated code.

3. **One row's subtree** — `plugins/tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx`

4. **One row's subtree** — `plugins/conversations/plugins/agents/web/components/expand-collapse-all-action.tsx`
   — a **verbatim** duplicate of #3, differing only in the row type it is
   generic over.

5. **One row's subtree** — `plugins/apps/plugins/studio/plugins/explorer/plugins/expand-collapse/web/components/expand-collapse-button.tsx`
   — same body again, but **hand-rolls the button** instead of using
   `ExpandAllButton`, and carries an `eslint-disable` for
   `button-safety/no-async-raw-button` to do it. A whole plugin folder whose
   only reason to exist is this one contribution.

All three of #3/#4/#5 have the identical body: read the tree context
non-throwingly, bail if absent or the row has no children, call
`useSubtreeExpandAll(ctx.rows, row.id, ctx.setExpanded)`, render a toggle.

### Correctly separate (leave alone)

- `plugins/review/plugins/plugin-changes` and `plugins/review/plugins/code-review`
  use `useExpandAll` over a flat set of file paths — collapsible cards, not a tree.
- `plugins/debug/plugins/trace/plugins/spans/web/components/spans-lane.tsx`
  hand-rolls two ghost `Button`s over its own collapsed set — a span lane, not a
  `TreeList`.

### The performance defect the duplication hides

`useSubtreeExpandAll` rebuilds a `byParent` map over **all** rows on every call,
memoized on `[rows, rootId]`. Each row-with-children calls it once, so a render
costs O(n × k) — worst case **O(n²)**. Today this is paid by the tasks list, the
agents list and the Studio plugin tree on every expand/collapse. Moving the code
without fixing the algorithm would just relocate the quadratic into the
primitive, where every tree would pay it.

---

## Design

### Two decisions, and why

**Scope — the per-row button appears on every tree, gated only on
`hasChildren`.** The alternative (a per-consumer opt-in) reproduces exactly the
situation that caused this: Pages deliberately keeps its sidebar minimal
(`addLabel: null`, no toolbar `expandAll`), so a flag shared with the toolbar
chrome would leave Pages — the surface that prompted this — still without the
button. And a fresh flag is one more thing a new tree can forget. `RowChrome`
already renders unconditional tree-owned affordances this way (the `⋯` menu, the
hover `+` add-child).

Nine surfaces gain it: Pages sidebar, Studio plugin tree, Settings config nav,
agents list, tasks list, Code Explorer file tree, plugin-detail file tree, task
dependency tree, composition closure tree.

**Placement — inline in the row's hover cluster, rendered by the tree itself.**
It is view chrome, the same family as the chevron, not a domain action — so it
does not go through the per-app item-action registry and is not subject to an
app's authored `⋯` overflow config. It costs no layout width: `RowActions` is
pinned and reveals by opacity only, so the row's geometry is identical hovered
or not.

### A. The per-row subtree toggle becomes tree chrome

Replace `use-subtree-expand-all.ts` with an index built **once per `TreeList`
render** from the already-built `tree` (roots from `buildTree(scoped)`), in one
post-order walk — O(n) total instead of O(n) per row:

```ts
// plugins/primitives/plugins/tree/web/internal/use-subtree-expand-index.ts
function useSubtreeExpandIndex<T extends TreeItem>(tree: readonly TreeNode<T>[]): {
  /** Is every expandable node in this subtree (self included) open? */
  getAllExpanded(id: string): boolean;
  /** The batch that flips the whole subtree. Computed at CLICK time, O(subtree). */
  getSubtreeChanges(id: string, next: boolean): ExpandChange[];
}
```

A leaf is vacuously "all expanded" so it never corrupts an ancestor's answer —
matching today's semantics, where `subtreeWithChildren` only ever inspected
nodes that themselves have children.

The index must be memoized on `tree` (the full set), **not** on `flatVisible` —
otherwise the windowed (`VirtualRows`) path would answer from the visible slice.

Then thread it through the plumbing that already exists:

- `TreeListContextValue` (`web/internal/use-tree-row.tsx`) gains
  `subtreeAllExpanded: (id) => boolean` and `toggleSubtreeExpanded: (id) => void`,
  wired in `TreeList` from the index.
- `RowControls` (returned by `useTreeRow`, already memoized and published via
  `RowControlsProvider`) gains the same two, resolved for `node.id`.
- `RowChrome` (`web/internal/row-chrome.tsx`) renders it in its `trailing`
  cluster beside the existing `⋯` and `+`, when `hasChildren`:

  ```tsx
  <IconButton
    icon={subtreeAllExpanded ? MdUnfoldLess : MdUnfoldMore}
    label={subtreeAllExpanded ? "Collapse subtree" : "Expand subtree"}
    variant="ghost"
    onClick={toggleSubtreeExpanded}
  />
  ```

  A plain `IconButton`, **not** `ExpandAllButton`: the cluster already sizes its
  children through `RowActions`' `ControlSizeProvider size="xs"` (this is how
  `addChild` is written), whereas `ExpandAllButton`'s `compact` variant is
  hand-sized `size-7` for a toolbar and would not match its siblings.

Aliases need no special case — a reference node is always a leaf, so
`hasChildren` is false.

### B. Per-section expand-all on the group header

`GroupedSections` (`plugins/primitives/plugins/data-view/web/internal/grouped-sections.tsx`)
gains one optional seam:

```ts
headerActions?: (section: DataViewSection<unknown>) => ReactNode;
```

rendered inside the existing `SectionHeaderRow.actions`, beside the count:

```tsx
actions={
  <Stack direction="row" gap="xs" align="center">
    <Text variant="caption" tone="muted">{section.count}</Text>
    {action != null && <RowActions pin={null}>{action}</RowActions>}
  </Stack>
}
```

The nested `RowActions pin={null}` is the whole trick, and it needs **no change
to `Row`, `SectionHeaderRow` or `row-actions`**:

- `RowActionsProps` already separates `pin` (positioning) from `alwaysVisible`
  (reveal), so an inline cluster that is *not* always-visible is already
  expressible. The count stays persistent (outer cluster,
  `actionsAlwaysVisible`); the button reveals on hover (inner cluster, default).
- It rides the row's own `group/row-actions`, published by `rowActionsAnchor` in
  `Row`'s chrome class.
- The header row is itself a click target (it collapses the section), and
  `RowActions`' button `Stack` already stops both `onClick` and `onPointerDown`
  — verified in `row-actions.tsx`. So the guard is free.

**Do not reach for the `hover-reveal` primitive here.** Its own `CLAUDE.md`
says, in as many words, that it is not for row-action clusters — that is
`row-actions`' job, and stacking the two puts two competing reveal systems on
one row.

`gap="xs"` on the wrapper is load-bearing: today the header has a single action,
so a sibling has never been exercised and the two would otherwise sit flush.

`TreeView`'s grouped branch passes `headerActions`; `list` and `gallery` pass
nothing and render exactly as they do today.

### C. One whole-tree expand-all, three call sites

Extract today's `nodesWithChildren` / `allExpanded` / toggle block into a hook
over an arbitrary flat row array:

```ts
// plugins/primitives/plugins/tree/web/internal/use-flat-expand-all.ts
function useFlatExpandAll<T extends TreeItem>(
  rows: readonly T[],
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>,
): { hasExpandable: boolean; allExpanded: boolean; toggle: () => void };
```

Three call sites converge on it: `TreeList`'s own toolbar, `TreeView`'s hoisted
grouped toolbar, and the new per-section header action from B (called with
`grouped.rowsBySectionKey.get(section.key)`). Section buckets hold whole
subtrees — `bucketRowsByRootSection` keeps every descendant in its root's
section — so a section-scoped toggle is well-defined.

Without this, B would add a *fourth* copy of the same block.

---

## Files

**Tree primitive** (`plugins/primitives/plugins/tree/web/`)
- `internal/use-subtree-expand-index.ts` — new, replaces `internal/use-subtree-expand-all.ts` (deleted)
- `internal/use-flat-expand-all.ts` — new
- `internal/use-tree-row.tsx` — extend `TreeListContextValue` + `RowControls`
- `internal/tree-list.tsx` — build the index, publish both seams, use `useFlatExpandAll`
- `internal/row-chrome.tsx` — render the per-row button
- `index.ts` — drop `useSubtreeExpandAll`, `ExpandableRow`, `UseSubtreeExpandAllReturn`; export `useFlatExpandAll`

**Data-view** (`plugins/primitives/plugins/data-view/`)
- `web/internal/grouped-sections.tsx` — `headerActions` seam
- `plugins/tree/web/components/tree-view.tsx` — hoisted toolbar via `useFlatExpandAll`; pass `headerActions`

**Deletions** (the three copies and their registrations)
- `plugins/tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx` + its contribution in `web/index.ts`
- `plugins/conversations/plugins/agents/web/components/expand-collapse-all-action.tsx` + its contribution in `web/index.ts`
- `plugins/apps/plugins/studio/plugins/explorer/plugins/expand-collapse/` — the whole plugin folder. `Explorer.TreeRowBadge` keeps 5 other contributors (`child-count`, `collapsed`, `excluded`, `load-bearing`, `membership`), so the slot does not go empty. Fix the stale comment in `explorer/web/internal/flatten-plugin-tree.ts` that lists `expand-collapse` among the badges.

**Committed slot configs that name the removed contributions** — each has a
`.jsonc` / `.origin.jsonc` pair whose `@hash` must be regenerated by
`./equin build`, or `reorderable-slots-in-sync` / `config-origins-in-sync`
will fail:
- `config/apps/studio/explorer/tree-row-badge.jsonc`
- `config/tasks/task-list/task-actions.jsonc`
- `config/conversations/agents/agent-actions.jsonc`

---

## Order of work

1. The two hooks + the `TreeListContextValue` / `RowControls` extensions. Pure
   internals, no visible change.
2. Wire the per-row button in `RowChrome`. This alone closes the Pages gap and
   fixes the O(n²).
3. Delete the three copies, their contributions, the Studio plugin folder, and
   the dead barrel exports; update the three slot configs.
4. Refactor `TreeList` + `TreeView`'s hoisted toolbar onto `useFlatExpandAll` —
   pure refactor, and the natural place to add a unit test for the hook.
5. `GroupedSections.headerActions` + `TreeView`'s per-section button.

Steps 1–3 are one shippable unit; 4–5 are the second.

---

## Verification

**Unit** — `./equin test plugins/primitives/plugins/tree`. Add coverage
for `useSubtreeExpandIndex` (a leaf is vacuously all-expanded; a mixed subtree
answers false; `getSubtreeChanges` emits only rows that actually change) and for
`useFlatExpandAll`. `plugins/primitives/plugins/tree/core/internal/tree.test.ts`
and the data-view tree's `group-rows.test.ts` / `project-rows.test.ts` must stay
green.

**Existing e2e that guards this exact row** — these are manual; run them after
`./equin build`:

```
./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts
./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/add-child-opens-page.ts
./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/sidebar-expand-decoupled.ts
./equin run plugins/apps/plugins/pages/plugins/page-tree/e2e/grouped-reorder.ts
./equin run plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts
```

`row-actions-overflow.ts` is the load-bearing one: it asserts exactly one `⋯`
trigger and that the three bucketed actions stay out of the inline cluster. The
new button adds one inline affordance, which those assertions permit — confirm
the run stays green rather than assuming it.

`sidebar-expand-decoupled.ts` matters because the new button writes through the
same `setExpanded` seam: it must still never touch `page_blocks.expanded`
(document content).

**By hand**, at `http://<worktree>.localhost:9000`:
1. Pages sidebar — hover a page with sub-pages; the fold button appears; it
   opens/closes the whole subtree in one click and the icon flips.
2. Pages sidebar — group the tree by a field, hover a group header; the button
   appears beside the count, folds only that group, and does **not** collapse
   the section (the header's own click still does).
3. Tasks list and agents list — the button is still there and behaves as before,
   now coming from the tree instead of each plugin.
4. Studio → Explorer — the plugin tree row still folds its subtree, now through
   the shared button rather than the hand-rolled one.
5. A deep tree past 100 visible rows (Code Explorer) — the windowed path answers
   from the full tree, not the visible window.

**Checks** — `./equin check` must pass, in particular
`reorderable-slots-in-sync`, `config-origins-in-sync`,
`plugins-registry-in-sync` and `plugins-doc-in-sync`, all of which react to the
deleted plugin and the removed contributions. Run `./equin build` first so
the generated registries, docs and config hashes are regenerated.
