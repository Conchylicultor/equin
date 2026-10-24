# Task Notification Rendering in JSONL Viewer

## Context

Claude Code task notifications (`<task-notification>` XML tags) appear as regular user messages in the conversation view, polluting the transcript with system metadata. These are injected by the Claude Code harness when a background task (e.g. `Bash` with `run_in_background`) completes. They are semantically *not* user text — they're system-injected metadata about background operations.

We render them as a new `task-notification` event kind rather than attaching to the originating tool-call, because the notification arrives many turns later — chronological rendering as a standalone compact row is more natural.

## Changes

### 1. Add `task-notification` to the protocol

**File:** `plugins/conversations/plugins/transcript-watcher/core/protocol.ts`

Add new variant to `JsonlEventSchema` discriminated union:

```ts
z.object({
  kind: z.literal("task-notification"),
  at: z.string(),
  taskId: z.string(),
  toolUseId: z.string().optional(),
  status: z.string(),
  summary: z.string(),
}),
```

### 2. Extract task notifications in the parser

**File:** `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts`

Add `extractTaskNotifications(text, at, out): string` — synchronous function that:
1. Regex-scans for `<task-notification>...</task-notification>` blocks
2. Parses inner fields (`task-id`, `tool-use-id`, `status`, `summary`) via simple regex
3. Pushes `{ kind: "task-notification", ... }` events to the output array
4. Returns the text with notification blocks stripped

Call at two sites in the user-message branch:
- String content (line ~177): extract first, then `pushTextWithImages` only if remaining text is non-empty
- Array text block (line ~199): same treatment

### 3. Create the renderer plugin

**Directory:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/task-notification/`

3 files, following the `system` plugin template:

- `package.json` — `@singularity/plugin-conversations-conversation-view-jsonl-viewer-task-notification`
- `web/index.ts` — `JsonlViewer.EventRenderer({ kind: "task-notification", component: TaskNotificationRow })`
- `web/components/task-notification-row.tsx` — compact single-line row:

```
12:34:05  [bd2wbq498]  completed  Background command "Build to ..." completed (exit code 0)
```

Status coloring: `completed` → green, `failed` → red, default → muted.

### No changes needed

- `event-row.tsx` — dispatch is automatic via `c.kind === event.kind`
- `jsonl-pane.tsx` — only `user-text` triggers section breaks; `task-notification` falls naturally inside existing sections
- Plugin registry — `./equin build` auto-discovers the new plugin

## Verification

1. `./equin build`
2. Open `http://equin.localhost:9000/c/conv-1779220117-anca` (conversation with known task notifications)
3. Verify notifications render as compact rows, not user-message cards
4. Verify mixed messages (real text + notification) emit both events correctly
