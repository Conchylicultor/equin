# Event counter as ActionBar contribution

## Context

The `JsonlPane` header bar hardcodes an event counter (`events.length`). This should be a `Conversation.ActionBar` slot contribution so there are no hardcoded elements in the toolbar.

## Changes

### New sub-plugin: `event-counter`

Path: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/event-counter/`

Structure mirrors `message-toc/`:

- `package.json` — `@singularity/plugin-conversations-conversation-view-jsonl-viewer-event-counter`
- `web/index.ts` — contributes `Conversation.ActionBar({ id: "event-counter", component: EventCounter })`
- `web/components/event-counter.tsx` — standalone component using `conversationPane.useData()` + `useResource(jsonlEventsResource, { id })` (same pattern as `message-toc`). Renders `<span className="tabular-nums text-xs text-muted-foreground">{count}</span>`. Returns null when count is 0.

## Files touched

| File | Action |
|---|---|
| `jsonl-viewer/plugins/event-counter/package.json` | Create |
| `jsonl-viewer/plugins/event-counter/web/index.ts` | Create |
| `jsonl-viewer/plugins/event-counter/web/components/event-counter.tsx` | Create |

Plugin registry (`plugins.generated.ts`) regenerates on `./equin build`.

## Verification

1. `./equin build`
2. Open a conversation — event counter visible in the ActionBar
3. Counter updates live as events stream in
