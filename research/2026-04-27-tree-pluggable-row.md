# TreeList: pluggable `Row` component

## Context

`TreeList` (in `plugins/tree`) is a generic tree component used by `tasks` and
`agents` lists today, and is wanted by the upcoming `yak-shaving` dashboard
(see `research/2026-04-26-yak-shaving-dashboard.md`, sub-task C).

Its current API funnels everything per-row through narrow callbacks:

```
labelOf:        (row) => string         // becomes an <input> for inline rename
renderLeading?: (row) => ReactNode      // before label
renderActions?: (row, ctx) => ReactNode // right edge
rowClassName?, rowMenu?
```

The yak-shaving rows want stacked content per row (status dot + bold title +
muted one-line context + italic next-action + regen button). That can't be
expressed through a single `string` label, and bolting on a `renderLabel` slot
just patches one symptom — every future row variation (badges next to title,
multi-line notes, inline progress bars, …) would need yet another slot.

Per the user's direction (supersedes the doc's sub-task C as written): instead
of growing more slots, **`TreeList` should accept a `Row` component**, and the
existing `tasks` / `agents` lists should be rewritten to provide their own
`Row`. The tree plugin exposes the row chrome (drag handle, expand chevron,
droppable zones, indentation, recursion) as composable primitives so each
consumer assembles its own row from them.

Outcome: `TreeList`'s API shrinks to tree-wide concerns, all per-row visuals
move to plugin-owned components, and the yak dashboard plugs in its rich row
without TreeList knowing or caring.

## Approach

### 1. New `TreeList` API (per-row props removed)

`plugins/tree/web/internal/tree-list.tsx` keeps tree-wide concerns; everything
per-row is delegated to the consumer's `Row` component.

```ts
export type TreeListProps<T extends TreeItem> = {
  rows: readonly T[];
  selectedId?: string;
  rootId?: string;

  // Tree-wide actions. Row primitives read these via TreeListContext.
  onSelect: (id: string) => void;
  onToggleExpanded: (id: string, next: boolean) => void | Promise<void>;
  onMove: (id: string, dest: { parentId: string | null; rank: string }) => void | Promise<void>;
  onCreate: (args: { parentId: string | null; rank?: string }) => Promise<string | null | undefined>;

  // The pluggable row.
  Row: (props: { node: TreeNode<T>; depth: number }) => ReactNode;

  // Drag overlay label (replaces today's `labelOf`-driven overlay).
  // Optional; falls back to a generic "Item" chip.
  dragOverlay?: (row: T) => ReactNode;

  toolbar?: { expandAll?: boolean; hideTerminal?: { isTerminal: (row: T) => boolean } };
  addLabel?: string | null;
};
```

Removed: `labelOf`, `onRename`, `renderLeading`, `renderActions`,
`rowClassName`, `rowMenu`. They live in the consumer's `Row` from now on.

### 2. New primitives exported from `plugins/tree/web`

All under `plugins/tree/web/internal/`, re-exported from `index.ts`.

#### `<RowChrome>` — the standard row shell

The 80% case. Wraps `children` with everything `TreeRow` does today *except*
the row interior:

- Indentation (`paddingLeft = depth * 16 + 4`)
- Drag handle (with optional dropdown menu)
- Expand chevron
- Three droppable zones (before / after / child) with their drop indicators
- Selection / hover / dragging styling
- Recursion: renders children when expanded, plus the per-subtree "Add" button

```tsx
type RowChromeProps<T extends TreeItem> = {
  node: TreeNode<T>;
  depth: number;
  children: ReactNode;          // the row interior between chrome + actions
  actions?: ReactNode;          // right edge; replaces renderActions
  menu?: RowMenuItem[];         // dropdown anchored on the drag handle
  className?: string;           // applied to the row interior wrapper
};
```

Default consumer: `<RowChrome node depth menu={...} actions={<Actions/>}> {interior} </RowChrome>`.

#### `<RenameInput>` — the inline rename input

Today's `<input>` extracted as a small primitive. Encapsulates the
debounced-commit / blur-commit / Enter-blur dance and pending-focus pickup:

```tsx
type RenameInputProps = {
  nodeId: string;               // used to pair with pending-focus state
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  className?: string;
  placeholder?: string;
};
```

Reads the pending-focus token through `useTreeRow(nodeId)` so newly created
rows still auto-focus + select. Existing tasks / agents rows wrap this:

```tsx
<RenameInput nodeId={node.id} value={node.title} onCommit={(v) => patchTask(node.id, { title: v })} />
```

#### `useTreeRow(nodeId)` — headless escape hatch

For rows that bypass `RowChrome` entirely (none today, but yak's
"context + next-action" sub-rows could grow that way):

```ts
function useTreeRow(nodeId: string): {
  isSelected: boolean;
  isDragging: boolean;
  isOpen: boolean;
  hasChildren: boolean;
  isOverChild: boolean;
  isOverBefore: boolean;
  isOverAfter: boolean;
  shouldAutoFocus: boolean;
  consumeAutoFocus: () => void;
  select: () => void;
  toggleExpanded: () => void;
  addChild: () => void;
  addBelow: () => void;
  // dnd bindings
  dragHandleProps: { ref: Ref; attributes: object; listeners: object };
  beforeRef: Ref; afterRef: Ref; childRef: Ref;
};
```

Internally pulls actions from a new `TreeListContext` (`onSelect`,
`onToggleExpanded`, `onCreate`, the `rows` array for sibling lookup, and the
pending-focus state). `RowChrome` and `RenameInput` are both built on this hook.

#### `RowMenuItem` — kept

Used by both `<RowChrome menu={...}>` and any plugin that wants its own
DropdownMenu. Same shape as today (`{ icon?, label, onClick }`).

### 3. Drag overlay

Today the overlay reads `labelOf(activeRow)`. Replaced by an optional
`dragOverlay` prop. When omitted the overlay shows a neutral "Item" chip — both
`tasks` and `agents` will pass `(t) => t.title` / `(a) => a.name` to keep
parity.

### 4. Refactor `tasks-list.tsx`

`plugins/tasks/web/components/tasks-list.tsx`. Define `TaskRow` and pass it in:

```tsx
function TaskRow({ node, depth }: { node: TreeNode<Task>; depth: number }) {
  const actions = TasksSlots.TaskActions.useContributions();
  const hasChildren = node.children.length > 0;
  const dropped = node.status === "dropped";
  const done = node.status === "done";
  return (
    <RowChrome
      node={node}
      depth={depth}
      menu={[{ icon: MdAdd, label: "Add item below", onClick: () => addBelow(node.id) }]}
      actions={actions.map((a) => (
        <a.component key={a.id} taskId={node.id} hasChildren={hasChildren} />
      ))}
    >
      <StatusIcon status={node.status} />
      <RenameInput
        nodeId={node.id}
        value={node.title}
        onCommit={(v) => patchTask(node.id, { title: v })}
        className={cn(dropped && "text-muted-foreground/70 line-through italic", done && "text-muted-foreground")}
      />
    </RowChrome>
  );
}

<TreeList<Task>
  rows={rows} rootId={rootTaskId} selectedId={selectedId}
  onSelect={...} onToggleExpanded={...} onMove={...} onCreate={createTaskRow}
  Row={TaskRow}
  dragOverlay={(t) => t.title}
  toolbar={{ expandAll: true, hideTerminal: { isTerminal: (t) => t.status === "done" || t.status === "dropped" } }}
  addLabel={rootTaskId ? null : "Add"}
/>
```

`addBelow` comes from `useTreeRow(node.id)` (so the menu builder lives where
the row is rendered, not as a TreeList prop).

`StatusIcon` and `STATUS_META` stay in this file as before.

### 5. Refactor `agents-list.tsx`

Same shape. `AgentRow` wraps `<RowChrome>` with `<AgentStatus agentId>` as
leading content + `<RenameInput value={a.name} onCommit={...}>` + actions.

### 6. Yak-shaving usage (sub-task C consumer demo)

When the yak plugin lands (sub-task B), its row will look like:

```tsx
function YakRow({ node, depth }: { node: TreeNode<YakNode>; depth: number }) {
  return (
    <RowChrome
      node={node} depth={depth}
      actions={<RegenerateNextActionButton nodeId={node.id} />}
    >
      <StatusDot status={node.status} convStatus={node.convStatus} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{node.title}</span>
        <span className="text-muted-foreground truncate text-xs">{node.oneLineContext}</span>
        {node.nextAction && (
          <span className="text-muted-foreground truncate text-xs italic">Next: {node.nextAction}</span>
        )}
      </div>
    </RowChrome>
  );
}
```

No `RenameInput`, no rename — `RowChrome` doesn't impose one. Click-to-select
is wired by `RowChrome` (calling `useTreeRow().select()` on the row body).

## Files to modify

| Path | Change |
|---|---|
| `plugins/tree/web/internal/tree-list.tsx` | Strip per-row props; accept `Row`, `dragOverlay`; provide `TreeListContext`. |
| `plugins/tree/web/internal/tree-row.tsx` | Replace with `row-chrome.tsx` (+ small helpers) — the existing file is no longer needed in its current shape. |
| `plugins/tree/web/internal/row-chrome.tsx` | NEW. The composable row shell. |
| `plugins/tree/web/internal/use-tree-row.ts` | NEW. Headless hook + `TreeListContext`. |
| `plugins/tree/web/internal/rename-input.tsx` | NEW. Extracted inline rename input. |
| `plugins/tree/web/internal/pending-focus.ts` | Keep; consumed by `useTreeRow`. |
| `plugins/tree/web/internal/types.ts` | Tighten — `RowContext` (`hasChildren`) moves into the hook return. |
| `plugins/tree/web/index.ts` | Export `TreeList`, `RowChrome`, `RenameInput`, `useTreeRow`, `RowMenuItem`, `TreeListProps`, `TreeItem`. Drop `RowContext` re-export. |
| `plugins/tasks/web/components/tasks-list.tsx` | Define `TaskRow`; pass to `<TreeList Row={TaskRow}>`. Behavior unchanged. |
| `plugins/agents/web/components/agents-list.tsx` | Define `AgentRow`; same migration. |
| `docs/plugins.md` | Update `tree` plugin's exports list (`plugins-doc-in-sync` check enforces this). |

No server changes. No DB migrations. No new plugin.

## Existing utilities reused

- `buildTree`, `computeDrop`, `isDescendant`, `TreeNode` — `plugins/tree/shared`.
- `pendingFocus` — `plugins/tree/web/internal/pending-focus.ts`.
- `@dnd-kit/core` (`DndContext`, `useDraggable`, `useDroppable`, `DragOverlay`) — already a dep.
- `generateKeyBetween` (`fractional-indexing`) — already used in `addBelow`.
- `DropdownMenu` primitives from `@/components/ui/dropdown-menu`.
- `cn` from `@/lib/utils`.

## Verification

End-to-end smoke after `./equin build`:

1. **Tasks list parity** — open `http://<worktree>.localhost:9000/tasks`. Verify:
   - Status icon renders, dropped/done text styling applied.
   - Inline rename works (type, blur → committed; Enter → blurs).
   - Drag-to-reorder + drop into / before / after a row works (drop indicators visible).
   - Drag handle dropdown shows "Add item below" and works.
   - Expand / collapse + "Expand all" toolbar toggle work.
   - "Hide completed" toggle hides done/dropped subtrees.
   - Action contributions (`Tasks.TaskActions`) render on hover.
   - Root "Add" button works; subtree mode (`rootTaskId` set) hides it.
   - Newly created rows auto-focus their rename input and are selected.
2. **Agents list parity** — open `http://<worktree>.localhost:9000/agents`. Same checklist minus toolbar (the agents list doesn't pass `toolbar`).
3. **`./equin check` passes** — including `plugins-doc-in-sync` against the updated `tree` exports.

Yak-shaving rows are out of scope for this sub-task; their first render lands
with sub-task B of the yak plan.

## Open questions / follow-ups

1. **`TreeListContext` vs prop drilling.** Using a context for `onSelect` /
   `onToggleExpanded` / `onCreate` / pending-focus avoids dragging them through
   every consumer's `Row`. Trade-off: one more provider, but it's contained
   within `TreeList`. Recommend going with context.
2. **Drag overlay rendered through `Row`?** A slightly more elegant option is
   to re-render the consumer's `Row` inside `<DragOverlay>` (so the dragged
   chip looks identical). Adds layout complications (the overlay isn't inside
   the tree's DnD context). The lightweight `dragOverlay?: (row) => ReactNode`
   keeps today's behavior (a small chip with the label) and is enough; revisit
   if a consumer asks for full-row drag previews.
3. **`RowMenuItem` location.** It currently lives in `tree-row.tsx`; moves to
   `row-chrome.tsx` (or a dedicated `types.ts` entry). Same shape.
