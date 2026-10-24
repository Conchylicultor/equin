# Message Footer Redesign

## Context

The JSONL viewer's user and assistant messages currently display a `SectionLabel` header with role labels ("User"/"Assistant") and timestamps at the top, while per-row action buttons (raw JSON, copy, markdown toggle, fork) render as an absolute-positioned hover overlay in the top-right corner. The user wants:

1. Remove the "User"/"Assistant" role labels
2. Move timestamps from the header to a footer below the message content
3. Unify the timestamp with the row action buttons in a single footer
4. Make this footer area a `defineRenderSlot` for extensibility
5. Entire footer is hover-reveal
6. Everything in the footer is a slot contribution — no hardcoded elements

## Design

### Unified slot: convert `JsonlViewer.RowAction` to `defineRenderSlot`

Convert the existing `RowAction` from `defineSlot` to `defineRenderSlot`. Same contribution shape, same factory signature — zero breaking changes for existing contributors.

Timestamp and stop reason become RowAction contributions alongside action buttons. The footer is purely `RowAction.Render` in a flex wrapper — no dedicated `EventFooterBar` component.

The same slot renders in two ways depending on event kind:
- **Message events** (user-text, assistant-text): footer below the card, hover-reveal
- **Other events** (tool-call, thinking, system, etc.): hover overlay (same position as today, refactored to use `.Render`)

### Footer rendering (inline in each message row)

```tsx
<div className="mt-1.5 flex items-center gap-1.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
  <JsonlViewer.RowAction.Render>
    {(item) => <item.component event={event} />}
  </JsonlViewer.RowAction.Render>
</div>
```

## File changes

### 1. `jsonl-viewer/web/slots.ts`
- Change `RowAction` from `defineSlot` → `defineRenderSlot`
- Add import of `defineRenderSlot` from `@plugins/primitives/plugins/slot-render/web`

### 2. `jsonl-viewer/web/components/timestamp-action.tsx` (new)
- `TimestampAction` component: renders `formatTime(event.at)` as a `<span>` with muted styling
- Renders for all event kinds

### 3. `jsonl-viewer/web/index.ts`
- Register `TimestampAction` as a `RowAction` contribution: `RowAction({ id: "timestamp", component: TimestampAction })`
- Add it alongside the existing `RawJsonAction` registration

### 4. `assistant-text/web/components/stop-reason-action.tsx` (new)
- `StopReasonAction` component: renders `e.stopReason` as a muted badge
- Returns null for non-assistant-text events or when no stop reason

### 5. `assistant-text/web/index.ts`
- Register `StopReasonAction` as a `RowAction` contribution: `RowAction({ id: "stop-reason", component: StopReasonAction })`

### 6. `jsonl-viewer/web/components/event-row.tsx`
- Suppress hover `RowActions` for `user-text` and `assistant-text` events (the footer inside each row handles them)
- Refactor `RowActions` to use `.Render` instead of manual `.useContributions()` + `.map()`

### 7. `user-text/web/components/user-text-row.tsx`
- Remove `SectionLabel` with "User" + timestamp
- Add inline footer div with `RowAction.Render` below the card content

### 8. `assistant-text/web/components/assistant-text-row.tsx`
- Remove `SectionLabel` with "Assistant" + timestamp + stop reason
- Add inline footer div with `RowAction.Render` below the card content

## Key files

- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/timestamp-action.tsx` (new)
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/event-row.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/stop-reason-action.tsx` (new)
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`

## Verification

1. `./equin build`
2. Open a conversation with user and assistant messages — verify:
   - No "User"/"Assistant" labels
   - Hover below a message reveals timestamp + action buttons as a footer
   - Sticky user message behavior still works
3. Open a conversation with tool calls — verify hover overlay still works on those rows
4. Test the message TOC still scrolls to correct positions
