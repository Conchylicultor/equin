# Compact drag overlay for fill/tall reorder items

## Context

In reorder edit mode, dragging a whole sidebar section (e.g. the **Conversations**
section) renders a drag overlay that re-renders the section's *full live content*
as a tall floating panel. It tracks the cursor correctly (overlay is portaled to
`<body>`), but a tall live panel is poor UX for what is conceptually a
"pick up this section and move it" gesture — a compact handle (just the section's
label) reads far better.

The overlay content is decided in exactly one place — `renderOverlay` in the
reorder list middleware — which currently wraps `renderItem(entry)` (the full
contribution) in overlay chrome.

**Rebase note:** This branch was rebased onto `origin/main`, which already landed
the structural cleanup of "fill" items: the old magic CSS string
`reorderWrapperClassName: "flex flex-col flex-1 min-h-0"` was replaced by a
first-class **`reorderFill?: boolean`** field on render-slot contributions
(`render-slot.tsx`), mapped by the item middleware to `SortableReorderItem`'s
`fill` prop. `reorderFill` semantically means *"this contribution fills its host
height and scrolls internally"* — which is **exactly** the set of items whose
full-render overlay is a tall panel. So we gate the compact overlay on the
existing `reorderFill` flag; no new API is introduced.

**Decision (confirmed with user):** the compact overlay shows the **label only**
(no icon), sourced from the human label the slot already exposes via `docLabel`
(`entry._doc.label` → `"Conversations"`), falling back to the contribution id.
This keeps the reorder primitive fully generic — it never reads app-shell's
domain `title`/`icon` props — and works automatically for any future
`reorderFill` item with zero per-contribution code.

## Approach

Single change point. In `renderOverlay`, branch on `reorderFill`: render a
compact label chip for fill items, keep the full-contribution render for
everything else (zero behavior change for normal small items, which look correct
as their real selves in the overlay).

### File to modify

`plugins/reorder/web/internal/dnd-list-middleware.tsx` — `renderOverlay`
(currently lines 601-614):

Current:
```tsx
const renderOverlay = useCallback(
  (activeId: string) => {
    const entry = entriesRef.current.find(
      (x) => !isNodeData(x) && entryKey(x) === activeId,
    );
    if (!entry || isNodeData(entry)) return null;
    return (
      <div className="rounded-md border border-border bg-background/90 shadow-lg">
        {renderItem(entry)}
      </div>
    );
  },
  [renderItem],
);
```

New:
```tsx
const renderOverlay = useCallback(
  (activeId: string) => {
    const entry = entriesRef.current.find(
      (x) => !isNodeData(x) && entryKey(x) === activeId,
    );
    if (!entry || isNodeData(entry)) return null;

    // Fill contributions render a height-filling, internally-scrolling body
    // (e.g. the Conversations sidebar section). Re-rendering that live as the
    // drag overlay produces a tall floating panel — wrong for a "pick up this
    // section" gesture. Show a compact label chip instead, using the human
    // label the slot already exposes via `docLabel` (id fallback). Gated on the
    // same first-class `reorderFill` flag that bounds the edit-mode wrapper, so
    // the primitive stays generic (never reads app-shell's title/icon).
    if ((entry as Record<string, unknown>).reorderFill) {
      const label = entry._doc?.label ?? contributionLabel(entry);
      return (
        <div className="cursor-grabbing rounded-md border border-primary/50 bg-background/95 px-sm py-2xs shadow-lg ring-1 ring-primary/50">
          <Badge variant="primary" size="md">{label}</Badge>
        </div>
      );
    }

    return (
      <div className="rounded-md border border-border bg-background/90 shadow-lg">
        {renderItem(entry)}
      </div>
    );
  },
  [renderItem],
);
```

### Imports

- `Badge` from `@plugins/primitives/plugins/badge/web` — add to the import block.
  (`Badge` is the canonical chip primitive; `BadgeProps` supports `variant`/`size`
  and a single-line truncating label leaf, so a long label ellipsizes cleanly.)
- `contributionLabel` from `./sorting` — **already imported** (line 38).
- `entry._doc?.label` — `_doc?: DocMeta { label?: string }` is part of the
  framework `Contribution` type (`web-sdk/core/types.ts`), stamped at
  contribution-creation time from the slot's `docLabel`. `Shell.Sidebar` declares
  `docLabel: (p) => p.title` (`shell/web/slots.ts`), so for the Conversations
  section `entry._doc.label === "Conversations"`. No new plumbing.

### Why this is the clean design

- **Reuses the existing first-class signal.** `reorderFill` already partitions
  "tall, scroll-internally" items from normal rows for the bounded-wrapper logic;
  the overlay decision is the same partition. No second mechanism, no CSS-string
  sniffing.
- **Stays generic.** The reorder primitive must not import app-shell or read
  `title`/`icon` (it's load-bearing infra consumed everywhere). `_doc.label` is
  the framework-level human label, so the overlay is domain-agnostic.
- **Zero per-contribution code.** Conversations needs **no** change; any future
  `reorderFill` contribution gets the compact overlay for free.

### Notes / non-goals

- The label-only choice intentionally omits the section icon (e.g. `MdForum`).
  The icon is an app-shell domain prop the generic reorder layer can't read
  without coupling. If a richer icon+label handle is wanted later, the clean
  extension is an optional `reorderOverlay?: ReactNode` field on render-slot
  contributions (overlay renders it; falls back to this label chip) — out of
  scope here.
- No changes to the editor (`plugins/reorder/plugins/editor`) or `sortable-list`:
  the overlay content is supplied entirely by the middleware's `renderOverlay`
  callback; the editor passes it through to `<SortableList overlay=…>`.
- Only one `reorderFill` contribution exists today (Conversations sidebar), so
  this is the sole item whose overlay changes.

## Verification

1. `./equin build` (from the worktree dir) — must succeed; `type-check`
   should pass (new `Badge` import, `_doc` access is typed).
2. Manual, scripted Playwright run against
   `http://<worktree>.localhost:9000/c/<id>` (a conversation surface that shows
   the sidebar with the Conversations section):
   - Enter reorder edit mode (the pen button on the top toolbar — or
     `setEditMode(true)` programmatically).
   - Start dragging the **Conversations** section.
   - **Expected:** the drag overlay is a small label chip reading
     "Conversations" (ring + shadow), *not* a tall panel re-rendering the
     conversation list. The chip tracks the cursor.
   - Use `e2e/screenshot.mjs` (or a copy) to capture a mid-drag frame; compare
     against the pre-change tall-panel overlay.
3. Sanity: drag a *normal* (non-fill) reorderable item (e.g. a toolbar action in
   any horizontal `*.Item` slot) and confirm its overlay still renders the full
   contribution as before (no regression for non-fill items).

## Key files

- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — the only edit
  (`renderOverlay`, ~lines 601-614, plus a `Badge` import).
- `plugins/reorder/web/internal/sorting.ts` — `contributionLabel` (reused; already
  imported).
- `plugins/conversations/plugins/conversations-view/web/index.ts` — the lone
  `reorderFill: true` contribution that exercises the new path (no change).
- `plugins/primitives/plugins/badge/web` — `Badge` chip primitive.
