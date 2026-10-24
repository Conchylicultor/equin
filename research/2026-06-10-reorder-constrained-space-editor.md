# Reorder editor — constrained-space behavior

## Context

In edit mode the reorder primitive inflates every item with chrome (drag ring, ×-badge,
empty-item placeholder, the trailing `+Add` restore button). In a wide band that's fine; in
a narrow container the items + chrome overflow and overlap — a tiny conversation-progress
card crams its green/orange dots under the `+Add` button (the reported bug). Separately,
empty items showed their full dotted plugin path as a placeholder, eating horizontal space.

**Already shipped (this branch):** the label fix — `contributionLabel` now prefers the short
`id` over `_pluginId` (`plugins/reorder/web/internal/sorting.ts`), and the horizontal
empty-item placeholder is `max-w-24 truncate` (`plugins/reorder/plugins/editor/web/internal/items.tsx`).

This plan covers the structural fix: make the reorder display clean when there isn't enough
horizontal space for all items + edit chrome, via **two width-driven regimes** (user-approved
direction "Popover edit + wrap fallback"):

- **Wide enough → wrap in edit mode**: horizontal items flex-wrap onto multiple rows.
- **Too narrow → popover edit**: the inline view stays clean (real contributions in display
  mode, not draggable, no chrome) plus a small pen trigger that opens a roomy **vertical**
  reorder popover hosting the full list (visible + hidden + spacers + groups).

## Architectural constraints (verified)

- **`SortableList` renders children with no wrapper div** (`plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx`):
  children land directly in the HOST's flex container. The editor owns no layout container;
  layout (flex-direction, wrap) is the host's.
- **`CollapsibleWrap`** (`plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx`)
  is the existing host-side wrap: a `flex flex-wrap` box that injects `ReorderLayoutContext`
  (`{ strategy: rectSortingStrategy }`) and measures its wrap box's children. An
  **editor-owned wrap div would break that measurement** → never add one when a host already
  wraps. Signal: presence of the injected `ReorderLayoutContext` (`const injected = useContext(ReorderLayoutContext)`
  in `dnd-list-middleware.tsx`) means "host owns wrapping."
- **`ReorderItemMiddleware`** reads the GLOBAL `useEditMode()`. To render the inline view
  display-only while global edit mode is ON, the list middleware must override edit mode for
  its inline subtree only.
- **`ReorderEditor`** is presentational and orientation-prop-driven → reusable in a popover as
  a vertical list with the same entries + callbacks the middleware already builds.
- Width measurement: ResizeObserver + `requestAnimationFrame`, no timers (repo rule; mirror
  `collapsible-wrap.tsx`).

## Core mechanism — effective edit mode per area

New internal context `ReorderEffectiveEditModeContext` (`boolean | null`) in `reorder/web`,
provided by the list middleware and consumed by `ReorderItemMiddleware` **and** `ReorderGroupBox`:

- `null` (default) → read the global `useEditMode()` signal as today.
- `false` → force display-only: items take the non-draggable early return, group boxes drop
  their edit chrome. This is what makes the inline render in the popover regime clean **and**
  guarantees no `useSortable` runs without a `SortableContext` inline.

`ReorderItemMiddleware`: call `useEditMode()` unconditionally, then `const editMode = override ?? globalEditMode`;
add `if (override === false) return <>{children}</>;` (after the `excluded` early return, before
building `SortableReorderItem`). `ReorderGroupBox` reads the same context to derive its effective
edit mode (falls back to its `editMode` prop / global) so groups in the inline display are also
chrome-free. This is the refinement over a naive "items-only" override — entries are built once
with the global editMode, so the group box must honor the context, not just its prop.

## Regime decision (in `ReorderListMiddlewareInner`)

Horizontal reorder area:
- `injected` present (CollapsibleWrap host) → **host-wrap**: today's render, unchanged.
- `orientation === "vertical"` or `!editMode` → **passthrough**: today's render (vertical
  rows already stack `w-full`; no chrome outside edit mode → no overflow).
- horizontal + editMode + no injected context → measure host width:
  - `width >= THRESHOLD` → **editor-wrap**.
  - `width < THRESHOLD` → **popover**.
  - `width === null` (pre-measure) → **editor-wrap** (safe: wrapping never overlaps).

`THRESHOLD = 280` px, a single documented module constant (tunable; matches the
progress-card host class). Add a ~16px hysteresis band only if Playwright shows oscillation.

## Files to change

1. **`plugins/reorder/web/internal/effective-edit-mode.tsx`** (NEW, internal):
   `export const ReorderEffectiveEditModeContext = createContext<boolean | null>(null);`

2. **`plugins/reorder/web/internal/dnd-item-middleware.tsx`**: consume the context; override
   editMode; early-return `<>{children}</>` when `override === false`.

3. **`plugins/reorder/web/internal/group-box.tsx`**: derive effective edit mode from the
   context (fallback to prop/global) so inline group boxes are display-only.

4. **`plugins/reorder/web/internal/dnd-list-middleware.tsx`** (bulk):
   - Imports: `rectSortingStrategy` (sortable-list/web), `InlinePopover` (popover/web),
     `IconButton` (icon-button/web), `MdEdit`, `ReorderEffectiveEditModeContext`.
   - `POPOVER_WIDTH_THRESHOLD = 280` constant.
   - Extend the sentinel effect into a ResizeObserver+raf on `sentinelRef.current.parentElement`
     setting both `orientation` and `hostWidth`.
   - Memoized `regime`; `wrap = regime === "editor-wrap"`;
     `strategy = injected?.strategy ?? (wrap ? rectSortingStrategy : undefined)`.
   - Render branches:
     - host-wrap / passthrough / editor-wrap → `<ReorderEditor … editMode orientation strategy {wrap} />`.
     - popover → `<ReorderEffectiveEditModeContext.Provider value={false}>`-wrapped inline
       display nodes (reuse `entries[].node`; spacers as `flex-1`) + an `IconButton` pen
       trigger; `InlinePopover` content = `<ReorderEditor entries hiddenItems …allCallbacks
       editMode orientation="vertical" />` (OUTSIDE the `value={false}` provider, so its items
       are draggable). All callbacks are the existing `*Ref` handlers — **zero new write paths**.
   - Keep the `display:none` sentinel as the first child of every branch.

5. **`plugins/reorder/plugins/editor/web/internal/reorder-editor.tsx`**: add `wrap?: boolean`;
   when set, render the `SortableList` children inside an owned
   `<div className="flex flex-wrap content-start items-start gap-1.5 min-w-0">{itemNodes}{editMode && <RestoreButton/>}</div>`
   (extract `itemNodes` so both branches share it). Default/false → bare render as today.

6. **`plugins/reorder/plugins/editor/web/internal/types.ts`**: add `wrap?: boolean` to
   `ReorderEditorProps` with a doc note ("editor-owned wrap; never with a CollapsibleWrap host").

7. **Docs**: update `plugins/reorder/CLAUDE.md` + `plugins/reorder/plugins/editor/CLAUDE.md`
   (the `wrap` prop, the effective-edit-mode override, the three regimes, the threshold).

No server / core / config / storage-format changes. No new public-barrel exports (the context
is internal to `reorder/web`).

## Non-breakage notes

- **CollapsibleWrap hosts**: gated first on `injected` → byte-for-byte today's path; no
  editor-owned wrap, no popover, no override.
- **Group / hide / restore / spacer / materialize writes**: untouched — all regimes share the
  same `entriesRef`/`hiddenKeysRef` handlers; only the dispatching surface changes.
- **Vertical & non-edit areas**: routed to passthrough explicitly.
- **Two-SortableContext safety**: inline display mounts no `SortableContext` (override false);
  the popover is the only drag surface → the single-context invariant holds.
- **Plugin boundaries**: `editor` gains only a presentational `wrap` prop (no `reorder/web`
  import). The context + popover wiring live in `reorder/web` (already imports the editor and
  may import popover/icon-button).

## Verification

- `./equin build` (typecheck + lint + boundary checks); confirm `reorderable-slots-in-sync`
  and `config-origins-in-sync` unaffected (no storage change).
- Playwright (`e2e/screenshot.mjs`), in and out of edit mode:
  1. **Wide CollapsibleWrap host** (conversation header band): edit mode wraps across rows as
     today; no editor-owned wrap div (host-wrap regime) — no regression.
  2. **Wide non-CollapsibleWrap host ≥280px**: editor-wrap — items wrap, `+Add` wraps cleanly,
     cross-row drag works (rectSortingStrategy), drop persists.
  3. **Narrow progress-dots card <280px** (the bug): out of edit mode dots render normally;
     in edit mode the inline shows real contributions display-only (no ring/×, not draggable)
     + a pen button; dots are NOT crammed under `+Add`. Pen opens a vertical popover with all
     visible + hidden + spacers + `+Add`; reorder/hide/restore/add-spacer/add-group persist.
  4. **Resize across threshold** (320→240→320 in edit mode): transitions editor-wrap ↔ popover
     with no flicker and no console errors (no orphaned `useSortable`).
  5. **Vertical list** (detail-sections column) in edit mode: unchanged (passthrough).

## Critical files

- `plugins/reorder/web/internal/dnd-list-middleware.tsx` (regime, measurement, popover wiring)
- `plugins/reorder/web/internal/dnd-item-middleware.tsx` (effective edit mode)
- `plugins/reorder/web/internal/group-box.tsx` (effective edit mode)
- `plugins/reorder/web/internal/effective-edit-mode.tsx` (NEW context)
- `plugins/reorder/plugins/editor/web/internal/reorder-editor.tsx` (`wrap` prop)
- `plugins/reorder/plugins/editor/web/internal/types.ts` (`wrap` prop type)
- Reference (not edited): `plugins/primitives/plugins/collapsible-wrap/web/internal/collapsible-wrap.tsx`
