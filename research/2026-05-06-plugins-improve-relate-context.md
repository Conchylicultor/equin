# Unify "add child task" into the Improve button via ambient relate context

## Context

Two separate surfaces create tasks linked to a conversation:
- **Improve button** (`Shell.Toolbar`) — creates standalone improvement tasks under a meta-task. No conversation awareness.
- **New child task** button (`Conversation.ActionBar`) — creates a child task of the conversation's task, with follow-up/prerequisite toggle.

The goal is to unify these: when a conversation is active, the Improve button's popover offers relationship options (Independent / Follow-up / Prerequisite) so the new task can optionally depend on the conversation's task. The `new-child-task` action bar button is removed.

## Key constraint

The Improve button renders in `Shell.Toolbar`, **outside** the conversation pane's React subtree. It cannot call `conversationPane.useData()`. A React context bridge won't work — we need a module-level reactive store that crosses React tree boundaries. This follows the `ActiveDataIdentityProvider` precedent in the codebase, but uses `useSyncExternalStore` instead of React context since the producer and consumer are in disjoint React trees.

## Design

### Module-level store in task-draft-form

**New file: `plugins/tasks/plugins/task-draft-form/web/active-relate-context.ts`**

```ts
interface ActiveRelateContext {
  taskId: string;
  taskTitle?: string;  // for display in the form
}
```

API:
- `setActiveRelateContext(owner: symbol, ctx: ActiveRelateContext | null)` — called by pane providers. Owner symbol prevents a closing side-pane from wiping the foreground pane's context.
- `useActiveRelateContext(): ActiveRelateContext | null` — called by `TaskDraftPopover`. Uses `useSyncExternalStore`.

Exported from the task-draft-form barrel.

### Syncer in conversation-view

**New component in `plugins/conversations/plugins/conversation-view/web/components/active-relate-sync.tsx`**:

```tsx
function ActiveRelateSync() {
  const { conversation } = conversationPane.useData();
  const ownerRef = useRef(Symbol());
  useEffect(() => {
    const owner = ownerRef.current;
    if (conversation.taskId) {
      setActiveRelateContext(owner, { taskId: conversation.taskId });
    }
    return () => setActiveRelateContext(owner, null);
  }, [conversation.taskId]);
  return null;
}
```

Rendered inside `ConversationPaneProvide` (the URL-routed pane provider), **not** inside the generic `ConversationProvide` utility. This ensures only the primary pane-routed conversation sets context — side-conversations and embedded viewers don't interfere.

```tsx
// panes.tsx
function ConversationPaneProvide({ children }) {
  const { convId } = conversationPane.useParams();
  return (
    <ConversationProvide convId={convId}>
      <ActiveRelateSync />
      {children}
    </ConversationProvide>
  );
}
```

### TaskDraftPopover reads ambient context

In `task-draft-popover.tsx`:

```tsx
const activeRelate = useActiveRelateContext();
const hasAmbientRelate = !relate && activeRelate !== null;

const [ambientRelateMode, setAmbientRelateMode] = useState<TaskChainRelateMode | undefined>(undefined);
// undefined = Independent (default when ambient context is present)
```

Submit logic — prefer static `relate`, then ambient:
```tsx
const effectiveRelate =
  relate && relateMode
    ? { taskId: relate.taskId, mode: relateMode }
    : hasAmbientRelate && ambientRelateMode && activeRelate
      ? { taskId: activeRelate.taskId, mode: ambientRelateMode }
      : undefined;
```

Pass to `TaskDraftForm`:
```tsx
relateMode={relate ? relateMode : (hasAmbientRelate ? ambientRelateMode : undefined)}
onRelateModeChange={relate ? setRelateMode : (hasAmbientRelate ? setAmbientRelateMode : undefined)}
showIndependent={hasAmbientRelate}
```

`resetForm` also resets `ambientRelateMode` to `undefined` (back to Independent).

### RelateModeChip: add "Independent" option

Extend `RelateModeChip` props:

```ts
interface RelateModeChipProps {
  value: TaskChainRelateMode | undefined;           // undefined = Independent
  onChange: (next: TaskChainRelateMode | undefined) => void;
  showIndependent?: boolean;  // when true, prepend Independent button
  disabled?: boolean;
}
```

When `showIndependent` is true, the radio group becomes 3 buttons: Independent (undefined) | Follow-up | Prerequisite. When false (default), behaves exactly as today.

### Target stays unchanged

The `target` remains `{ kind: "metaTask", metaTaskId: IMPROVEMENTS_META_TASK_ID }`. Improvement tasks are filed under Improvements. The `relate` field only adds a task **dependency** (follow-up/prerequisite), which is orthogonal to tree placement.

This is a deliberate simplification vs. the old `new-child-task` behavior (which used `target: { kind: "child" }`). Dependencies are the right primitive for "do this before/after that task"; tree hierarchy is for organizational grouping.

### Remove new-child-task

The sub-plugin `plugins/conversations/plugins/conversation-view/plugins/new-child-task/` is removed:
- Empty out its `contributions` array (or delete the web/ directory if preferred).
- The `Conversation.ActionBar` contribution is gone — the `+` button disappears from the conversation toolbar.

## Files to modify

| File | Change |
|------|--------|
| `plugins/tasks/plugins/task-draft-form/web/active-relate-context.ts` | **New** — module-level store |
| `plugins/tasks/plugins/task-draft-form/web/index.ts` | Export `setActiveRelateContext`, `useActiveRelateContext`, `ActiveRelateContext` |
| `plugins/tasks/plugins/task-draft-form/web/components/relate-mode-chip.tsx` | Add `showIndependent` prop, widen value type to include `undefined` |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx` | Thread `showIndependent` prop through to `RelateModeChip` |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-form.tsx` | Thread `showIndependent` prop; widen `relateMode` type to `TaskChainRelateMode \| undefined` |
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-popover.tsx` | Read `useActiveRelateContext()`, manage `ambientRelateMode` state, compute `effectiveRelate` |
| `plugins/conversations/plugins/conversation-view/web/components/active-relate-sync.tsx` | **New** — syncer component |
| `plugins/conversations/plugins/conversation-view/web/panes.tsx` | Render `<ActiveRelateSync />` inside `ConversationPaneProvide` |
| `plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/index.ts` | Empty contributions (or delete plugin) |

## Verification

1. `./equin build` succeeds
2. Navigate to a conversation — click Improve — the form shows a 3-way relate selector (Independent / Follow-up / Prerequisite) with Independent pre-selected
3. Select "Follow-up", type a task, submit — verify the created task has a dependency on the conversation's task (check via task detail pane → dependencies section)
4. Select "Independent", submit — verify no dependency
5. Navigate away from conversations (e.g. to tasks list) — click Improve — no relate selector shown (ambient context cleared)
6. Open a conversation with no taskId (if possible) — Improve should not show the relate selector
7. Old `new-child-task` button is gone from the conversation action bar
