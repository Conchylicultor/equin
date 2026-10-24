# CollapsibleWrap v2 — layout-generic reorder via injectable `ReorderLayout`

> Supersedes the edit-mode portion of `2026-06-08-global-collapsible-wrap-chip-row.md`.
> The v1 primitive shipped and works in view mode; this v2 fixes edit-mode behavior
> at the abstraction level.
>
> **⚠️ Superseded in part by the v3 update at the bottom of this file.** v2's
> `WrapSpacer` (line-break spacer) and the `fixed`-portal overlay were both wrong;
> see "## v3 update" below for the shipped approach (flex-1 spacer + in-flow spill).

---

## Context

`CollapsibleWrap` (v1, shipped) wraps a single slot `.Render` to multiple lines,
clamped to 1 row with a chevron, and force-expands during global reorder edit mode.
Two edit-mode bugs surfaced:

1. In edit mode the chips take multiple cramped rows instead of the full width.
2. Reorder **spacers don't work**.

**Both are one root cause:** `CollapsibleWrap` imposes a 2-D `flex-wrap` layout, but
the `reorder` primitive's edit mode is hardcoded 1-D (single axis). `reorder` is
*already* mostly layout-agnostic — `SortableList` is zero-DOM, so the **host** owns the
flex container. Only three things in reorder assume a single axis:

- **Sorting strategy** — `horizontalListSortingStrategy`/`verticalListSortingStrategy`,
  chosen by auto-detecting parent `flex-direction` via a sentinel
  (`dnd-list-middleware.tsx:98-109`). dnd-kit's `rectSortingStrategy` is the general 2-D one.
- **Spacer rendering** — `SpacerReorderItem` hardcoded `flex-1` (`dnd-components.tsx:151-195`).
- **Collision detection** — module-level `reorderCollisionDetection` (already generic enough).

So we don't rewrite reorder to be 2-D — we **extract those three decisions into an
injectable `ReorderLayout`**, defaulting to today's behavior, and let a layout owner
(`CollapsibleWrap`) inject a wrap layout via React context. Inversion of control:
reorder never learns what "wrap" is.

## Approach — three backward-compatible layers

### Layer 1 — `sortable-list`: explicit `strategy` + vendor re-export

`plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx`
- Add `strategy?: SortingStrategy` to `SortableListProps`. Resolve precedence: explicit
  `strategy` wins, else fall back to today's `orientation` mapping.
  ```ts
  const resolvedStrategy =
    strategy ??
    (orientation === "horizontal"
      ? horizontalListSortingStrategy
      : verticalListSortingStrategy);
  // <SortableContext items={effectiveItems} strategy={resolvedStrategy}>
  ```
  No current caller passes `strategy` (verified), so this is byte-for-byte today's
  behavior for all existing consumers.

`plugins/primitives/plugins/sortable-list/web/index.ts` — re-export the dnd-kit
primitives through the primitive barrel so reorder/collapsible-wrap never import
`@dnd-kit/sortable` directly (the barrel's stated job is "wraps @dnd-kit/sortable"):
```ts
export { rectSortingStrategy } from "@dnd-kit/sortable";
export type { SortingStrategy } from "@dnd-kit/sortable";
```
If the barrel-purity lint rejects a vendor re-export, fall back to a one-line
`web/internal/strategies.ts` re-exported by the barrel.

### Layer 2 — `reorder`: `ReorderLayout` + context, middleware reads injected layout

New `plugins/reorder/web/internal/reorder-layout.tsx`:
```ts
import { createContext, type ReactNode } from "react";
import type { CollisionDetection } from "@dnd-kit/core";
import type { SortingStrategy } from "@plugins/primitives/plugins/sortable-list/web";

export interface SpacerProps { itemKey: string; storageId: string }

export interface ReorderLayout {
  strategy: SortingStrategy;                     // dnd-kit
  renderSpacer?: (p: SpacerProps) => ReactNode;  // default = flex-1 SpacerReorderItem
  collisionDetection?: CollisionDetection;       // default = reorderCollisionDetection
}

export const ReorderLayoutContext = createContext<ReorderLayout | null>(null);
```
(`CollisionDetection` from `@dnd-kit/core` is already a direct import in the middleware,
so no new vendor edge there. `SortingStrategy` routes through the sortable-list barrel.)

Refactor `plugins/reorder/web/internal/dnd-list-middleware.tsx` (`ReorderListMiddlewareInner`):
```ts
const injected = useContext(ReorderLayoutContext);   // orientation sentinel stays as default source
// <SortableList ...
//   collisionDetection={injected?.collisionDetection ?? reorderCollisionDetection}
//   orientation={orientation}
//   strategy={injected?.strategy}                    // undefined ⇒ SortableList maps orientation
// >
const renderSpacer = (p: SpacerProps) =>
  injected?.renderSpacer
    ? injected.renderSpacer(p)
    : <SpacerReorderItem itemKey={p.itemKey} storageId={p.storageId} />;
// replace both <SpacerReorderItem .../> sites (lines ~531-536, ~545-549) with renderSpacer({...})
```
**Decision (A):** keep `SortableList` the single owner of the orientation→strategy
mapping; reorder passes `strategy` only when injected. `SpacerReorderItem`'s existing
`{ itemKey, storageId }` signature already matches `SpacerProps` — it becomes the default
`renderSpacer` with no change to itself.

Export from `plugins/reorder/web/index.ts` (own-file re-exports; barrel already hosts the
`useEditMode` re-exports + plugin default):
```ts
export { ReorderLayoutContext } from "./internal/reorder-layout";
export type { ReorderLayout, SpacerProps } from "./internal/reorder-layout";
```
No `ReorderLayoutProvider` wrapper — consumers use `<ReorderLayoutContext.Provider>`
directly (mirrors internal `ReorderAreaContext` usage; keeps a component out of the barrel).

### Layer 3 — `collapsible-wrap`: inject wrap layout, fix the overlay width

`plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx`
```ts
import { useEditMode, ReorderLayoutContext, type ReorderLayout } from "@plugins/reorder/web";
import { rectSortingStrategy } from "@plugins/primitives/plugins/sortable-list/web";
```
1. Build a stable wrap layout and provide it **around `{children}` inside `wrapBox`** so it
   is a React ancestor of the single `.Render` in BOTH the in-flow and portaled branches
   (context follows the React tree, so it reaches the reorder middleware through the
   portal — same invariant the single `SortableContext` already relies on):
   ```tsx
   const wrapLayout = useMemo<ReorderLayout>(() => ({
     strategy: rectSortingStrategy,
     renderSpacer: ({ itemKey, storageId }) => (
       <WrapSpacer itemKey={itemKey} storageId={storageId} />   // basis-full line break
     ),
   }), []);
   // inside wrapBox:
   <ReorderLayoutContext.Provider value={wrapLayout}>{children}</ReorderLayoutContext.Provider>
   ```
2. **New `WrapSpacer`** (`collapsible-wrap/web/internal/wrap-spacer.tsx`): the wrap-native
   spacer. In edit mode a draggable `SortableItem` styled `basis-full h-0` (zero-height,
   full flex-basis → forces subsequent chips to the next row; still a valid drag
   target so it can be moved/deleted); in view mode `null`. This is what makes "bug 2"
   (spacers) actually work in 2-D, exercising the new `renderSpacer` delegation.
3. **Fix the overlay width (the actual bug-1 fix).** Keep the `fixed` portaled overlay —
   it must still escape PaneChrome's `h-10 overflow-hidden` band — but **stop freezing it
   to the narrow collapsed title-span width**. Replace the frozen-rect machinery with a
   single `ResizeObserver` that measures the **header band** (the wrap's positioned
   ancestor / nearest `offsetParent` that tracks the pane width) and sizes the overlay to
   that full width. With `rectSortingStrategy` now making cross-row drag work, multi-row
   in the overlay is correct, and full width removes the "cramped" symptom. Remove:
   `OverlayRect`-freeze logic, the anchor-placeholder `minWidth` gymnastics, and the
   capture-on-expand rect — collapse to one observer on one element. No polling.
4. **Fold in the v1 first-row-shift fix** (same file, lines ~49-64): change
   `firstRowHeight` → uniform row height = `max(offsetHeight)` over **all** effective
   children (drop the row-1 `offsetTop` filter), so the clamp no longer shrinks when a
   taller chip wraps to row 2. Removes the dominant few-px vertical shift at the
   collapse boundary. (Deeper per-line pinning would reach into slot-render cells — defer
   unless QA still sees sub-pixel movement.)

Update `collapsible-wrap/CLAUDE.md`: force-expand now injects a `ReorderLayout`
(rect strategy + `WrapSpacer`); overlay is full-band-width, not frozen-narrow.

## Backward-compatibility (the central safety property)

Every existing reorderable slot has **no `ReorderLayoutContext.Provider`** in its ancestry
(only `CollapsibleWrap` provides one, only on the conversation header). So
`useContext(...)` is `null` everywhere else → `strategy=undefined` (orientation mapping),
`collisionDetection=reorderCollisionDetection`, `renderSpacer=<SpacerReorderItem>` — today's
behavior, byte-for-byte. `SortableList`'s new `strategy` prop defaults to `undefined` for
its other 3 callers. Confirm before finalizing the diff:
- `rg -n "ReorderLayoutContext" plugins` → only collapsible-wrap + reorder.
- `rg -n "SortableList\b" plugins | rg -v internal` → 4 callers; none pass `strategy`.
- `rg -n "SpacerReorderItem" plugins` → only reorder internal.

## DAG / boundaries

- `collapsible-wrap → reorder` (already exists), `reorder → sortable-list` (already exists),
  `collapsible-wrap → sortable-list` (**new**, for `rectSortingStrategy`; sortable-list is a
  leaf primitive → no cycle). `reorder → collapsible-wrap` confirmed absent.
- Barrels stay pure (own-file + vendor re-exports + single default); new context/component
  live in `web/internal/`; no new default-export imports.

## Verification

1. `./equin build` — typecheck, barrel-purity lint (accepts the vendor re-export and
   `strategy` prop), plugin-boundary checker (no cycle).
2. **Regression (critical):** a DIFFERENT existing reorderable slot (e.g. a sidebar list)
   in edit mode still drags + persists identically — proves the null-context default path.
3. **Header 2-D drag:** drag a chip from row 1 → row 2 and back; rank PATCH fires, order
   persists across reload (`rectSortingStrategy` works through the portal).
4. **Spacers:** add a spacer → chips after it move to the next line; spacer is draggable +
   deletable (`WrapSpacer`/`basis-full`).
5. **View mode unaffected:** collapse → 1 row + chevron; expand → all rows; collapse back.
6. **First row stable:** first chip's text top offset is stable (≤1px) as a taller chip
   wraps to row 2.
7. **Manual:** edit-mode overlay spans full band width (not the narrow title span).

## Risks & open decisions

1. **Wrap spacer semantics (product call):** plan uses `basis-full` line-break so spacers
   actually work in 2-D (recommended — directly fixes "bug 2"). Alternative: omit spacers
   (`renderSpacer: () => null`) and hide the "Add Spacer" control for wrap — lower effort
   but a dead feature. **Confirm.**
2. **Groups in wrap:** the reorder `groups` sub-plugin (`ReorderGroupBox`) wasn't part of
   this layout extraction. Group boxes may need their own wrap treatment. Out of scope for
   v2 — verify whether grouping is even reachable/needed on the header; flag as follow-up.
3. **Edit-mode overlay vs growable band:** plan keeps the full-width `fixed` overlay
   (contained, no PaneChrome change). Alternative: teach PaneChrome to drop `overflow-hidden`
   and grow the title row in edit mode — larger cross-plugin change, not recommended for a
   primitive-level v2.
4. **First-row fix depth:** global-max clamp removes the dominant shift; deeper per-line
   pinning (reaching into slot-render cells) deferred unless QA needs it.

## Critical files

- `plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx` (edit — `strategy` prop)
- `plugins/primitives/plugins/sortable-list/web/index.ts` (edit — vendor re-export)
- `plugins/reorder/web/internal/reorder-layout.tsx` (new — interface + context)
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` (edit — read injected layout)
- `plugins/reorder/web/index.ts` (edit — export new symbols)
- `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx` (edit — inject layout, fix overlay width, uniform row height)
- `plugins/primitives/plugins/collapsible-wrap/web/internal/wrap-spacer.tsx` (new — basis-full spacer)
- `plugins/primitives/plugins/collapsible-wrap/CLAUDE.md` (edit — document)

---

## v3 update — flex-1 spacer + in-flow spill (shipped)

Two bugs survived v2; both were abstraction-level mistakes in v2 itself.

### Bug A — spacers became line breaks

v2 replaced the 1-D `flex-1` `SpacerReorderItem` with `WrapSpacer` (`basis-full h-0`)
on the reasoning that "`flex-1` is meaningless under wrap." **That reasoning is wrong.**
Under `flex-wrap`, `flex: 1 1 0` grows to fill the remaining space *on its line*, pushing
following chips toward the right edge; when the line is full they wrap to the next row —
which is *exactly* the desired "push right while there's space, then collapse." So the fix
is a revert: drop `WrapSpacer`/`renderSpacer`, keep the default `flex-1` spacer. The
`ReorderLayout` injection is trimmed to just `{ strategy }` (still needed:
`rectSortingStrategy` for correct 2-D cross-row dragging once chips spill onto multiple rows).

### Bug B — row 1 shifts when collapsing/expanding

Root cause was **the `fixed`-portal overlay** itself: collapsed rendered the box in flow
(centered in the band); expanded yanked the whole box into a `document.body` portal at
`band.top + p-1.5`. Same chips, two different origins → row 1 jumps. The portal approach
*structurally cannot* satisfy "displayed elements never move." (A secondary, static cause:
`items-start` on the header host span pinned row 1 to the band top instead of centered.)

**Fix — in-flow spill, no portal (chosen direction B):**

- The wrap box stays in **normal flow** in both states. Its **layout height is always the
  one-row clamp** (`max-height`); only `overflow` flips (`hidden` collapsed → `visible`
  expanded). Identical layout height ⇒ the band's `items-center` centers exactly one row the
  same way in both states ⇒ row 1 is pixel-stable *by construction*, not by pixel-chasing.
- Expanded, rows 2+ spill **down** over the content below. To escape the band's
  `overflow-hidden`, `PaneChrome` gains an opt-in **`headerSpill`** prop that switches the
  band to `overflow-visible`. This is the honest home for "a header that can reveal overflow"
  — the chrome owns the band, so the chrome grants the spill. (v1/v2 avoided touching
  load-bearing `PaneChrome`; that avoidance is precisely what forced the portal hacks.)
- A `max-height`-clamped box's own background can't paint overflowing content, so a measured
  absolute **backdrop** (sized to the box's full `scrollHeight`) draws the popover panel
  behind the spilled rows; the box is `z-50` so the panel paints over the body.
- `items-start` → `items-center` on the header host span; chevron drops `self-start`.

This **deletes** the portal, `OverlayRect` freeze, the band `ResizeObserver`, the in-flow
placeholder span, and `WrapSpacer` — a net simplification. Single-`SortableContext` invariant
is preserved (still one box, one `.Render`).

### Files touched (v3)

- `plugins/reorder/web/internal/reorder-layout.tsx` — trim `ReorderLayout` to `{ strategy }`
  (drop `renderSpacer`, `collisionDetection`, `SpacerProps`).
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — render `SpacerReorderItem`
  directly again; keep `strategy={injected?.strategy}`.
- `plugins/reorder/web/index.ts` — drop `SpacerProps` export.
- `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx` — rewrite:
  in-flow, overflow-toggle, measured backdrop; no portal.
- `plugins/primitives/plugins/collapsible-wrap/web/internal/wrap-spacer.tsx` — **deleted.**
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` — add `headerSpill` prop.
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` —
  pass `headerSpill`.
- `plugins/conversations/plugins/conversation-view/plugins/header/web/components/header-view.tsx`
  — `items-start` → `items-center`.
