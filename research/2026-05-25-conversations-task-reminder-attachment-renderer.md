# Task Reminder Attachment Renderer

## Context

The `attachment` umbrella plugin at `jsonl-viewer/plugins/attachment/` dispatches attachment events to sub-plugin renderers via the `JsonlViewerAttachment.Renderer` slot. The `nested-memory` sub-plugin already renders `nested_memory` events. The `task_reminder` subtype still falls through to the `GenericAttachmentView` (collapsed JSON dump), which is unreadable for a task list.

This plan adds a `task-reminder` sub-plugin that renders `task_reminder` events as a compact, collapsible task list.

## Payload Shape (from research doc)

```ts
interface TaskReminderPayload {
  type: "task_reminder";
  itemCount: number;
  content: Array<{
    id: string;
    subject: string;
    description: string;
    activeForm: string;
    status: string; // "in_progress", "pending", "done", "blocked", etc.
    blocks: string[];
    blockedBy: string[];
  }>;
}
```

`itemCount` can be 0 (empty reminder). The `status` values come from Claude Code's internal task system, not equin's `TaskStatus` enum — they overlap but aren't guaranteed identical.

## Design

### Rendering

**Header (collapsed by default):**
- `CollapsibleChevron` + label "Task Reminder" + muted count badge `(N tasks)` / `(no tasks)` when 0

**Body (expanded):**
- If `itemCount === 0`: muted "No active tasks" text
- Otherwise: compact list of tasks, each row showing:
  - Colored status dot (inline, no cross-plugin import) mapped by status string
  - Subject text (primary)
  - Truncated description (muted, single line, ellipsis)

### Status colors (inline mapping, no dependency on `task-status` plugin)

The `task-status` plugin exports `StatusIcon`/`STATUS_META`, but the payload comes from Claude Code's internal task system with potentially different status values. A self-contained color mapping avoids a fragile cross-plugin dependency:

| status | dot color |
|---|---|
| `in_progress` | `bg-blue-500` |
| `done` / `completed` | `bg-emerald-500` |
| `blocked` | `bg-red-500` |
| `pending` / `new` | `bg-muted-foreground/40` |
| fallback | `bg-muted-foreground/40` |

## Files

### 1. `attachment/plugins/task-reminder/package.json` (new)

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-task-reminder",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `attachment/plugins/task-reminder/web/components/task-reminder-attachment-view.tsx` (new)

- Imports: `useCollapsible`, `CollapsibleChevron` from `@plugins/primitives/plugins/collapsible/web`
- Imports: `AttachmentRendererProps` from `@plugins/.../attachment/core`
- Casts `event.attachment` to `TaskReminderPayload`
- Renders collapsible with header label + count, body with task rows
- Each task row: status dot + subject + truncated description

### 3. `attachment/plugins/task-reminder/web/index.ts` (new)

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerAttachment } from "@plugins/.../attachment/web";
import { TaskReminderAttachmentView } from "./components/task-reminder-attachment-view";

export default {
  id: "conversation-jsonl-viewer-attachment-task-reminder",
  name: "JSONL Viewer: task-reminder attachment renderer",
  collapsed: true,
  description:
    "Renders task-reminder attachment events showing periodic task list injections.",
  contributions: [
    JsonlViewerAttachment.Renderer({
      subtype: "task_reminder",
      component: TaskReminderAttachmentView,
    }),
  ],
} satisfies PluginDefinition;
```

Mirrors `nested-memory/web/index.ts` byte-for-byte in structure.

## Verification

1. `./equin build` — succeeds, no TS errors, no boundary violations
2. Open conversation `conv-1779695590-m6pd` — `task_reminder` events render as collapsible "Task Reminder (N tasks)" rows instead of JSON dumps
3. `./equin check --plugin-boundaries` — passes
