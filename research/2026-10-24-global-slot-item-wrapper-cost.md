# Slot item wrapper cost: pay only for layers that have work to do

## Context

Opening a conversation (154-row transcript) blocks for ~755 ms. It mounts 62k
components, then another 22k. About 19k of those are slot plumbing: each of the
1,605 slot contributions is wrapped in a dozen-plus layers, even when nothing is
being edited or reordered. Slots render inside list rows (transcript rows,
DataView rows, row actions), so this cost is rows × contributions on every
screen.

Goal: when the optional layers have nothing to do, rendering a slot contribution
should cost close to what the contribution itself costs.

The user confirmed that **live drag-to-reorder (the "Edit layout" mode) is no
longer used and can be removed**. Committed layouts (`config/**/<slot>.jsonc`:
order, hidden, spacers, dividers, header and overflow groups) still apply. They
stay editable in Settings → Config through the reorder-tree field, which uses
`reorder/editor` on its own and does not depend on the live mode.

## Today's chain, per contribution (`.Render`, vertical host, at rest)

Read from the code. These fiber counts are what to verify in Phase 0.

```
Fragment(key)                                  list mw itemNodes
 └ ReorderItemClaimContext.Provider(true)      list-middleware.tsx
   └ ContributionBox                           render-slot.tsx
     └ div.contents (ItemAttrs)
       └ ItemMiddlewares → Fragment
         └ ReorderItemMiddleware (50)          reorder/web/internal/item-middleware.tsx
           └ ReorderItemClaimContext.Provider(false)
             └ ReorderItemBox → GrowRelay → GrowRelayContext.Provider → ItemBox
               └ DeferredSortableItem (useSyncExternalStore) → div.contents
                 └ Fragment → div.contents
                   └ PluginMarkerMiddleware (50) → PortalForwardProvider → Context.Provider
                     └ ErrorBoundaryMiddleware (100) → PluginErrorBoundary
                       └ PaneTitleSlotGuard (200)
                         └ the contribution
```

That is about 20 fibers, 3 DOM nodes and 1 store subscription per item. Each
`.Render` adds roughly 10 more: the SlotRender sentinel and measure,
ReorderListMiddleware, its Inner and ReorderInner (and their hooks), a sentinel
div, AreaContext, ItemBindingProvider and its provider, and the
EffectiveEditMode provider.

**Probable remount bug (likely the "+22k").** `ContributionBox` returns
`<div className="contents">` before the host is measured. Once its
`useLayoutEffect` finds a flex row, it returns `<GrowRelay><div/></GrowRelay>`
instead. The element type at that position changes from div to GrowRelay, so
**every contribution of every horizontal slot mounts twice**. Row actions sit in
every row, so this repeats per row. Confirm it with the render-profiler's
Remounts report (cause `element-type`).

## Target chain, at rest

```
SlotItem(key)                         one component: layout, attrs, middleware fold
 └ GrowRelayScope (row-cell .Render only; always present there, value passes through when not a row)
   └ div  (flex cell | contents; ItemAttrs)
     └ PluginErrorBoundary            class, contributed directly
       └ PluginMarkerMiddleware → PortalForwardScope (1 provider)
         └ the contribution
```

That is about 5–6 fibers per item and no subscriptions. The `.Render` overhead
becomes: SlotRender + sentinel span → PaneTitleGuard (list mw) → one reorder
component → items, with its sentinel present only when the tree has nodes.

## Phases

Each phase builds, gets measured, and the numbers go into this doc.

### Phase 0 — Measurement harness and baseline

- New e2e script `plugins/debug/plugins/render-profiler/e2e/mount-cost.ts`, built
  on the profiler's engine and `e2e-harness`:
  1. Boot the app and wait until idle.
  2. Start the profiler.
  3. Perform the action, using client-side navigation so it measures the
     mount, not boot:
     - `--route /agents/c/<id>` for the conversation open
     - `--click "<group header>"` on a grouped DataView, for the unfold
  4. Wait for things to settle, then stop.
  5. Print: commits, fibers rendered, fibers mounted, remounts by cause, the
     top component names by mounts, and total long-task time (a
     PerformanceObserver installed before the action).
- If the profiler report has no per-component-name mount tally, add one
  (`web/internal`, and the `ProfilerReport` type in `core`).
- Fix the targets and record them in this doc:
  - the 154-row conversation id
  - one DataView with groups: the tasks list grouped by category
- Take the baseline against main with `--url http://equin.localhost:9000/...`.
  It only reads, so the read-only main is fine. Run 3 times and take the median.

### Phase 1 — Remove live layout editing

This is mostly deletion. It turns `reorder` into "apply the committed layout".

- Delete `plugins/reorder/plugins/edit-mode`: the switch, the Esc shortcut,
  `AreaEditor`, and the e2e `setEditMode` helper.
- Delete `plugins/primitives/plugins/edit-mode-signal`, and remove its
  consumers:
  - `collapsible-wrap`: the force-expand and the chevron hiding
  - `adaptive-bar`: the `editMode` dependency and the ladder
- In `reorder/web`:
  - Delete `item-middleware.tsx`, `item-claim.tsx`, `effective-edit-mode.tsx`,
    `use-area-editor.ts`, `editor-contract.ts` (and the
    `ReorderSlots.AreaEditor` slot in `slots.ts`), and `testing/claimed.tsx`.
  - Delete `area-writes.ts` and `reorder-layout.tsx` if nothing else uses them
    (CollapsibleWrap's `ReorderLayoutContext` injection goes with them).
  - Delete `__tests__/item-claim.test.tsx` and `e2e/claim-verify.ts`.
- `reorder/plugins/slot-middleware`: drop the `ItemMiddleware` contribution.
- Node types:
  - Pass the area's `orientation` as a render prop (`ReorderNodeRenderProps`),
    so the divider stops reading `ReorderAreaContext`. The Settings renderer
    passes `"vertical"`.
  - `ReorderAreaContext` and `ReorderItemBox` stay in `reorder/area`; only the
    Settings `ReorderEditor` uses them now.
- E2E scripts that toggle edit mode:
  - Delete `pane/e2e/header-reorder.ts`, `reorder/plugins/node-types/e2e/container-members.ts`
    and `page-tree/e2e/row-actions-overflow.ts`, or rewrite them to check a
    config-driven layout. Decide per script by what it checks at rest.
  - Edit `pane/e2e/surface-match.ts`.
- Docs and checks:
  - `reorder/CLAUDE.md`, `reorder/plugins/{area,editor,slot-middleware}/CLAUDE.md`,
    and the `slot-render/CLAUDE.md` mentions.
  - `page/plugins/editor/web/slots.ts`: the `excludeFromReorder` comment, since
    the element-type flip hazard is gone.
  - Keep the `reorder:apply-is-lean` check in sync.
- `primitives/sortable-list/deferred-item` stays, because the Settings
  `ReorderEditor` still uses it.

### Phase 2 — Fold slot-render's per-item chain (`render-slot.tsx`)

- Replace `ContributionBox` + `ItemMiddlewares` + the two Fragments with one
  keyed `SlotItem` component. `renderItem` returns `<SlotItem key={cId} …/>`
  directly, and `.Mount`, `.Dispatch` and `renderIsolated` use it unkeyed. It
  reads the declared layout, the attrs and the middlewares with hooks and folds
  the middlewares inline. With no cell and no attrs it still emits no element.
- **Stable cell chain (fixes the remount):** on the cell path, always render
  `GrowRelayScope` → `div`. Only `className` and the relay's active flag change
  when the orientation flips.
  - `primitives/css/grow-relay` gets the hook form `useGrowRelay(active)`,
    returning `{ growing, scope }`, plus `<GrowRelayScope value={scope}>`.
  - When inactive, `scope` is the parent's value, so it applies nothing and is
    not counted as a relay.
  - `GrowRelay` itself becomes a thin wrapper over the hook.
- Error boundary: `PluginErrorBoundary` takes `{ slotId, contribution }` and is
  contributed as the `Component` itself. `ErrorBoundaryMiddleware` is deleted.
- Pane title guard: the check depends only on the slot (`meta.kind === "render"`
  inside a title), so it moves from `ItemMiddleware` to a `ListMiddleware`,
  which only `.Render` reaches.
  - Add `slotMeta` to the `SlotListMiddleware` props.
  - The throw then lands in the title item's own error boundary, which is
    still loud and contained. Update the doc comment in `pane-title-guard.tsx`.
- Element-picker lineage: `ui-kit` exposes `usePortalForward(name, value)`
  returning `scope`, plus `<PortalForwardScope value>`, with
  `PortalForwardProvider` rewritten on top of them.
  `PluginMarkerMiddleware` renders the scope directly, so it costs 2 fibers
  instead of 3.

### Phase 3 — A lean reorder list middleware

- Collapse `ReorderListMiddleware` / `Inner` / `ReorderInner` into one
  component per site that has a descriptor:
  `useReorderConfig` → `applyTree` (memoized) → keyed `renderItem` output and
  rendered nodes.
- Render the sentinel and the measurement only when the tree has nodes, so
  that dividers get an orientation.
- No providers, regime, writes, `nodeTypes`, or editor lookups at rest.
  Container node members render `renderItem(m)` with no claim.

## Not in scope

- Deriving the picker's lineage for portals from the DOM anchor, which would
  remove the last per-item provider. Cursor menus and imperative dialogs have
  no DOM anchor, so it is not complete yet. File a follow-up if Phase 2's
  numbers say it matters.
- Virtualizing transcript rows. That is a separate perf track.

## Critical files

- `plugins/primitives/plugins/slot-render/web/internal/{render-slot.tsx,types.ts,registry.ts}`
- `plugins/reorder/web/internal/list-middleware.tsx`, `plugins/reorder/plugins/slot-middleware/web/index.ts`
- `plugins/reorder/plugins/edit-mode/**` (deleted), `plugins/primitives/plugins/edit-mode-signal/**` (deleted)
- `plugins/primitives/plugins/css/plugins/grow-relay/web/internal/grow-relay.tsx`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/portal-forward.tsx`
- `plugins/primitives/plugins/error-boundary/web/{index.ts,components/plugin-error-boundary.tsx}`
- `plugins/primitives/plugins/pane/web/{header-slot.ts,components/pane-title-guard.tsx}`
- `plugins/primitives/plugins/ui-context/plugins/element-picker/web/internal/marker-middleware.tsx`
- `plugins/reorder/plugins/node-types/core/internal/types.ts` (+ divider)
- `plugins/primitives/plugins/{collapsible-wrap,adaptive-bar}/web/internal/*`

## Verification

- **Numbers:** run `mount-cost.ts` on the conversation open and on the DataView
  group unfold, before (main) and after each phase. Record a table in this
  doc: fibers mounted, commits, remounts (`element-type` should drop to about
  0 for slot items), long-task ms. Acceptance:
  - slot plumbing at about 5–6 fibers per contribution
  - the second "+22k" commit gone
  - blocking mount time measurably lower
- **Tests:** `./equin test plugins/primitives/plugins/slot-render plugins/reorder
  plugins/primitives/plugins/pane plugins/primitives/plugins/error-boundary
  plugins/primitives/plugins/ui-context plugins/primitives/plugins/css/plugins/grow-relay
  plugins/primitives/plugins/adaptive-bar plugins/primitives/plugins/collapsible-wrap`.
  Update the slot-render tests that assert the wrapper structure.
- **Behavior and layout (screenshots, `screenshot.ts`, on my build):**
  - a conversation: row actions in a horizontal cell, truncation still works
  - a pane header: title and actions, and the adaptive-bar overflow
  - the page-tree row actions: the overflow group from config still renders
  - the Settings → Config reorder-tree field: drag, hide and restore still work
  - the element picker: pick inside a popover, the lineage chip names the
    contribution
  - the crash fallback: a throwing contribution stays contained
- `./equin check` (boundaries, plugin docs, `reorder:apply-is-lean`, type-check).

## Outcome (2026-10-24)

Implemented Phases 0–2. Phase 3's lean list middleware landed inside Phase 1
(`ReorderArea` / `ReorderNodesArea`), since removing live editing left nothing
else in it.

Measured with `mount-cost.ts`: fibers of every kind created by ONE in-app action
after boot, median of 3–5 runs. Targets: the conversation open is
`/agents` → `/agents/c/conv-1792836601-tvqqoh`; the DataView unfold is the
Conversations group in Tasks → Tree.

| | DataView unfold: mounted | Conversation open: tree after | Slot plumbing per contribution |
|---|---|---|---|
| Baseline | 14,412 | 30,299 | ~10 (Fragment, claim provider, ContributionBox, ItemMiddlewares + Fragment, ReorderItemMiddleware + claim reset, marker + PortalForwardProvider + provider, EB middleware + EB, title guard; a claimed item adds ReorderItemBox → GrowRelay → provider → ItemBox → DeferredSortableItem → 2 divs) |
| Phase 1 (live editing removed) | 13,292 | 25,303 | ~8 |
| Phase 2 (per-item chain folded) | **11,052 (−23%)** | **23,943 (−21%)** | **4**: SlotItem, SlotItemErrorBoundary, PluginMarkerMiddleware, its provider (+ the `div` box the picker stamps) |

- The conversation open mounts 15,150 fibers after the change. The baseline's
  mount count could not be compared, because the baseline was taken under
  heavy machine load and varied 16.5k–19k between runs. The tree size above is
  the stable comparison.
- Long-task time was too noisy across those load conditions to compare: on a
  quiet machine after the change it was 1.9 s for the conversation open, and
  0.8 s for the unfold.
- The suspected double mount of horizontal slots, caused by the cell flipping
  its element type after it measures its host, did not show up in the Remounts
  report on either screen. It is closed anyway: the cell's chain is now the same
  either way (`GrowRelay active`).
- **Profiler fix found along the way:** a session's first commit only seeded the
  baseline, so a click made right after Start was never counted (the unfold read
  "0 mounted"). Start now seeds from the live root (`findFiberRoot`).
- Tests failing before this change too: data-view `live-source.test.tsx`,
  ui-kit `portal-host-honored.test.tsx`, the page-editor server DB tests and the
  pane lint test. The `page-tree/e2e/row-actions-overflow.ts` script also fails
  the same way on main ("Delete page" inline).
