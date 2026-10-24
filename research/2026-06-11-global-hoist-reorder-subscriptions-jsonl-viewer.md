# Hoist row-invariant reorder/config subscriptions out of the jsonl-viewer per-row render

## Context

On a live conversation page, the live-state trace shows the largest client-side
subscription fan-out comes from **config / reorder**, not conversations:

- `config-v2.values`: 868 observes (1222 obs+unobs)
- `config-v2.scope-forked`: 442 observes (623 total)
- `reorder.groups`: 194 observes (267 total)

These are **row-invariant**. The jsonl-viewer renders one `EventRow` per message,
and each row renders `<JsonlViewer.RowAction.Render>` (the hover-action buttons).
`SlotRender` wraps that render in the registered **reorder list middleware**
(`ReorderListMiddleware`), whose inner component subscribes — *once per row* — to:

- `useConfig(reorderDirectiveDescriptor("conversation.jsonl-viewer.row-action"))`
  → `config-v2.values` (×2 identical calls inside `useConfig`) + `config-v2.scope-forked`
- `useResource(reorderGroupsResource, { slotId })` → `reorder.groups`

All three are keyed by the **base `slotId`** and are identical for every row. They
dedupe server-side and even client-side (refcount in `NotificationsClient.observe`),
so the cost is **client-side**: observe/unobserve bookkeeping churn on every row
mount/unmount as messages stream in, plus a per-row `ResizeObserver` and full DnD
wiring. This observe/unobserve burst (≈1193 events / 250 ms flush) is what recently
overflowed the log emitter. The objective is to **cut the subscription count** by
reading the row-invariant reorder state once per viewer — **without** dropping the
reorder feature: the pen-button drag must still reorder the global order.

This is a class bug. The same per-row-`.Render`-inside-a-`.map` pattern exists in
`task-list` (TaskActions), `agents-list` (AgentActions), and `conversation-item`
(Chips). The fix is a small reusable provider; this plan applies it to the
jsonl-viewer (the biggest offender) and leaves the siblings as follow-ups.

## Key insight

What the three subscriptions feed is **row-invariant**: the resolved order
(`applyTree` → `state`), the visibility/hidden set, the groups, and the **write
callbacks** (`onDrop`/`hideItem`/`addSpacer`/group ops → `setConfig`). Only the
final rendered `node` per entry is per-row (it closes over the row's `event` via
the row's `renderItem`).

So we split `ReorderListMiddlewareInner`
(`plugins/reorder/web/internal/dnd-list-middleware.tsx`) into:

- a **provider** that subscribes once and publishes `{ state, callbacks, editMode }`
  via context, and
- a **per-row consumer** that reads the context (zero subscriptions) and renders —
  interactively when `editMode` is on (wired to the shared callbacks, so drag still
  mutates the global `items` config), display-only when off (also dropping the
  per-row `ResizeObserver` + DnD context in the common case).

Subscriptions go from `3 × N rows` (with constant churn) to `3 × 1` per viewer.
Pen-drag is unchanged. Non-hoisted slots keep today's self-subscribing behavior.

## Design

All changes are in the **`reorder`** plugin plus a one-line wrapper in the
jsonl-viewer. **`slot-render` is untouched** — the reorder middleware already runs
inside `SlotRender` and reads its own context; the `.Render` call sites stay as-is.

### 1. New context (reorder, internal)

`plugins/reorder/web/internal/hoist-context.tsx`:

```ts
export interface HoistedReorderScope {
  state: ReturnType<typeof applyTree>;        // resolved order/visibility/groups (row-invariant)
  groupsData: ReorderGroupsPayload;
  editMode: boolean;
  storageId: string;                          // base slotId (subId not used at viewer scope)
  callbacks: {                                // ref-backed, stable identities (built once)
    onDrop; onHide; onRestore; onAddSpacer; onDeleteSpacer;
    onGroupCreate; onGroupJoin; onGroupReorder; onAddGroup; renderOverlay;
  };
}
// Map keyed by slotId so a viewer can hoist several slots / nest providers.
export const ReorderHoistContext = createContext<Map<string, HoistedReorderScope> | null>(null);
```

### 2. Extract the shared resolve+write logic (reorder)

Refactor `ReorderListMiddlewareInner` so the **subscribe + compute + build-callbacks**
body becomes a hook reused by both the provider and the legacy self-subscribing path:

- `useReorderResolution(slotId, descriptor)` →
  reads `rawContributions` from `PluginRuntimeContext` (`ctx.bySlot.get(slotId)`,
  same as `SlotRender` line 96), calls `useConfig(descriptor)` +
  `useResource(reorderGroupsResource, { slotId })`, runs `applyTree`, and builds the
  ref-backed write callbacks (the existing `onDrop`/`hideItem`/… closures, all of
  which already operate on `entryKey`s + refs, not on rendered nodes). Returns
  `{ state, groupsData, callbacks }`.
- Extract the `entries` mapping (current lines 481–528, `groupedEntries → ReorderEntry[]`
  with `node` built via `renderItem`) into `buildEntries(groupedEntries, renderItem, storageId, editMode)`
  so both the provider-less and hoisted paths build identical presentational entries.

### 3. Provider: `ReorderHoist` (reorder, exported from `@plugins/reorder/web`)

```tsx
export function ReorderHoist({ slot, subId, children }: {
  slot: { id: string }; subId?: string; children: ReactNode;
}) {
  const descriptor = reorderDescriptors.get(slot.id);
  if (!descriptor) return <>{children}</>;            // stable branch (slot.id is a prop)
  return <ReorderHoistInner slotId={slot.id} subId={subId} descriptor={descriptor}>{children}</ReorderHoistInner>;
}
```

`ReorderHoistInner` calls `useReorderResolution` + `useEditMode()` **once**, clones
the inherited Map adding `{ [slotId]: scope }`, and provides it. Mounted once per
viewer → the three subscriptions are created once.

### 4. Per-row middleware reads the context first (reorder)

`ReorderListMiddleware` (the registered list middleware, runs inside every
`SlotRender`):

```tsx
function ReorderListMiddleware({ slotId, contributions, renderItem }) {
  const hoisted = useContext(ReorderHoistContext)?.get(slotId);   // first hook, always called
  const descriptor = reorderDescriptors.get(slotId);
  if (!descriptor) return <>{contributions.map(renderItem)}</>;   // unchanged fallback
  if (hoisted) return <HoistedReorderRender scope={hoisted} renderItem={renderItem} />;
  return <ReorderListMiddlewareInner slotId={slotId} descriptor={descriptor}
            contributions={contributions} renderItem={renderItem} />;  // legacy self-subscribing path, unchanged
}
```

`HoistedReorderRender` (no live-state subscriptions):

- `editMode` **off** → build display-only entries via `buildEntries(scope.state.groupedEntries, renderItem, scope.storageId, false)` and render them inline (mirror the existing `regime === "popover"` display-only inline block, dnd-list-middleware.tsx:593–600 — items/spacers/group boxes, no `SortableContext`, no sentinel/ResizeObserver).
- `editMode` **on** → render the full interactive `<ReorderEditor>` exactly as the legacy path does (lines 633–644), wired to `scope.callbacks`. Drag → shared callback → `setConfig` → provider re-derives → all rows re-render. Global-order editing preserved.

Switch components on `editMode` (`editMode ? <HoistedEditor/> : <HoistedDisplay/>`)
so the hook sets per branch stay stable; an edit-mode toggle remounts (rare, fine).

The per-row `ResizeObserver`/regime logic stays only on the **edit-mode-on** branch
(needed for constrained-space regimes), so the common (non-edit) path is cheapest.

### 5. Consumer: wrap the row list once (jsonl-viewer)

`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`
— wrap the rendered rows; `event-row.tsx` is **unchanged**:

```tsx
import { ReorderHoist } from "@plugins/reorder/web";
// …inside the events-loaded branch:
<ReorderHoist slot={JsonlViewer.RowAction}>
  <LastAssistantProvider event={lastAssistantEvent}>
    <EventSections events={visibleEvents}>…</EventSections>
  </LastAssistantProvider>
</ReorderHoist>
```

(`JsonlViewer.RowAction` is a `RenderSlot`, which has `.id`
`"conversation.jsonl-viewer.row-action"`.)

## Critical files

- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — split into provider +
  `useReorderResolution` + `buildEntries` + `HoistedReorderRender`; keep
  `ReorderListMiddlewareInner` as the unchanged fallback.
- `plugins/reorder/web/internal/hoist-context.tsx` — **new** context + types.
- `plugins/reorder/web/index.ts` — export `ReorderHoist`.
- `plugins/reorder/web/internal/descriptors.ts`, `.../sorting.ts`,
  `groups/core` (`reorderGroupsResource`, `ReorderGroupsPayload`) — reused as-is.
- `plugins/conversations/.../jsonl-viewer/web/components/jsonl-pane.tsx` — add the
  `ReorderHoist` wrapper (one import + one element).

## Non-goals / preserved behavior

- **Pen-drag still reorders the global `items` order.** Only the *subscription site*
  moves up; rows still render interactively in edit mode.
- **No `slot-render` change.** The seam is reorder's own context, read by reorder's
  middleware.
- **Non-hoisted slots unchanged.** Any `.Render` not under a `ReorderHoist` keeps the
  legacy self-subscribing path (fail-safe).
- Config-pane editing of the `items` tree (the `reorder-tree` field) is unaffected.

## Verification

1. `./equin build` (regenerates nothing reorder-related here; no schema/manifest
   change — the slot set is unchanged).
2. Open a **long** live conversation at `http://<worktree>.localhost:9000` and watch
   the live-state trace:
   `tail -f ~/.singularity/worktrees/singularity/logs/live-state.jsonl`
   (or the Debug → live-state-health pane). Confirm `config-v2.values`,
   `config-v2.scope-forked`, and `reorder.groups` observe counts drop from
   ~N-per-row to a small constant, and the observe/unobserve burst per flush window
   collapses. Compare against the pre-change numbers above.
3. Hover a message row → the row-action buttons (timestamp, raw-json, copy, fork…)
   still render in the configured order.
4. Toggle the pen button (edit mode) → drag a row-action button to reorder; confirm
   the new order persists and applies to **every** row (global order). Hide/restore a
   button; confirm it persists.
5. Scripted check with `bun e2e/screenshot.mjs` toggling edit mode on a row-action,
   verifying the buttons reorder.
6. Regression: a slot rendered *without* a `ReorderHoist` (e.g. task-list rows, left
   unchanged) still reorders via pen drag as before.

## Follow-ups (out of scope here)

Apply the same one-line `ReorderHoist` wrapper to the sibling per-row slots:
`task-list` (TaskActions), `agents-list` (AgentActions), `conversation-item` (Chips).
File via `add_task` after this lands.
