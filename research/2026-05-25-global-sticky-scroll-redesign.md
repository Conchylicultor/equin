# Redesign useStickyScroll: remove ResizeObserver, caller-driven scrolling

## Context

Clicking a file-link in a tool call (Read, Write, Edit) scrolls the conversation all the way to the bottom. Root cause: `useStickyScroll` uses a `ResizeObserver` on content height to detect "new content added" and auto-scroll. But viewport narrowing (from opening the file pane) causes text to reflow, which increases content height — the observer can't distinguish reflow from new content, so it scrolls to bottom.

This is a fundamental design flaw, not a tuning problem. Modern chat apps (Slack, Discord, VS Code terminal) don't guess when content changed via DOM observation — the content producer signals it explicitly.

## Design

### New `useStickyScroll` — passive sensor, no observers

The hook becomes a pin-state tracker + manual scroll API. No `ResizeObserver`, no `contentRef`.

**API change:**

```ts
// Before
interface StickyScrollHandle {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;  // REMOVED
  isPinned: boolean;
  hasUnread: boolean;
  jumpToBottom: () => void;
}

// After
interface StickyScrollHandle {
  scrollRef: RefObject<HTMLDivElement | null>;
  isPinned: boolean;
  hasUnread: boolean;
  jumpToBottom: () => void;       // smooth scroll, for user-initiated "go to bottom"
  scrollIfPinned: () => void;     // NEW — instant scroll if pinned, sets hasUnread if not
}
```

**Options stay the same:** `threshold`, `forceScrollKey`, `resetKey`.

**`overflow-anchor`:** The hook sets `overflow-anchor: auto` on `scrollRef` unconditionally. The browser natively preserves scroll position during reflow. When `scrollIfPinned()` or `jumpToBottom()` is called, they just set `scrollTop = scrollHeight` — no conflict with overflow-anchor since we're explicitly scrolling. Remove the dynamic `none`/`auto` toggling.

> Actually — `overflow-anchor: auto` anchors to an element *above* the viewport. When pinned and new content appears below, the browser would anchor to existing content and *not* scroll down. That's fine — we explicitly call `scrollIfPinned()` for that. But when unpinned and content above the viewport grows (e.g. a collapsed section expands), `overflow-anchor: auto` keeps the user's position stable. This is exactly correct.
>
> One subtlety: when pinned, `scrollIfPinned()` sets `scrollTop = scrollHeight`. If `overflow-anchor` is `auto`, the browser may try to anchor after our scroll, fighting us. The current code toggles `none` when pinned to prevent this. We should keep that behavior: `none` when pinned (so our explicit scrollToBottom sticks), `auto` when unpinned (so the browser stabilizes position on reflow).

**`scrollIfPinned` implementation:** Uses `requestAnimationFrame` to scroll after paint (same timing as current ResizeObserver approach). Sets `hasUnread = true` if not pinned.

### Consumer updates

**1. `jsonl-pane.tsx`** — JSONL conversation viewer

```tsx
const sticky = useStickyScroll({
  resetKey: conversation.id,
  forceScrollKey: isWorking ? 1 : 0,
});

// Scroll when new events arrive
useEffect(() => {
  sticky.scrollIfPinned();
}, [events.length]);

return (
  <div ref={sticky.scrollRef} className="overflow-auto ...">
    {/* no contentRef wrapper needed */}
    {events.map(...)}
  </div>
);
```

Signal: `events.length` (from `useResource(jsonlEventsResource)` — push-based live-state).

**2. `build-log-section.tsx`** — Streaming build logs

```tsx
const stickyScroll = useStickyScroll({ resetKey: "build" });

useEffect(() => {
  stickyScroll.scrollIfPinned();
}, [entries.length]);
```

Signal: `entries.length` (state grows via WebSocket `onMessage`).

**3. `build-popover-content.tsx`** — Build history popover

Same pattern as #2 — `useEffect` on `entries.length`.

### Pane instanceId preservation (already implemented)

When updating an existing pane slot with new params, preserve the slot's `instanceId`/`uuid` instead of creating a new one via `createSlot()`. This avoids unnecessary column remount/reflow when switching files in an already-open file pane.

- `openPaneImpl`: `{ ...existing, params: ownParams, input }` instead of `createSlot(...)`
- `useOpenPane` push-right path: same treatment when `nextSlot.paneId === targetInternal.id`

## Files to modify

| File | Change |
|------|--------|
| `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` | Remove ResizeObservers, remove `contentRef`, add `scrollIfPinned()`, keep `overflow-anchor` toggling |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx` | Remove `contentRef` from JSX, add `useEffect` on `events.length` calling `scrollIfPinned()` |
| `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` | Remove `contentRef` from JSX, add `useEffect` on `entries.length` calling `scrollIfPinned()` |
| `plugins/build/web/components/build-popover-content.tsx` | Remove `contentRef` from JSX, add `useEffect` on `entries.length` calling `scrollIfPinned()` |
| `plugins/primitives/plugins/pane/web/pane.ts` | Preserve `instanceId` on existing pane update (already done) |

## Verification

1. `./equin build` — deploys to worktree namespace
2. Open a conversation with tool calls (Read/Write/Edit)
3. Scroll up partway in the conversation
4. Click a file path link in a tool call → file pane opens, conversation should NOT scroll
5. Click a different file path → file pane updates, conversation should NOT scroll
6. Open a conversation with an active agent (working status) → new streaming events should auto-scroll when pinned to bottom
7. Scroll up during active streaming → should stop auto-scrolling, "unread" indicator appears
8. Open build logs during a build → logs should stream and stick to bottom
9. Resize the browser window while viewing a conversation → scroll position should be preserved
