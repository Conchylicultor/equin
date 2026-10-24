# Conversation — Tasks Panel (right-pane)

## Context

Today, the only way to see a conversation's associated task (and any child tasks spawned from it) is to navigate to `/tasks` in the main Tasks panel, which drops the conversation context. As the agent-manager scales to nested agents spawning their own sub-tasks, an operator reviewing a conversation needs to see the task subtree *alongside* the conversation — not instead of it.

This plan adds a toolbar button on the conversation view that opens the existing right-pane with two stacked sections:

- **Top** — a task tree filtered to the conversation's active task and all its descendants
- **Bottom** — the task detail view for the currently-selected task (defaults to the active task)

The UX mirrors the existing Docs button (right-pane, list-on-top / detail-below) so it feels native.

## Architecture decisions

- **New plugin**: `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/`. This is where conversation-specific toolbar plugins live (vscode, open-app, docs-button, review, etc.). Plugin id: `conversation-tasks-panel`.
- **Reuse** `TasksList` and `TaskDetail` components from `plugins/tasks/web/components/`. The existing `file-pane` → `docs-pane` pattern (`docs-pane.tsx:7`) already imports a sibling plugin's component directly, so there is precedent.
- **Extend `TasksList` with two optional props**, `rootTaskId` and `onSelect`, so it can be reused in this scoped / controlled mode without forcing a refactor of the main `/tasks` panel. Both props are optional and default to current behavior (no filtering; click dispatches `Tasks.OpenTask`).
- **Selection state is local** to the pane component. Default: `conversation.taskId`. Clicking a row calls our `onSelect` — not `Tasks.OpenTask` — so the user stays in the conversation (answers Q2 / "update only within the pane").
- **Button is always shown** (Q1). A conversation always has a `taskId`, so the tree always renders at least the active node and the detail view always has something to show.

## Files to change

### 1. `plugins/tasks/web/components/tasks-list.tsx` (modify)

Add two optional props to `TasksList`:

```ts
export function TasksList({
  selectedId,
  rootTaskId,
  onSelect,
}: {
  selectedId?: string;
  rootTaskId?: string;
  onSelect?: (id: string) => void;
})
```

- **Filtering** — when `rootTaskId` is set, restrict `rows` before calling `buildTree`:
  ```ts
  let filtered = rows;
  if (rootTaskId) {
    const keep = new Set<string>([rootTaskId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (r.parentId && keep.has(r.parentId) && !keep.has(r.id)) {
          keep.add(r.id);
          grew = true;
        }
      }
    }
    filtered = rows.filter((r) => keep.has(r.id));
  }
  const tree = buildTree(filtered);
  ```
- **Root "Add" button** — hide the `<button>Add</button>` at `tasks-list.tsx:93-100` when `rootTaskId` is set (adding a new root inside a filtered subtree would be surprising; the per-node "Add child" button still works for descendants).
- **Row click override** — at `tasks-list.tsx:208-213`, when `onSelect` is provided, call `onSelect(node.id)` *instead of* `TasksCommands.OpenTask({ id: node.id })`. The `pendingFocusAcrossMount` logic should remain (it lets the new-child input auto-focus after creation).
- **Pass `onSelect` recursively** through `TaskNode` props so nested rows respect it.

### 2. New files in `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/`

```
tasks-panel/
├── package.json
├── tsconfig.json
└── web/
    ├── index.ts
    ├── views.tsx
    └── components/
        ├── tasks-button.tsx
        └── tasks-pane.tsx
```

Copy `package.json` and `tsconfig.json` from a sibling plugin (e.g. `docs-button/`) and rename the package. Suggested package name: `@plugins/conversations-conversation-view-tasks-panel` (match neighbors).

**`web/index.ts`** — contribute the button via `component` form so it can read `useRightPane()` for active-state styling:

```ts
import type { PluginDefinition } from "@core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web/slots";
import { TasksButton } from "./components/tasks-button";

const tasksPanelPlugin: PluginDefinition = {
  id: "conversation-tasks-panel",
  name: "Conversation: Tasks panel",
  description:
    "Toolbar button that opens a right pane showing the task tree (active task + children) and task detail.",
  contributions: [
    Conversation.Toolbar({ component: TasksButton }),
  ],
};
export default tasksPanelPlugin;
```

**`web/views.tsx`** — view factory + shared pane id:

```ts
import type { RightPaneDescriptor } from "@plugins/conversations/plugins/conversation-view/web/commands";
import { TasksPane } from "./components/tasks-pane";

export const TASKS_PANE_ID = "conversation.tasks-panel";

export function tasksRightPane(): RightPaneDescriptor {
  return { id: TASKS_PANE_ID, component: TasksPane };
}
```

**`web/components/tasks-button.tsx`** — mirrors `docs-button.tsx`:

```tsx
import { MdChecklist } from "react-icons/md";
import type { ConversationState } from "@plugins/conversations/plugins/conversation-view/web/slots";
import {
  Conversation,
  useRightPane,
} from "@plugins/conversations/plugins/conversation-view/web/commands";
import { Button } from "@/components/ui/button";
import { tasksRightPane, TASKS_PANE_ID } from "../views";

export function TasksButton({ conversation }: { conversation: ConversationState }) {
  const current = useRightPane();
  const isOpen = current?.id === TASKS_PANE_ID;
  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      size="sm"
      title="Tasks"
      aria-label="Tasks"
      aria-pressed={isOpen}
      onClick={() => Conversation.OpenRightPane(isOpen ? null : tasksRightPane())}
      className="gap-1.5"
    >
      <MdChecklist className="size-4" />
    </Button>
  );
}
```

**`web/components/tasks-pane.tsx`** — stacked layout using the docs-pane structure (`docs-pane.tsx:33-90`):

```tsx
import { useState } from "react";
import { MdClose } from "react-icons/md";
import { Button } from "@/components/ui/button";
import type { ConversationState } from "@plugins/conversations/plugins/conversation-view/web/slots";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web/commands";
import { TasksList } from "@plugins/tasks/web/components/tasks-list";
import { TaskDetail } from "@plugins/tasks/web/components/task-detail";

export function TasksPane({ conversation }: { conversation: ConversationState }) {
  const rootId = conversation.taskId;
  const [selectedId, setSelectedId] = useState<string>(rootId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="Close tasks"
          aria-label="Close tasks"
          onClick={() => Conversation.OpenRightPane(null)}
        >
          <MdClose className="size-4" />
        </Button>
        <div className="text-sm font-medium">Tasks</div>
      </div>
      <div className="max-h-[40%] min-h-0 shrink-0 overflow-auto border-b p-2">
        <TasksList
          rootTaskId={rootId}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <TaskDetail key={selectedId} taskId={selectedId} />
      </div>
    </div>
  );
}
```

Notes:
- `key={selectedId}` on `TaskDetail` forces a reset of its internal title/description state on switch — matches how `task-view.tsx:26` already keys it.
- `max-h-[40%]` + `min-h-0 flex-1` matches the docs-pane sizing so the two panes feel consistent.

### 3. `web/src/plugins.ts` (modify)

Register the new plugin. Follow the order used for other `conversation-view/plugins/*` entries.

### 4. `docs/plugins.md` (modify)

Add the new plugin entry under `conversation-view` → `plugins:`, matching the existing format:

```
- **`tasks-panel`** — Toolbar button opening a right pane with the conversation's task subtree (tree on top, detail below).
  - Contributes:
    - `Conversation.Toolbar` → `TasksButton`
```

### 5. `package.json` workspace (implicit)

`bun install` picks the new workspace up automatically because root `package.json` uses `plugins/**`. No manual edit expected.

## Verification

1. `./equin build` — regenerates migrations (none should change), builds frontend + server, reloads gateway.
2. Open `http://<worktree>.localhost:9000/c/<any-conversation-id>`.
3. In the toolbar, the Tasks (✓) button should appear on the right side (non-`status` group). Click it:
   - Right pane opens.
   - Top: tree showing the conversation's active task; if that task has children, they render (not an exhaustive list of all tasks in the DB).
   - Bottom: detail view of the active task (title, description, status, drop/launch buttons).
4. Click a child task row in the tree — the bottom detail view switches to that task. Browser URL does **not** change (no `/tasks/:id` navigation).
5. Edit the title/description in the detail — debounced save still works (`TaskDetail` is unchanged).
6. Click the close (×) button in the pane header — right pane closes.
7. Navigate to `/tasks` via the sidebar — unfiltered tree still renders (regression check for the optional `rootTaskId` change).
8. In `/tasks`, click a row — it should still call `Tasks.OpenTask` and navigate (`onSelect` is unset, so behavior is unchanged).
9. E2E sanity with the helper:
   ```
   bun e2e/screenshot.mjs \
     --url http://<worktree>.localhost:9000/c/<conversation-id> \
     --click "Tasks" \
     --out /tmp/tasks-pane
   ```
   Confirm the `-after.png` shows both stacked sections.

## Out of scope

- No vertical resize handle between tree and detail (fixed 40% / grow, matching docs-pane). Can revisit if it feels cramped in practice.
- No search/filter inside the tree (the tree is already scoped to the subtree; flat search would be more useful at `/tasks` than here).
- No "open in full /tasks view" shortcut — user can click the sidebar Tasks entry.
