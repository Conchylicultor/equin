# CollapsibleWrap — wrap-and-clamp chip rows with a reveal toggle

## Context

Horizontal "chip" rows (slot contributions) currently **hard-clip** when they overflow.
The motivating case is the conversation header (`conversation.header` slot): the title,
model badge, status, progress dots, category, preprompt and allow-monitor chips are
clipped mid-glyph by `PaneChrome`'s fixed-height band when the pane is narrow.

We want chips to **wrap** to multiple lines, but keep the row clamped to **1 row** by
default, with a chevron (`v`) toggle revealing the rest. The row must stay
**reorderable** (the app has a global edit-mode drag-reorder that applies to every slot).

This is a different mechanism from the existing `ResponsiveOverflow` primitive, which
*drops* (unmounts) overflowing children. `CollapsibleWrap` *clips* via CSS — children
stay mounted — which is exactly what lets it compose with reorder (a clipped chip is
still a mounted, valid drag target).

### Key design facts (verified against source)

- **Reorder is zero-DOM.** `SortableList` = `<DndContext><SortableContext>{children}</SortableContext></DndContext>`
  (`plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx`) — pure
  context providers, no wrapper element. The list middleware is registered globally for
  every slot. View-mode reorder item wrappers are `display:contents`; edit-mode wrappers
  are ring boxes. So chips are direct flex children of the host, and `flex-wrap` on the
  host wraps them. **Invariant: the slot must be rendered exactly once** — two
  `.Render` calls = two `SortableContext`s = broken drag. `CollapsibleWrap` wraps the
  single `.Render` element and never duplicates it.
- **Edit-mode signal**: `import { useEditMode } from "@plugins/reorder/web"` — global
  module-level boolean via `useSyncExternalStore`. Precedent: `SpacerReorderItem`
  (`plugins/reorder/web/internal/dnd-components.tsx`) calls it directly to change its own
  structure. `CollapsibleWrap` force-expands while editing: `expanded = userExpanded || editMode`.
- **slot-render `.Render`** (`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`)
  wraps each contribution in a `flex min-w-0 items-center` cell **when its parent is a
  flex row** (sentinel reads parent `flex-direction`). `CollapsibleWrap`'s inner box is
  `flex flex-wrap` (still `flex-direction: row`) so cell-wrapping keeps working.
- **The hard constraint**: `HeaderView` renders inside `PaneChrome`'s title area, whose
  band is `flex h-10 min-w-0 items-center gap-2 overflow-hidden border-b px-2`
  (`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx:57`) — fixed 40px,
  clips. **Decision (user-approved): the expanded rows float as an overlay** that escapes
  the clip; `PaneChrome` stays unchanged (its single-line header contract is preserved).

## Approach

A new primitive **`CollapsibleWrap`** (new sibling plugin, sibling to `responsive-overflow`):

- Collapsed (default, `rows=1`): one `flex flex-wrap` container, clamped to one row via a
  computed `max-height` + `overflow:hidden`, rendered in flow.
- Overflow detection: `ResizeObserver` on the wrap box (push-based, no timers); compares
  `scrollHeight` against the clamp height to gate the chevron's visibility.
- Chevron: an `IconButton` (`MdExpandMore`/`MdExpandLess`) rendered as a `shrink-0
  self-start` sibling **outside** the clamped box, pinned to the first row. Hidden in edit
  mode (everything is force-expanded for DnD, so a toggle would be a no-op).
- Expanded: the **same** wrap container is `createPortal`-ed to `document.body` and
  positioned `fixed` at the in-flow anchor's `getBoundingClientRect()` (re-measured via
  `ResizeObserver` on the anchor), with `bg-popover border rounded-md shadow-md z-50 p-1.5`.
  `createPortal` moves the DOM without remounting the React subtree, so
  `DndContext`/`SortableContext` (which follow the React tree, not the DOM tree) stay
  intact → reorder still works. `fixed` is correct here because the header band does not
  scroll.

### Why overlay + portal (not "grow the band")

`PaneChrome` is load-bearing and shared; its single-line header height is a real
cross-pane contract. Floating the overflow into a transient surface localizes all
complexity to the new primitive and leaves shared chrome untouched. The cost — a portal
to escape the `overflow-hidden` clip — is contained and verifiable.

## Files

### New — `plugins/primitives/plugins/collapsible-wrap/`

- **`package.json`**
  ```json
  {
    "name": "@singularity/plugin-primitives-collapsible-wrap",
    "description": "Wraps overflowing children to multiple lines, clamped to N rows with a chevron toggle to reveal the rest.",
    "private": true,
    "version": "0.0.1"
  }
  ```
- **`web/index.ts`** (barrel — purity rules: imports, own-file re-exports, single default)
  ```ts
  import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
  export { CollapsibleWrap } from "./internal/collapsible-wrap";
  export type { CollapsibleWrapProps } from "./internal/collapsible-wrap";
  export default {
    name: "Collapsible Wrap",
    description:
      "Wraps overflowing children to multiple lines, clamped to N rows by default with a chevron toggle to reveal the rest. Force-expands while reorder edit mode is active.",
    contributions: [],
  } satisfies PluginDefinition;
  ```
- **`web/internal/collapsible-wrap.tsx`** — the implementation. Responsibilities:
  1. `flex flex-wrap content-start` container, `gap` prop.
  2. Clamp to `rows` via computed `maxHeight` (first-child row height × `rows` +
     `gap` × (`rows`-1)) + `overflow:hidden` while collapsed; removed while expanded.
  3. `ResizeObserver` (deferred via `requestAnimationFrame`, mirroring
     `responsive-overflow`) recomputes clamp height + `overflowing` flag.
  4. `const editMode = useEditMode(); const expanded = userExpanded || editMode;`
  5. When expanded, `createPortal` the wrap box to `document.body`, positioned `fixed`
     at the anchor rect. A zero-size in-flow `anchorRef` span marks the position.
  6. Chevron `IconButton`, `shrink-0 self-start`, hidden when `editMode`.

  API:
  ```ts
  export interface CollapsibleWrapProps {
    children: ReactNode;   // the single <Slot.Render> element — never indexed/duplicated
    rows?: number;         // visible rows when collapsed; default 1
    gap?: number;          // px between chips; default 4 (gap-1)
    className?: string;
  }
  ```
  `children` is `ReactNode` (not `ReactNode[]`): `CollapsibleWrap` must wrap the one
  `.Render` element so only one `SortableContext` exists.

  Imports: `useEditMode` from `@plugins/reorder/web`; `IconButton` from
  `@plugins/primitives/plugins/icon-button/web`; `MdExpandMore`/`MdExpandLess` from
  `react-icons/md`; `cn` from `@/lib/utils`; `createPortal` from `react-dom`.

- **`CLAUDE.md`** — prose only (clip-not-drop mechanism; the single-subtree-portal
  invariant for reorder; force-expand on edit mode; host contract: host must be a flex
  row so `.Render` cell-wrapping applies, and chips that must not shrink should be
  `shrink-0` so they wrap instead of truncating — §"Wrinkle" below). **Do not** write the
  `AUTOGENERATED` block; `./equin build` appends it.

### Edit — `plugins/conversations/plugins/conversation-view/plugins/header/web/components/header-view.tsx`

```tsx
import { CollapsibleWrap } from "@plugins/primitives/plugins/collapsible-wrap/web";
import { Conversation } from "../slots";

export function HeaderView() {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-1.5">
      <CollapsibleWrap rows={1} gap={6}>
        <Conversation.Header.Render>
          {(item) => <item.component />}
        </Conversation.Header.Render>
      </CollapsibleWrap>
    </span>
  );
}
```
`items-center` → `items-start` so the chevron aligns to row 1. `gap={6}` matches the
existing `gap-1.5`. The `.Render` sentinel still sees a flex-row parent (`CollapsibleWrap`'s
inner `flex flex-wrap` box), so cell-wrapping is unchanged.

### No registry edit

There is no `web/src/plugins.ts` for primitives — registration is filesystem-driven
codegen. `./equin build` regenerates `web.generated.ts` (adds the `collapsible-wrap`
entry + the header plugin's `dependsOn`) and is enforced by `plugins-registry-in-sync`.

### PaneChrome — unchanged

The overlay escapes the clip via portal; no `PaneChrome` change in the chosen path.

## The `min-w-0` cell wrinkle

`.Render` wraps each chip in `flex min-w-0 items-center`. Under `flex-wrap`, a `min-w-0`
cell lets the last chip on a line *shrink* instead of wrapping — but only for chips whose
content is shrinkable. Header chips: the title is shrinkable (`TruncatingText`); the rest
(model, status, progress dots, category, preprompt, allow-monitor) are `Badge`/`Button`
and effectively `shrink-0`. So only the title shrinks on its line; badges wrap cleanly —
acceptable/desirable. If a specific badge squishes, the local fix is `shrink-0` on that
contribution's root (per the slot-render opt-out contract), **not** a change to
`CollapsibleWrap`. Documented in the new CLAUDE.md as the host contract.

## Risks

1. **Portal + reorder collision detection (primary).** Relies on `createPortal`
   preserving React context through the DOM move (standard React behavior; dnd-kit
   supports portaled sortables, and collision math uses live DOM rects which a `fixed`
   overlay still provides). **Verify drag-reorder inside the overlay early** (step 3
   below). Fallback if it misbehaves: in edit mode only, force-expand inline and relax the
   one title cell's `overflow-hidden` — but that couples to PaneChrome, so validate the
   portal path first.
2. **Overlay positioning model.** `fixed` keyed to the anchor rect is correct only while
   the band doesn't scroll/move — fine for the conversation header. Flag before reusing
   `CollapsibleWrap` in scrolling hosts.
3. **Clamp-height measurement** uses the first child's height (header chips are uniform
   control-height). If mixed heights appear, measure the tallest first-row child.

## Verification

1. `./equin build` — barrel purity, `plugins-registry-in-sync`, lint
   (`no-adhoc-control`, boundaries), CLAUDE.md autogen append.
2. Open a conversation with many header chips in a **narrow** pane (overflowing):
   - Playwright screenshot: collapsed = one row + `v` chevron.
   - Click chevron → overlay panel drops below the band, chips wrap across rows, bg/border/
     shadow, overlaying content below (confirms it escaped `h-10 overflow-hidden`).
   - Click again → collapses.
3. **Edit-mode force-expand:** click the reorder pen button → chips force-expand (overlay
   shown, chevron hidden), each chip is a ring-boxed drag target; **drag to reorder** and
   confirm it persists (validates single `SortableContext` survived the portal). Exit →
   back to collapsed.
4. Wide pane (no overflow) → no chevron, plain single row (overflow detection gates the
   affordance).
5. No `ResizeObserver` loop warnings in console.

## Critical files

- `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx` (new)
- `plugins/primitives/plugins/collapsible-wrap/web/index.ts` (new)
- `plugins/primitives/plugins/collapsible-wrap/package.json` (new)
- `plugins/primitives/plugins/collapsible-wrap/CLAUDE.md` (new, prose only)
- `plugins/conversations/plugins/conversation-view/plugins/header/web/components/header-view.tsx` (edit)
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` (reference; unchanged)
- `plugins/reorder/web/internal/dnd-components.tsx` (reference; `useEditMode` precedent)
