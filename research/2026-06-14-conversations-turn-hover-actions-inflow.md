# Conversation turn hover actions: stop overlaying the turn below

## Context

In the conversation view (`/agents/c/:id`, the JSONL transcript), every turn —
message turns and tool-call turns alike — shows a small hover toolbar of row
actions (timestamp, raw-json, copy, markdown toggle, fork, investigate, …). It
appears on hover in the **top-right corner** of the turn.

**The bug:** the toolbar is rendered as an absolute overlay. On short turns
(tool calls, single-line system/queue/notification rows) the toolbar is taller
than the turn's content, so it spills past the turn's bottom edge and visually
**covers the top of the next turn below**. Hovering one row hides part of the
adjacent row.

The user's ask: integrate the actions into the turn so they sit *in flow* —
reserving their own space and pushing content rather than floating over it — so
nothing is ever occluded. Reveal on hover, but never shift layout.

## Root cause

`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/event-row.tsx`

```tsx
function HoverActions({ event }) {
  ...
  return (
    <div className="absolute right-1 top-1 z-raised flex items-center gap-xs
                    rounded-lg px-xs py-2xs opacity-0 shadow-sm backdrop-blur-2xl
                    transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
      <JsonlViewer.RowAction.Render>{(item) => <item.component event={event} />}</JsonlViewer.RowAction.Render>
    </div>
  );
}

export function EventRow({ event, index }) {
  return (
    <RowMarkdownProvider>
      <div className="group/row relative" data-event-index={index}>
        <JsonlViewer.EventRenderer.Dispatch event={event} />
        <HoverActions event={event} />
      </div>
    </RowMarkdownProvider>
  );
}
```

`HoverActions` is `absolute`, so it contributes **zero height** to the `relative`
wrapper. When the dispatched content is shorter than the toolbar, the toolbar
overflows the wrapper box and overlaps the next `EventRow` in the column.

## Approach — adopt the repo's in-flow hover-reveal pattern

This codebase already solves "reveal actions on hover without overlaying" in
three places, all with the same shape: a flex row where the actions are a
trailing `shrink-0` element that is **always laid out** (so it reserves space)
and merely `opacity-0 → opacity-100` on hover:

- `plugins/primitives/plugins/row/web/internal/row.tsx` (`ml-auto … opacity-0 group-hover:opacity-100`)
- `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx`
- `plugins/tasks/plugins/attempt-view/web/components/attempt-pane.tsx`

Mirror that here. Turn `EventRow` into a flex row: the dispatched content takes
the remaining width (`flex-1 min-w-0`), and the actions become an in-flow
trailing cell anchored to the top (`self-start`) that reserves its width always
and fades in on hover.

### Change (single file: `event-row.tsx`)

```tsx
export function EventRow({ event, index }: { event: JsonlEvent; index: number }) {
  return (
    <RowMarkdownProvider>
      <div className="group/row flex items-start gap-xs" data-event-index={index}>
        <div className="min-w-0 flex-1">
          <JsonlViewer.EventRenderer.Dispatch event={event} />
        </div>
        <HoverActions event={event} />
      </div>
    </RowMarkdownProvider>
  );
}

function HoverActions({ event }: { event: JsonlEvent }) {
  const actions = JsonlViewer.RowAction.useContributions();
  if (actions.length === 0) return null;
  return (
    // In-flow trailing cell: reserves its width in the row (so the content is
    // pushed left and the row is always tall enough — the toolbar can never
    // spill onto the turn below). Hover/focus only toggles opacity → no reflow.
    <div className="sticky top-1 flex shrink-0 items-center gap-xs rounded-lg px-xs py-2xs
                    opacity-0 shadow-sm backdrop-blur-2xl transition-opacity
                    group-hover/row:opacity-100 focus-within:opacity-100">
      <JsonlViewer.RowAction.Render>
        {(item) => <item.component event={event} />}
      </JsonlViewer.RowAction.Render>
    </div>
  );
}
```

Notes:
- `flex items-start` + `self-start`/`sticky top-1` keeps the toolbar pinned near
  the top of tall (multi-line markdown) turns so it stays reachable while
  scrolling through a long turn, without going `absolute`.
- `sticky top-1` (instead of plain static) means on a very tall turn the toolbar
  trails the viewport top edge of that turn rather than scrolling away — optional;
  if simpler is preferred, drop `sticky top-1` for plain in-flow top alignment.
- Dropping `absolute … right-1` removes `z-raised`; the toolbar no longer needs
  to stack above anything because it occupies real space.
- `group/row`, `opacity-0 → group-hover/row:opacity-100`, `focus-within`,
  `backdrop-blur-2xl`, `shadow-sm`, rounded chrome — all preserved. Behaviour and
  look on hover are unchanged; only the geometry (in-flow vs overlay) changes.

### Tradeoff (intended)

Every turn now reserves a right gutter for the action cell even when idle (the
actions are invisible but laid out). That is exactly the "push elements away when
not hovering, so there's never anything below" behaviour requested. The cell is
icon-sized; the timestamp chip is its widest member, so the reserved gutter is
modest. The content column gets `min-w-0 flex-1` so it shrinks cleanly.

## Out of scope

- No change to the `JsonlViewer.RowAction` slot, its contributors, or the
  timestamp's hover-only design (documented invariant in the jsonl-viewer
  CLAUDE.md — keep it hover-only; we only relocate the container geometry).
- No change to sidebar drag/reorder (the dnd-kit "press space bar" announcement
  comes from the sidebar queue/grouped views, unrelated to this overlay).

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000/agents/c/<id>`.
2. Find a place where a short turn (a tool call / system / queue-operation row)
   is immediately followed by another turn. Hover the short turn.
   - Before: the toolbar covered the top of the row below.
   - After: the toolbar sits within the turn's own row; the row below is fully
     visible; no layout jump on hover (only a fade-in).
3. Check a tall multi-line assistant-text turn: the toolbar stays near the top
   and reveals on hover; content wraps in the narrowed column without clipping.
4. Keyboard: Tab into a row action — `focus-within` reveals the toolbar.

### Critical file
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/event-row.tsx`
