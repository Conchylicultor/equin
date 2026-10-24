# Fix: Multi-Select orderedIds Must Exclude Hidden Terminal Items

## Context

`MultiSelectProvider`'s `orderedIds` is computed by `deriveVisibleOrder()` which walks expanded tree nodes — but doesn't account for TreeList's internal `hideTerminal` filter. When "Completed hidden" is toggled on, completed/dropped subtrees are removed from the DOM by `hideTerminalSubtrees()` inside TreeList, but their IDs remain in `orderedIds`. Shift-click range selection and "Select all" silently include invisible items.

Root cause: `hideTerminal` state lives inside TreeList as `useState(true)` and is never exposed. The orchestrator (task list) can't synchronize `orderedIds` with the actual visible set.

## Approach: Controlled/Uncontrolled `hideTerminal`

Standard React pattern — make the internal state optionally controlled from outside. Three changes to three files.

### 1. Extend `TreeListProps.toolbar.hideTerminal` with controlled state

**File**: `plugins/primitives/plugins/tree/web/internal/tree-list.tsx`

Extend the type:
```ts
hideTerminal?: {
  isTerminal: (row: T) => boolean;
  value?: boolean;                       // NEW
  onValueChange?: (v: boolean) => void;  // NEW
};
```

Replace the internal state with a controlled/uncontrolled bridge:
```ts
const [internalHide, setInternalHide] = useState(true);
const hideTerminal = toolbar?.hideTerminal?.value ?? internalHide;
const setHideTerminal = toolbar?.hideTerminal?.onValueChange ?? setInternalHide;
```

The toggle button's `onClick` already calls `setHideTerminal((v) => !v)` — but since the controlled `onValueChange` is `(v: boolean) => void` (not a setter function), change the onClick to:
```ts
onClick={() => setHideTerminal(!hideTerminal)}
```

This works for both controlled (calls `onValueChange(newValue)`) and uncontrolled (calls `setInternalHide(newValue)`) modes.

### 2. Export `hideTerminalSubtrees` from tree web barrel

**File**: `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` — add `export` to the function.

**File**: `plugins/primitives/plugins/tree/web/index.ts` — add re-export:
```ts
export { hideTerminalSubtrees } from "./internal/tree-list";
```

The function is a pure `TreeNode<T>[] → TreeNode<T>[]` transform. It stays in tree-list.tsx (no need to move it) but becomes part of the public API.

### 3. Task list lifts state and filters orderedIds

**File**: `plugins/tasks/plugins/task-list/web/components/tasks-list.tsx`

Lift hideTerminal state:
```tsx
const [hideTerminal, setHideTerminal] = useState(true);
const isTerminal = (t: Task) => t.status === "done" || t.status === "dropped";
```

Update `deriveVisibleOrder` to accept an optional terminal filter:
```ts
function deriveVisibleOrder(
  rows: readonly Task[],
  rootId?: string,
  terminalFilter?: (row: Task) => boolean,
): string[] {
  const scoped = rootId ? rows.filter((r) => isInSubtree(rows, rootId, r.id)) : rows;
  let tree = buildTree(scoped);
  if (terminalFilter) tree = hideTerminalSubtrees(tree, terminalFilter);
  const ids: string[] = [];
  function walk(nodes: TreeNode<Task>[]) {
    for (const n of nodes) {
      ids.push(n.id);
      if (n.expanded) walk(n.children);
    }
  }
  walk(tree);
  return ids;
}
```

Update orderedIds computation:
```tsx
const orderedIds = useMemo(
  () => deriveVisibleOrder(rows, rootTaskId, hideTerminal ? isTerminal : undefined),
  [rows, rootTaskId, hideTerminal],
);
```

Pass controlled state to TreeList:
```tsx
hideTerminal: { isTerminal, value: hideTerminal, onValueChange: setHideTerminal },
```

## Critical Files

| File | Action |
|------|--------|
| `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` | Modify — controlled/uncontrolled bridge, export `hideTerminalSubtrees` |
| `plugins/primitives/plugins/tree/web/index.ts` | Modify — re-export `hideTerminalSubtrees` |
| `plugins/tasks/plugins/task-list/web/components/tasks-list.tsx` | Modify — lift state, filter orderedIds |

## Backward Compatibility

- Only 2 consumers of TreeList: `tasks-list.tsx` and `agents-list.tsx`
- `agents-list.tsx` does NOT pass `hideTerminal` at all — completely unaffected
- `tasks-list.tsx` is being updated as part of this change
- Uncontrolled mode (no `value`/`onValueChange`) works identically to current behavior

## Verification

1. `./equin build`
2. Open task list, toggle "Hide completed" on
3. Shift-click two visible tasks with hidden completed tasks between them → only visible tasks selected
4. Click "Select all" → count matches visible row count, not total
5. Toggle "Hide completed" off → hidden tasks reappear, are NOT pre-selected
6. Toggle back on → any selected-but-now-hidden tasks are pruned from selection (existing `SET_ORDERED_IDS` reducer handles this)
