# Multi-Select Primitive for List Plugins

## Context

No multi-selection exists anywhere in the codebase. All lists (task tree, conversation queue/history/grouped) are single-select only — `selectedId: string | undefined` in TreeList, `activeId` from URL in conversation views. Any feature needing bulk actions (bulk status change, bulk launch, bulk delete) would need to hand-roll selection state, shift-click range logic, and a selection-actions bar.

This plan creates a reusable `multi-select` primitive under `plugins/primitives/plugins/multi-select/` that any list plugin can layer on without modifying existing list primitives.

## Design

### Architecture: Parallel Context, Not Tree Extension

The primitive is a **standalone React Context** that wraps any list region. It does NOT modify `TreeList`, `RowChrome`, `useTreeRow`, or any conversation view component. Individual rows opt-in by calling a per-item hook.

This means:
- `RowChrome`'s `onClick={r.select}` (single-select navigation) stays untouched
- Checkbox click calls `e.stopPropagation()` → no navigation fires
- Both single-select (for pane navigation) and multi-select (for bulk) coexist independently
- Works for tree lists, flat lists, sidebar menu lists — any list

### Selection mode

**Implicit activation**: first checkbox click activates selection mode (`isActive` becomes `true` when `selectedIds.size > 0`). Clearing all deactivates. Optional `activate()`/`deactivate()` for explicit toggle buttons if consumers want one.

Checkboxes are always rendered by the row author (not injected via middleware) — they can be gated with `opacity-0 group-hover:opacity-100` when `!isActive`, always visible when `isActive`.

### Shift-click range

The provider receives `orderedIds: readonly string[]` — the flat visible order of all items. For flat lists this is trivial. For trees, the consumer derives it via pre-order DFS of expanded nodes (same order rows appear in the DOM).

Range logic: `orderedIds.slice(min(anchorIdx, targetIdx), max(anchorIdx, targetIdx) + 1)`. If either anchor or target is missing from `orderedIds` (collapsed/filtered out), falls back to single toggle.

## File Structure

```
plugins/primitives/plugins/multi-select/
├── package.json                         # @singularity/plugin-primitives-multi-select
└── web/
    ├── index.ts                         # barrel + PluginDefinition (contributions: [])
    └── internal/
        ├── multi-select-context.tsx     # state, reducer, React context
        ├── multi-select-provider.tsx    # <MultiSelectProvider orderedIds={...}>
        ├── use-multi-select.ts          # list-level hook (selectedIds, selectAll, clearAll)
        ├── use-multi-select-item.ts     # per-item hook (isSelected, toggle, checkboxProps)
        ├── selection-bar.tsx            # <SelectionBar actions={...}>
        └── selection-checkbox.tsx       # <SelectionCheckbox> — styled native checkbox
```

## Public API

### `multi-select-context.tsx`

```ts
type MultiSelectState = {
  orderedIds: readonly string[];
  selectedIds: Set<string>;
  anchorId: string | null;          // shift-click anchor
  isActive: boolean;                // true when selectedIds.size > 0
};

type MultiSelectAction =
  | { type: "TOGGLE"; id: string; shiftKey: boolean; metaKey: boolean }
  | { type: "SELECT_ALL" }
  | { type: "CLEAR_ALL" }
  | { type: "SET_ORDERED_IDS"; ids: readonly string[] }
  | { type: "REMOVE_IDS"; ids: readonly string[] };  // prune stale selections

// React context — createContext<{ state, dispatch } | null>(null)
```

Reducer `TOGGLE` logic:
1. **No modifier**: toggle the item; set it as anchor
2. **metaKey (cmd/ctrl)**: toggle independently; set as anchor
3. **shiftKey**: select range from `anchorId` to `id` using `orderedIds.indexOf()`; anchor stays

`SET_ORDERED_IDS` uses shallow array comparison to avoid churn.

`REMOVE_IDS` prunes IDs that disappeared (collapsed, filtered) from the selected set — called by the provider when `orderedIds` shrinks.

### `MultiSelectProvider`

```tsx
type MultiSelectProviderProps = {
  orderedIds: readonly string[];
  children: ReactNode;
};

function MultiSelectProvider({ orderedIds, children }: MultiSelectProviderProps): ReactElement;
```

- Wraps `useReducer(reducer, initialState)` in a Context provider
- `useEffect` dispatches `SET_ORDERED_IDS` when `orderedIds` changes (shallow comparison)
- Pure context provider — **no DOM wrapper**

### `useMultiSelect()` — list-level hook

```ts
type MultiSelectHandle = {
  selectedIds: ReadonlySet<string>;
  selectedCount: number;
  isActive: boolean;
  selectAll: () => void;
  clearAll: () => void;
};

function useMultiSelect(): MultiSelectHandle;
```

### `useMultiSelectItem(id)` — per-item hook

```ts
type MultiSelectItemHandle = {
  isSelected: boolean;
  isActive: boolean;                // whether any multi-select is active
  toggle: (e: React.MouseEvent) => void;
};

function useMultiSelectItem(id: string): MultiSelectItemHandle;
```

`toggle` reads `e.shiftKey` and `e.metaKey` from the event, dispatches `TOGGLE`, and calls `e.stopPropagation()` to prevent the row's navigation click.

### `SelectionCheckbox`

```tsx
type SelectionCheckboxProps = {
  id: string;
  className?: string;
};

function SelectionCheckbox({ id, className }: SelectionCheckboxProps): ReactElement;
```

- Self-contained: calls `useMultiSelectItem(id)` internally
- Renders a styled native `<input type="checkbox">` with `accent-color: primary`
- Handles `onClick` with `e.stopPropagation()` and modifier key forwarding

### `SelectionBar`

```tsx
type SelectionBarProps = {
  actions?: ReactNode;
  className?: string;
};

function SelectionBar({ actions, className }: SelectionBarProps): ReactElement | null;
```

- Calls `useMultiSelect()` internally; returns `null` when `!isActive`
- Renders: `[N selected] [Select all] [Clear] | {actions}`
- Styled as a bar with `bg-background` and border — sits as a sibling before the list

## Integration: Task List

**File**: `plugins/tasks/plugins/task-list/web/components/tasks-list.tsx`

```tsx
import {
  MultiSelectProvider,
  SelectionBar,
  SelectionCheckbox,
} from "@plugins/primitives/plugins/multi-select/web";

function TaskRow({ node, depth }: { node: TreeNode<Task>; depth: number }) {
  // ... existing code ...
  return (
    <RowChrome node={node} depth={depth} menu={...} actions={...}>
      <SelectionCheckbox id={node.id} />        {/* ← new, before StatusIcon */}
      <StatusIcon status={node.status} />
      <RenameInput ... />
      {queuedModel && <QueuedChip ... />}
    </RowChrome>
  );
}

export function TasksList({ selectedId, rootTaskId, onSelect }) {
  const { data: rows } = useResource(tasksResource);
  const orderedIds = useMemo(
    () => deriveVisibleOrder(rows, rootTaskId),
    [rows, rootTaskId],
  );

  return (
    <MultiSelectProvider orderedIds={orderedIds}>
      <SelectionBar actions={<BulkTaskActions />} />
      <TreeList<Task> ... />  {/* unchanged */}
    </MultiSelectProvider>
  );
}
```

`deriveVisibleOrder` does a pre-order DFS of expanded nodes — the same order `TreeList` renders them. It reuses `buildTree` from `@plugins/primitives/plugins/tree/core` and walks the resulting tree, pushing IDs of expanded nodes' children.

The `SelectionCheckbox` sits between the expand chevron and `StatusIcon` inside `RowChrome`'s flex row (via `children`). Clicking it stops propagation, so the row's `onClick={r.select}` (navigation) doesn't fire.

## Integration: Conversation Queue (future)

Same pattern — wrap `QueueView` in `MultiSelectProvider`, add `SelectionCheckbox` inside each row's `SidebarMenuButton`. This is deferred; the primitive is designed to support it without changes.

## Implementation Order

1. `package.json`
2. `multi-select-context.tsx` — state, reducer, context (most logic-dense)
3. `multi-select-provider.tsx` — provider component
4. `use-multi-select.ts` — list-level hook
5. `use-multi-select-item.ts` — per-item hook
6. `selection-checkbox.tsx` — styled checkbox
7. `selection-bar.tsx` — bar component
8. `web/index.ts` — barrel + PluginDefinition
9. Task list integration in `tasks-list.tsx`

## Critical Files

| File | Role |
|------|------|
| `plugins/primitives/plugins/multi-select/web/internal/multi-select-context.tsx` | **Create** — core state logic |
| `plugins/primitives/plugins/multi-select/web/internal/multi-select-provider.tsx` | **Create** — provider |
| `plugins/primitives/plugins/multi-select/web/internal/use-multi-select.ts` | **Create** — list hook |
| `plugins/primitives/plugins/multi-select/web/internal/use-multi-select-item.ts` | **Create** — item hook |
| `plugins/primitives/plugins/multi-select/web/internal/selection-checkbox.tsx` | **Create** — checkbox |
| `plugins/primitives/plugins/multi-select/web/internal/selection-bar.tsx` | **Create** — bar |
| `plugins/primitives/plugins/multi-select/web/index.ts` | **Create** — barrel |
| `plugins/primitives/plugins/multi-select/package.json` | **Create** — workspace entry |
| `plugins/tasks/plugins/task-list/web/components/tasks-list.tsx` | **Modify** — wrap in provider, add checkbox to row |
| `plugins/primitives/plugins/tree/core/internal/tree.ts` | **Read-only** — reuse `buildTree` for ordered-ids derivation |

## Verification

1. `bun install` from root (picks up new workspace)
2. `./equin build` (regenerates plugin registry, builds)
3. Open task list at the app URL
4. Verify: hover a task row → checkbox appears
5. Click checkbox → row gets selected, `SelectionBar` appears with "1 selected"
6. Click another checkbox → "2 selected"
7. Shift-click a third → range selected
8. Cmd-click to toggle individual items
9. "Select all" / "Clear" buttons work
10. Clicking a row body (not checkbox) still navigates to task detail (single-select unchanged)
