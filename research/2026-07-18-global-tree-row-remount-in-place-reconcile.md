# TreeList rows must reconcile in place on a data push, not remount

## Context

While a task is being edited, every debounced autosave `PATCH /api/tasks/:id`
triggers a live-state `tasks` push. In the task-detail pane the dependency-tree
(and creation-tree) rows **remount** — destroy-and-rebuild — on each push: the
selected row's mount effects re-fire (`commitHookEffectListMount` ~1.5 s after
each PATCH). The scroll-yank *symptom* this caused was already fixed structurally
by the `scroll-reveal` primitive
(`research/2026-07-18-global-scroll-reveal-intent-class-fix.md`, §6.3 filed this
as the remaining follow-up). This plan removes the remount itself: a row should
reconcile in place on a data push, remounting **only** when its identity (key)
changes.

## Root cause (verified — element-type flip, not key change)

The tree primitive uses the consumer-supplied `Row` render component as the JSX
**element type** at each row position, in three places:

- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx:411` — non-windowed
  `visibleTree.map((node) => <Row key={node.id} node depth={0} />)`.
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx:408` — the
  `VirtualRows` children `(item) => <Row node depth />`.
- `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx:196` — the
  recursive child render `<Row key={child.id} node depth />` where
  `const Row = ctx.Row` (line 69).

`ctx.Row` is supplied **only** by the data-view tree adapter
`plugins/primitives/plugins/data-view/plugins/tree/web/components/tree-view.tsx:280`
— a `useCallback` with deps `[hierarchy, options, primaryField, secondaryFields, itemActions]`.
`secondaryFields`/`vis` are `useMemo`'d on `fields`, and `fields` arrives from
`plugins/primitives/plugins/data-view/web/components/data-view.tsx` via
`CollectFieldExtensions`
(`plugins/primitives/plugins/data-view/web/internal/field-extensions.tsx`), whose
base case emits `children([...acc, ...fields])` — a **fresh array reference every
render**. So `fields → vis → secondaryFields → the Row useCallback` all get new
identities each render.

A new `Row` identity is a **different element type** at each row position →
React unmounts + remounts the whole row subtree. Keys (`node.id` / `child.id`)
are stable, so the Render Profiler classifies this as an `element-type` remount,
not `key-change`. The deps tree ships `defaultExpanded: true`
(`deps-tree-fields.tsx:53`), so the entire visible subtree remounts on every push.

The data-view adapter is the churn source, but the **footgun lives in the
primitive**: any `TreeList` consumer that hands it a referentially-unstable `Row`
(an inline arrow, or a `useCallback` with churny deps — trivial to do by
accident) silently gets full-tree remount-on-every-render. Per the repo rule
"fix the structural issue, not the specific instance," the fix belongs in the
tree primitive.

## Design — enforce "stable key ⇒ reconcile in place" inside the primitive

Introduce a **module-level, constant-identity** internal component that is the
element type React sees at every row position; it invokes the *current* `ctx.Row`
as a plain function. Because the element type never changes, a stable key
reconciles the row in place; the consumer's `Row` re-running only produces new
child props (its returned `<DefaultRow/>` is a stable module-typed component that
reconciles normally). Only a genuine key change can now remount a row.

### 1. Add `TreeRowSlot` (tree primitive)

In `use-tree-row.tsx` (co-located with `useTreeListContext`), add:

```tsx
/** Stable element-type wrapper for one tree row. Its identity is constant, so a
 *  row reconciles in place across renders for a stable key — an unstable `Row`
 *  prop can no longer cause the whole row subtree to remount on background
 *  live-state churn. Invokes the current `ctx.Row` as a function (not `<Row/>`),
 *  so the returned `<DefaultRow/>` (a stable module type) is the reconciliation
 *  unit; per-node hook isolation is preserved because each TreeRowSlot is keyed. */
export function TreeRowSlot<T extends TreeItem>({
  node,
  depth,
}: {
  node: TreeNode<T>;
  depth: number;
}): ReactNode {
  // Lowercase local so the React Compiler / eslint capitalized-call heuristics
  // don't treat this as a component invocation.
  const render = useTreeListContext<T>().Row;
  return <>{render({ node, depth })}</>;
}
```

### 2. Swap the three `<Row>` sites → `<TreeRowSlot>`

Preserving the existing keys:

- `tree-list.tsx:411`: `visibleTree.map((node) => <TreeRowSlot key={node.id} node={node} depth={0} />)`.
- `tree-list.tsx:408`: `{(item) => <TreeRowSlot node={item.node} depth={item.depth} />}` (VirtualRows still keys via its own `getKey={item.node.id}`).
- `row-chrome.tsx:196`: `<TreeRowSlot key={child.id} node={child} depth={depth + 1} />` (import `TreeRowSlot` from `./use-tree-row`; the local `const Row = ctx.Row` on line 69 is no longer needed and is removed).

`ctx.Row` keeps its current type and role — the primitive simply never uses it as
an element type again.

### Why this is safe (validated)

- **Hooks.** `ctx.Row` (the `tree-view.tsx:280` factory) calls **no hooks** — it
  is a pure branch returning `options.renderRow(...)` or `<DefaultRow …/>`.
  Inlining that hookless body into `TreeRowSlot` leaves `DefaultRow` as its own
  keyed fiber, so `useResolveCell` / `useResolveCellEditor` / `useTreeRow` stay
  isolated per node exactly as today. There is currently **no tree `renderRow`
  consumer** (all `renderRow` usage is the *list* view, a different path), and no
  other `<TreeList Row=…>` consumer in the repo.
- **React Compiler** (enabled repo-wide). Remount is a function of element
  *type*, independent of memoization → a module-constant `TreeRowSlot` cannot
  remount, compiled or not. The compiler could not have prevented the bug (the
  fresh `fields` array is a genuine dep change) and cannot reintroduce it.
- **Error boundaries.** Individual rows are not wrapped by `renderIsolated` today
  (that wraps *slot contributions*; the whole `TreeView` mounts under one
  view-level boundary). Calling `Row` as a function vs mounting `<Row/>` changes
  nothing about containment.

## Out of scope (follow-ups, not this change)

- **Stabilizing the upstream `fields` array** in `CollectFieldExtensions`. It
  would *also* fix the remount, but at the wrong layer: it is fragile
  (the base case combines contributed field closures; a stable identity needs
  structural-equality keying that risks stale closures) and protects neither
  other churn sources nor other consumers. On a genuine push `rows` changes
  anyway, so the tree legitimately re-renders regardless — only the *remount* is
  pathological, and the primitive fix removes it. If a later, measured perf pass
  shows *idle/unrelated* pushes re-rendering this tree with no real data change,
  stabilize `fields` then, separately.
- **Fresh `itemActions` descriptor hazard.** A consumer minting a new
  `defineItemActions` descriptor each render would remount that one action cell
  (`<itemActions.Row/>` in `DefaultRow`). Descriptors are module singletons
  today, so this is latent only — worth a one-line comment near the `DefaultRow`
  `itemActions` usage, not a code change.

## Files to modify

- `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx` — add `TreeRowSlot`.
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` — swap two `<Row>` sites (lines 408, 411).
- `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx` — swap the recursive `<Row>` (line 196); drop the now-unused `const Row = ctx.Row`.

No change to `tree-view.tsx` or any consumer. `TreeRowSlot` is primitive-internal
(not exported from the tree barrel).

## Verification

1. `./equin build` (from the worktree), then reproduce and measure with the
   Render Profiler's headless harness against the task-detail deps tree:
   ```bash
   bun e2e/render-profile.mjs \
     --url http://<worktree>.localhost:9000/agents/tasks/t/<task-id-with-deps> \
     --seconds 8
   ```
   Drive live-state churn during the window either by editing the task's
   description (real autosave PATCH → push) or deterministically via **Debug →
   Live-State Emit** (`window.__liveStateEmit`) on the `tasks` resource.
   **Assert:** the report's **Remounts** section shows **zero** `element-type`
   remounts for the tree rows (before the fix: one row-subtree remount per push).
   Read the ranked report from `cat logs/render-profiler.jsonl` if needed.
2. Re-run the original scroll-jump probe from the scroll-reveal doc — still no
   `SCROLL-JUMP` lines after each PATCH (the remount was the last thing exercising
   the `useRevealOnActive` mount path; it should now stay quiet on its own merits).
3. Behavior regression sweep — the tree still works end-to-end:
   - selection, expand/collapse, DnD reorder/reparent in the deps tree;
   - deep-link reveal (open a task far down the Tasks sidebar → its row scrolls
     into view exactly once via the `initialReveal` one-shot);
   - inline rename (primary-label `EditableTreeLabel`), row `+`/menu actions,
     multi-select checkboxes;
   - the windowed path (a tree with >100 visible rows, e.g. a large Tasks list) —
     scroll, select, and drag still work.
4. `./equin check` — `type-check` green; boundary/lint checks pass (no new
   cross-plugin edges; `TreeRowSlot` stays internal).
5. `bun run test:dom plugins/primitives/plugins/tree` and
   `bun test plugins/primitives/plugins/data-view/plugins/tree` — existing tree
   suites unchanged.
