# Task Tools Renderer + Sticky Progress Card

## Context

Claude Code agents use native task tools (`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`) to break down their implementation work into trackable steps. Currently these tool calls fall through to the generic JSON renderer in the JSONL viewer, making it hard to follow an agent's progress. We want:

1. **Individual tool renderers** for all 6 task tools — compact, visually distinct cards.
2. **A sticky progress card** at the bottom of the JSONL viewer that aggregates task state into a live checklist, appearing when tasks exist and disappearing when all are complete.

## Plan

### Plugin location

Single plugin: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/task-tools/`

It contributes to two slot systems:
- `JsonlViewerTool.Renderer` (from `tool-call/web`) — 6 exact-name renderer entries
- `JsonlViewer.Overlay` (from `jsonl-viewer/web`) — 1 overlay entry for the progress card

### File structure

```
task-tools/
  package.json
  CLAUDE.md
  web/
    index.ts
    components/
      task-create-tool-view.tsx
      task-update-tool-view.tsx
      task-get-tool-view.tsx
      task-list-tool-view.tsx
      task-output-tool-view.tsx
      task-stop-tool-view.tsx
      task-progress-overlay.tsx
      use-task-aggregate.ts
```

### Part 1: Individual tool renderers

All follow the established pattern: accept `ToolRendererProps`, return `<ToolCallCard>`. All use `defaultOpen={false}` since task tools are high-volume internal operations.

| Tool | Name match | Summary | Body |
|---|---|---|---|
| `TaskCreate` | `name: "TaskCreate"` | Description text | None (compact) |
| `TaskUpdate` | `name: "TaskUpdate"` | Task ID + status badge | None unless error |
| `TaskGet` | `name: "TaskGet"` | Task ID | Result JSON (collapsed) |
| `TaskList` | `name: "TaskList"` | "N tasks" | Task list from result |
| `TaskOutput` | `name: "TaskOutput"` | Task ID | Output text (collapsed) |
| `TaskStop` | `name: "TaskStop"` | Task ID | None unless error |

Input types are cast defensively from `event.input as T` with optional fields. Results parsed via `try/catch` on `JSON.parse(event.result.content)`.

**Key imports** (same as `add-task` pattern):
```ts
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
```

**TaskUpdate status badges** — Claude Code uses status strings like `"in_progress"`, `"completed"`. Render as a small colored pill in the summary:
- `in_progress` → blue pill
- `completed` → emerald pill
- Other → muted pill

### Part 2: Sticky progress card

#### Data: `use-task-aggregate.ts`

A hook that scans the JSONL event stream and builds a live task state map.

```ts
interface TaskEntry {
  taskId: string;
  description: string;
  status: string; // "pending" | "in_progress" | "completed" | ...
}

interface TaskAggregate {
  tasks: TaskEntry[];
  completedCount: number;
  totalCount: number;
  shouldShow: boolean;
}
```

**Event processing** (sequential scan of `events` array):
1. `tool-call` with `name === "TaskCreate"` + `event.result` present → parse result for task ID, parse input for description. Initial status: `"pending"`.
2. `tool-call` with `name === "TaskUpdate"` + `event.result` present and not error → parse input for `id` and `status`, update entry.
3. `tool-call` with `name === "TaskStop"` + `event.result` present → set status `"stopped"`.

**Visibility**: `shouldShow = tasks.length > 0 && !allTerminal`. Terminal set: `completed`, `failed`, `stopped`.

**Context**: Uses `conversationPane.useParams()` for conversation ID, `useResource(jsonlEventsResource, { id })` for the event stream. `useMemo` over the event array for the aggregation — no secondary resource needed.

#### UI: `task-progress-overlay.tsx`

**Positioning** within the `relative min-h-0 flex-1` overlay container in `JsonlPane`:
```
absolute bottom-10 inset-x-0 z-10 flex justify-center pointer-events-none
```

The inner card gets `pointer-events-auto`. Position clears the token counter (`bottom-2`) and doesn't spatially conflict with `JumpToBottomButton` (`bottom-12 right-4`) since the card is centered with `max-w-sm`.

**Card structure**:
```
outer: absolute bottom-10 inset-x-0 z-10 pointer-events-none flex justify-center
  inner: pointer-events-auto max-w-sm w-full mx-4 rounded-lg border bg-background/90 backdrop-blur-sm shadow-sm
    header: flex items-center px-3 py-2
      left:  "3/7 complete" (tabular-nums text-xs text-muted-foreground)
      right: collapse chevron + dismiss X
    task list (when expanded): max-h-[180px] overflow-y-auto
      each row: flex items-center gap-2 px-3 py-1 text-xs
        status icon (16px) + description (truncate) + optional taskId mono
```

**Status icons** (local mapping, not importing from `task-status` plugin since Claude Code statuses differ):
- `pending` → `MdRadioButtonUnchecked` muted
- `in_progress` → `MdTimelapse` blue
- `completed` → `MdCheckCircle` emerald
- `failed` → `MdCancel` destructive
- `stopped` → `MdStopCircle` muted
- Unknown → `MdRadioButtonUnchecked` muted (graceful fallback)

**Behavior**:
- Appears when `shouldShow` is true (tasks exist, not all terminal)
- Disappears when all tasks are terminal or no tasks
- Collapsible (click chevron to toggle task list, header always visible)
- Dismissible (X button, `useState` — session-scoped)

### `web/index.ts`

```ts
export default {
  id: "conversation-jsonl-viewer-tool-call-task-tools",
  name: "JSONL Viewer: Claude Code task tool renderers",
  description: "Renders TaskCreate/Update/Get/List/Output/Stop tool calls with a sticky progress overlay.",
  contributions: [
    JsonlViewerTool.Renderer({ name: "TaskCreate",  component: TaskCreateToolView }),
    JsonlViewerTool.Renderer({ name: "TaskUpdate",  component: TaskUpdateToolView }),
    JsonlViewerTool.Renderer({ name: "TaskGet",     component: TaskGetToolView }),
    JsonlViewerTool.Renderer({ name: "TaskList",    component: TaskListToolView }),
    JsonlViewerTool.Renderer({ name: "TaskOutput",  component: TaskOutputToolView }),
    JsonlViewerTool.Renderer({ name: "TaskStop",    component: TaskStopToolView }),
    JsonlViewer.Overlay({ id: "task-progress", component: TaskProgressOverlay }),
  ],
} satisfies PluginDefinition;
```

### Critical files to reference

| File | Why |
|---|---|
| `.../tool-call/plugins/add-task/web/components/add-task-tool-view.tsx` | Pattern for tool renderers |
| `.../jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx` | Pattern for overlay + useResource + conversationPane.useParams() |
| `.../tool-call/web/components/tool-call-card.tsx` | ToolCallCard props: `event, summary?, children?, defaultOpen?` |
| `.../tool-call/core/index.ts` | ToolRendererProps, ToolCallEvent types |
| `.../jsonl-viewer/core/index.ts` | jsonlEventsResource export |
| `.../jsonl-viewer/web/slots.ts` | JsonlViewer.Overlay slot definition |
| `.../jsonl-viewer/web/components/jsonl-pane.tsx` | Overlay rendering context and positioning constraints |

### Sequencing

1. Create `package.json` + `CLAUDE.md`
2. Implement `use-task-aggregate.ts` (foundational hook)
3. Implement the 6 tool renderer components
4. Implement `task-progress-overlay.tsx`
5. Wire in `web/index.ts`
6. `./equin build` and test against a conversation with active task tools

### Verification

1. Open a conversation where the agent used TaskCreate/TaskUpdate tools
2. Verify individual tool calls render with proper summaries instead of generic JSON
3. Verify the sticky progress card appears at the bottom with correct task count
4. Verify the card disappears when all tasks are completed
5. Verify dismiss (X) and collapse (chevron) work
6. Verify no conflict with JumpToBottomButton or token counter overlays
7. Verify auto-scroll still works correctly with the overlay present
