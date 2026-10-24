# Message TOC — Floating Table of Contents for User Messages

## Context

Long conversations accumulate many events (tool calls, assistant text, etc.), making it hard to navigate back to a specific user message — the user prompts that anchored each "turn." The user wants a floating TOC in the top-right of the conversation scroll area that lists all user messages and allows clicking to jump to any one of them.

## Approach

Create a new `message-toc` sub-plugin under `jsonl-viewer/plugins/` that contributes to a new `JsonlViewer.Overlay` slot rendered in the scroll area's relative container.

### Why a slot (not inline code)

The project follows "every feature is a plugin." A slot keeps `jsonl-pane.tsx` free of TOC-specific logic and allows future overlay contributions (e.g., minimap, search results highlight) without modifying the host component.

## Changes

### 1. Add `data-event-index` to event rows

**File:** `plugins/.../jsonl-viewer/web/components/jsonl-pane.tsx`

Add `data-event-index={i}` to the `<EventRow>` call / wrapper so the TOC can target rows via DOM queries:
```tsx
// In the events.map() loop, pass index to EventRow
<EventRow key={...} event={event} index={i} />
```

In `event-row.tsx`, add the attribute to the wrapper div:
```tsx
<div className="group/row relative" data-event-index={index}>
```

### 2. Add `JsonlViewer.Overlay` slot

**File:** `plugins/.../jsonl-viewer/web/slots.ts`

```ts
interface OverlayContribution {
  id: string;
  component: ComponentType;
}

export const JsonlViewer = {
  // ...existing slots...
  Overlay: defineSlot<OverlayContribution>("conversation.jsonl-viewer.overlay"),
};
```

The component receives no props — it uses `conversationPane.useData()` for the conversation and `useResource(jsonlEventsResource, ...)` for events (deduplicated by TanStack Query cache).

### 3. Render overlay contributions in JsonlPane

**File:** `plugins/.../jsonl-viewer/web/components/jsonl-pane.tsx`

Inside the `<div className="relative min-h-0 flex-1">` container, render overlay contributions alongside the existing token badge and JumpToBottomButton:

```tsx
{overlays.map((o) => <o.component key={o.id} />)}
```

### 4. Export new slot type from barrel

**File:** `plugins/.../jsonl-viewer/web/index.ts`

Add `OverlayContribution` to the re-exports.

### 5. New plugin: `message-toc`

**Dir:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/message-toc/`

#### `package.json`
```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-message-toc",
  "private": true,
  "version": "0.0.1"
}
```

#### `web/index.ts`
```ts
import type { PluginDefinition } from "@core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { MessageToc } from "./components/message-toc";

export default {
  id: "conversation-jsonl-viewer-message-toc",
  name: "Conversation: Message TOC",
  description: "Floating table of contents listing user messages for quick navigation.",
  contributions: [
    JsonlViewer.Overlay({ id: "message-toc", component: MessageToc }),
  ],
} satisfies PluginDefinition;
```

#### `web/components/message-toc.tsx`

Compact floating panel in the top-right of the scroll area.

**Data:** calls `conversationPane.useData()` + `useResource(jsonlEventsResource, { id })`. Filters events to `kind === "user-text"`, records their original index in the full events array.

**Rendering:**
- Positioned `absolute top-2 right-3` inside the relative container (same z-layer as token badge / JumpToBottomButton)
- Small, semi-transparent: `bg-background/80 backdrop-blur border rounded-md shadow-sm`
- Toggle-able via a small icon header (list icon) — click to expand/collapse the list
- When expanded, shows a scrollable list of user messages:
  - Each entry: `#N` (1-based user message number) + truncated first line (~40 chars) + timestamp
  - Click → `document.querySelector([data-event-index="${eventIndex}"]).scrollIntoView({ behavior: "smooth", block: "start" })`
- When collapsed, shows just the icon + count badge

**Active message tracking (optional nice-to-have):**
- Use `IntersectionObserver` on user-text event rows to highlight the currently visible one in the TOC
- Deferred to a follow-up if time-constrained

**Responsive behavior:**
- If there are ≤1 user messages, render nothing (no value in a TOC with one entry)
- Max height `max-h-64` with `overflow-y-auto` for long conversations

## Files summary

| Action | File |
|--------|------|
| Modify | `plugins/.../jsonl-viewer/web/slots.ts` — add `Overlay` slot |
| Modify | `plugins/.../jsonl-viewer/web/index.ts` — export `OverlayContribution` |
| Modify | `plugins/.../jsonl-viewer/web/components/jsonl-pane.tsx` — render overlay slot, add `data-scroll-container` |
| Modify | `plugins/.../jsonl-viewer/web/components/event-row.tsx` — accept `index` prop, add `data-event-index` |
| Create | `plugins/.../jsonl-viewer/plugins/message-toc/package.json` |
| Create | `plugins/.../jsonl-viewer/plugins/message-toc/web/index.ts` |
| Create | `plugins/.../jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx` |

## Verification

1. `./equin build` — ensure no build errors
2. Open a conversation with multiple user messages at `http://<worktree>.localhost:9000`
3. Verify: floating TOC appears in top-right with all user messages listed
4. Click a message entry → view scrolls to that user message
5. Toggle collapse → panel minimizes to icon + badge
6. Conversation with 0-1 user messages → no TOC shown
