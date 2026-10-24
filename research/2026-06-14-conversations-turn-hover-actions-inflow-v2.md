# Conversation turn hover actions — v2: dock inside each event's header

## Why v2

v1 made `EventRow` a flex row with the actions as a trailing `shrink-0` cell.
Two problems the user flagged:

1. **Misaligned right.** The cell sat at the *outer* row edge, outside each
   card's own `px-md` padding, so it didn't line up with the header's other
   right-side content (file path, running-dots). Actions must sit **inside the
   card header**, aligned with that header's right edge.
2. **Reserves a full-height gutter.** A flex sibling reserves its width for the
   *entire* row height, narrowing the card body all the way down. Actions must
   **only occupy the header line**; the body below must use full width.

Root cause of both: a single generic outer container can't align to, or be
height-scoped to, each renderer's *own* header — because every renderer owns its
padding and layout. So the actions have to be rendered **inside** the event's
header, by the shared header primitives, not by the outer `EventRow` wrapper.

## Design

Render the universal row actions once, inside each event's header row, via React
context.

### New: event context + `RowActions` (in `jsonl-viewer/web`)

- `EventActionContext` — provides the current `JsonlEvent`. `EventRow` wraps each
  row in it.
- `RowActions` component — reads the event from context and renders
  `<JsonlViewer.RowAction.Render>` as an **inline, in-flow** hover-revealed
  cluster (no absolute, no floating pill):
  `className = "flex shrink-0 items-center gap-xs opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100"`.
  Returns `null` when there is no event in context or no actions. Exported from
  the jsonl-viewer web barrel so child renderer plugins can place it.

Because it is in-flow inside the header's flex row, it: reserves space only on
that line (body full width below), aligns with the header's right edge, pushes
the header label left, and can never spill onto the next turn. Hover/focus only
toggles opacity → no reflow.

### `EventRow` (`.../web/components/event-row.tsx`)

Stop rendering the overlay. Just provide context + the hover group:

```tsx
export function EventRow({ event, index }: { event: JsonlEvent; index: number }) {
  return (
    <EventActionProvider event={event}>
      <RowMarkdownProvider>
        <div className="group/row" data-event-index={index}>
          <JsonlViewer.EventRenderer.Dispatch event={event} />
        </div>
      </RowMarkdownProvider>
    </EventActionProvider>
  );
}
```

### `CollapsibleCard` (`.../plugins/collapsible-card/web/components/collapsible-card.tsx`)

Render `RowActions` in the header's far-right cluster. The header has a full-bleed
toggle overlay, so interactive content must be wrapped in `CardHeaderAction`
(`pointer-events-auto relative`). Place it after `trailing`; give it `ml-auto`
only when there is no `trailing` (otherwise `trailing` already owns the `ml-auto`
and `RowActions` sits to its right within the `gap-sm` row):

```tsx
{trailing && (
  <CardHeaderAction className="ml-auto shrink-0">{trailing}</CardHeaderAction>
)}
<CardHeaderAction className={cn("shrink-0", !trailing && "ml-auto")}>
  <RowActions />
</CardHeaderAction>
```

This is "inside the card header, aligned right, only that row" — exactly the ask.

### `EventLine` (`.../web/components/event-line.tsx`)

Lifecycle one-liners (system, queue-operation, …). Append `RowActions` with
`ml-auto` at the end of the line (no toggle overlay here, so no
`CardHeaderAction`):

```tsx
<RowActions className="ml-auto" />
```

`RowActions` should accept an optional `className` merged onto its root.

### Plain text renderers (no shared header): keep actions, don't regress

`assistant-text`, `user-text`, `user-image` render a full-width text/image block
with no header row. They still need their actions (timestamp, raw-json, copy,
markdown-toggle). Give each a header-aligned inline actions row at the top-right
of its padded box. Simplest consistent placement: make the renderer's padded
root `relative` and render the actions top-right *inside* the padding so they
align with the text block and reveal on hover:

- Wrap with a `relative` root (these already have a `px-md py-sm` box).
- Render `<RowActions className="absolute right-md top-sm z-raised" />` inside
  that box. These blocks are normally multi-line (tall), so an absolute,
  in-padding cluster aligns with the content and does not spill; on the rare
  one-line case it stays within the `py-sm` box. (If we want zero risk of
  one-line spill, give the text box `min-h` equal to the actions height — note as
  optional.)

Keep the floating-pill chrome **only** for this absolute text-row case so the
buttons stay legible over prose: pass a `floating` prop to `RowActions` that adds
`rounded-lg px-xs py-2xs shadow-sm backdrop-blur-2xl bg-background/70`. Header
(card/line) usages use the plain inline variant (no pill).

> Note: the timestamp stays hover-only and must not be duplicated (jsonl-viewer
> rule). We are only relocating the single shared actions container; the
> `JsonlViewer.RowAction` slot, its contributors, and the timestamp invariant are
> unchanged.

## Files

- `.../jsonl-viewer/web/internal/event-action-context.tsx` (new) — context + provider + `RowActions`.
- `.../jsonl-viewer/web/index.ts` — export `RowActions` (+ provider if needed).
- `.../jsonl-viewer/web/components/event-row.tsx` — provide context, drop overlay.
- `.../jsonl-viewer/web/components/event-line.tsx` — render `RowActions` (`ml-auto`).
- `.../jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx` — render `RowActions` in header cluster.
- `.../jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx` — relative root + floating `RowActions`.
- `.../jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx` — same.
- `.../jsonl-viewer/plugins/user-image/web/components/*.tsx` — same.

## Boundary / cycle check

`collapsible-card`, `assistant-text`, `user-text`, `user-image` are child plugins
of `jsonl-viewer`; they already import the `jsonl-viewer` web barrel
(`JsonlViewer`, `useRowMarkdown`, etc.). Adding `RowActions` to that barrel and
importing it is the same legal child→parent barrel edge — no new cycle (the
parent does not import these children).

## Verification

1. `./equin build`; open a conversation transcript.
2. Hover a tool-call card: actions appear **in the header row**, right-aligned
   with (next to) the file path / running-dots, and the collapsible body below is
   full width. Nothing below the card is covered.
3. Hover a short tool-call / system line: actions sit on that line only; the next
   turn is fully visible; no layout jump (opacity only).
4. Assistant text / user text: actions reveal top-right within the block; copy /
   markdown-toggle / timestamp all present (no regression).
5. Keyboard: Tab into an action → `focus-within` reveals it.
