# Auto-scroll primitive plugin

## Context

Streaming surfaces in the app (jsonl-viewer today; logs, terminal, future chat panes tomorrow) all need the same UX: auto-scroll to bottom while the user is "near the bottom", but get out of the way the moment the user scrolls up to read history. This is a well-trodden pattern (Discord, Slack, ChatGPT, browser devtools), and getting it right requires several non-obvious details — threshold-based pinning, ResizeObserver-driven growth detection, `overflow-anchor: none`, instant vs smooth scroll for the right action, a "Jump to bottom" affordance.

The current jsonl-viewer implements a partial version of this inline: distance threshold of 40px, three intertwined `useEffect`s, no jump-to-bottom button, and a force-scroll path triggered by `isWorking` that bypasses the threshold (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx:71-97`). The logs pane reinvents the same pattern using a sentinel `<div>` + `IntersectionObserver` (`plugins/debug/plugins/logs/web/components/log-viewer.tsx:29-91`). Two implementations, both incomplete, neither with a "Jump to bottom" button.

We promote the pattern to a reusable primitive plugin so the UX is consistent everywhere, the gnarly pieces are written once, and future streaming surfaces drop in a one-liner.

## Design

### Plugin location

`plugins/primitives/plugins/auto-scroll/` — sibling of `editable-field`, `live-state`, `networking`. Web-only, no server.

```
plugins/primitives/plugins/auto-scroll/
├── package.json
└── web/
    ├── index.ts                  # barrel
    ├── use-sticky-scroll.ts      # the hook
    └── jump-to-bottom-button.tsx # the affordance
```

Registered in `web/src/plugins.ts` alongside the other primitives.

### Public API

The primitive exports **a hook + a small headless button**. Hook for the behavior, button for the affordance — consumers can skip the button if they don't want one.

```ts
// use-sticky-scroll.ts

export interface UseStickyScrollOptions {
  /** Distance from bottom (px) within which we consider the view "pinned". Default 50. */
  threshold?: number;
  /**
   * When this value changes, force a scroll to bottom regardless of pin state.
   * Increment a counter or pass a status string. Use case: jsonl-viewer's "turn sent"
   * force-scroll so the user sees their message even if they were scrolled up.
   */
  forceScrollKey?: number | string | boolean;
  /**
   * When this value changes, treat the content as a fresh stream:
   * scroll to bottom on next paint and reset the unread flag.
   * Use case: jsonl-viewer's `conversation.id` change.
   */
  resetKey?: string | number;
}

export interface StickyScrollHandle {
  /** Attach to the scrolling viewport (`overflow: auto/scroll`). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the inner content wrapper. ResizeObserver watches this. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** True when the user is within `threshold` of the bottom. */
  isPinned: boolean;
  /** True when content has grown while unpinned. Cleared on jumpToBottom() or re-pin. */
  hasUnread: boolean;
  /** Smooth-scroll to the bottom and re-pin. Call this from a button click. */
  jumpToBottom: () => void;
}

export function useStickyScroll(opts?: UseStickyScrollOptions): StickyScrollHandle;
```

```tsx
// jump-to-bottom-button.tsx

export interface JumpToBottomButtonProps {
  handle: StickyScrollHandle;
  className?: string;
  /** Optional badge/label inside the button (e.g. "3 new"). */
  label?: React.ReactNode;
}

export function JumpToBottomButton(props: JumpToBottomButtonProps): React.ReactElement | null;
```

The button:
- Returns `null` when `isPinned && !hasUnread` (nothing to do)
- Renders a small floating chevron-down button when unpinned or has unread
- Defaults to a positioned-by-consumer style (no `absolute`/`fixed` baked in); consumer applies `className="absolute bottom-4 right-4"`
- Uses `lucide-react` `ChevronDown`, matching project convention

### Usage shape

```tsx
const sticky = useStickyScroll({
  resetKey: conversation.id,
  forceScrollKey: isWorking ? "working" : "idle",
});

return (
  <div className="relative h-full min-h-0">
    <div ref={sticky.scrollRef} className="h-full overflow-auto">
      <div ref={sticky.contentRef}>
        {events.map(...)}
      </div>
    </div>
    <JumpToBottomButton
      handle={sticky}
      className="absolute bottom-4 right-4"
    />
  </div>
);
```

### Internal mechanics

- **Pin detection.** Single `scroll` event listener on `scrollRef.current`. Computes `distance = scrollHeight - scrollTop - clientHeight`. Flips `isPinned = distance < threshold`. Programmatic `scrollTop = scrollHeight` writes still emit a scroll event, but they land at distance 0 → still pinned, so we don't need separate user-intent disambiguation.
- **Growth detection.** `ResizeObserver` on `contentRef.current`. On every height increase: if pinned, instant-scroll to bottom (`scrollTop = scrollHeight`); if unpinned, set `hasUnread = true`.
- **`overflow-anchor: none`.** Applied imperatively on `scrollRef.current.style` in a `useLayoutEffect` so consumers don't have to remember. Browsers default to anchoring to upper content when content grows, which fights bottom-pinning.
- **Initial mount.** `useLayoutEffect` (runs before paint) sets `scrollTop = scrollHeight` once both refs are attached. No top-flash.
- **`resetKey` change.** Same treatment as initial mount: `useLayoutEffect` instant-scrolls to bottom and clears `hasUnread`.
- **`forceScrollKey` change.** `useEffect` instant-scrolls to bottom regardless of pin state. Clears `hasUnread`. Skips the very first run (initial mount already handled by the resetKey effect).
- **`jumpToBottom()`.** Smooth-scroll (`scrollTo({ top: scrollHeight, behavior: "smooth" })`). The smooth feel is the right cue for an explicit user action, and a single animation isn't the streaming-jank case.
- **Cleanup.** ResizeObserver and scroll listener torn down on unmount.

### Why this shape

- Two refs (viewport + content) is the canonical pattern for ResizeObserver-driven scroll trackers (xterm, react-virtuoso, react-stick-to-bottom). Single-ref alternatives need MutationObserver + per-child ResizeObservers, which is heavier and misses streaming-text-into-existing-nodes — exactly the case AssistantTextRow hits during token streaming.
- Hook + opt-in button rather than a full container component: matches `editable-field`'s minimalism and lets consumers keep ownership of layout. The button's `null`-when-pinned behavior makes it safe to always render.
- `forceScrollKey` is a generalization of jsonl-viewer's `isWorking`-flip force-scroll. Any consumer can hook it to any signal — "user submitted", "channel changed", "reconnected".

## Files to create

- `plugins/primitives/plugins/auto-scroll/package.json` — copy from `editable-field`, change name.
- `plugins/primitives/plugins/auto-scroll/web/index.ts` — barrel: re-exports + `definePlugin({ id: "auto-scroll", contributions: [] })`.
- `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` — the hook.
- `plugins/primitives/plugins/auto-scroll/web/jump-to-bottom-button.tsx` — the button.

## Files to modify

- `web/src/plugins.ts` — register the new plugin alongside the other primitives (two locations: import + `plugins` array, mirroring how `editable-field` is registered).
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx` — replace the three scroll-related effects (`jsonl-pane.tsx:71-97`) with `useStickyScroll`. Wrap inner content in `contentRef`. Drop `JumpToBottomButton` into the relative-positioned outer wrapper.
- `docs/plugins.md` — regenerate via the `plugins-doc-in-sync` check (the build will fail on it otherwise).

## Migration: jsonl-viewer

Before (jsonl-pane.tsx:71-97):

```tsx
const scrollRef = useRef<HTMLDivElement | null>(null);
const lastCountRef = useRef(0);
useEffect(() => { lastCountRef.current = 0; }, [conversation.id]);
useEffect(() => {
  const el = scrollRef.current;
  if (!el || !events) return;
  const isInitialLoad = lastCountRef.current === 0;
  const pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const grew = events.length > lastCountRef.current;
  lastCountRef.current = events.length;
  if (grew && (isInitialLoad || pinnedToBottom)) {
    el.scrollTop = el.scrollHeight;
  }
}, [events]);
useEffect(() => {
  if (!isWorking) return;
  const el = scrollRef.current;
  if (el) el.scrollTop = el.scrollHeight;
}, [isWorking]);
```

After:

```tsx
const sticky = useStickyScroll({
  resetKey: conversation.id,
  forceScrollKey: isWorking ? 1 : 0,
});

// JSX:
<div className="relative min-h-0 flex-1">
  <div
    ref={sticky.scrollRef}
    className={`h-full overflow-auto transition-opacity ${isGone ? "opacity-50" : ""}`}
  >
    <div ref={sticky.contentRef}>
      {/* events / loading / error / empty branches */}
    </div>
  </div>
  <JumpToBottomButton
    handle={sticky}
    className="absolute bottom-4 right-4"
  />
</div>
```

Behavior parity:
- Initial mount → bottom: handled by `resetKey` initial run.
- Conversation switch → bottom: `resetKey` change.
- Streaming events while pinned → auto-pin: handled by ResizeObserver + isPinned.
- Streaming events while unpinned → no scroll, but `hasUnread` lights up the button.
- Turn sent (`isWorking` flips true) → force scroll: `forceScrollKey` change.

Strict gain over today: the new `JumpToBottomButton` affordance (currently absent — users who scroll up have no easy way back).

## Out of scope

- **Migrating logs** (`plugins/debug/plugins/logs/web/components/log-viewer.tsx`). Logs uses shadcn `<ScrollArea>` (Radix) which has a nested viewport div — `scrollRef` would need to point at the Radix viewport, not the wrapper. Fine to migrate later as a small follow-up; out of scope here to keep the change tight.
- **Migrating terminal**. Terminal delegates entirely to xterm.js, which has its own scrollback. No React-side scroll logic to replace.
- **Unread *count*** (vs the boolean `hasUnread`). Counting requires the primitive to know what an "item" is. Boolean is enough for the button; consumers who want a number can derive it themselves and pass it via `label`.

## Verification

1. **Build the primitive.** `./equin build`. Expect green; `plugins-doc-in-sync` will flag the new plugin until `docs/plugins.md` is updated, which the build does.
2. **Open a conversation with active streaming.** `http://<worktree>.localhost:9000/c/<id>` → status `working`. Confirm:
   - View opens scrolled to bottom (no flash at top).
   - New events stream in and the view stays pinned.
3. **Scroll up while streaming.** Confirm:
   - Auto-scroll stops.
   - "Jump to bottom" button appears at bottom-right.
   - Button shows nothing fancy by default (just chevron); content keeps growing without snapping the view.
4. **Click "Jump to bottom".** Confirm: smooth scroll to the bottom, button disappears, auto-scroll resumes.
5. **Send a turn while scrolled up.** Confirm: view force-scrolls to bottom (the user's just-sent message is visible).
6. **Switch conversations** in the sidebar. Confirm: new conversation opens at bottom, no flash.
7. **Scripted check** with `bun e2e/screenshot.mjs`:
   - `--url http://<worktree>.localhost:9000/c/<id>`
   - First run: capture default state.
   - Inject `window.scrollTo(...)` then capture: button visible.
   - Click button via `--click "Jump to bottom"`: confirm `-after.png` is back at bottom.
8. **No regressions** in the JSONL viewer for static (closed) conversations: no auto-scroll attempts on a non-growing list.
