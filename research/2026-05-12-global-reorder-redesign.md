# Reorder Plugin Redesign for RenderSlot.Render

## Context

The reorder plugin has two parallel rendering paths:

1. **`Reorder.area()` + `Reorder.useArea()`** — manual host API. Returns `{ items, DndWrapper, ReorderItem, groupedEntries, GroupBox }`. The host must manually iterate, dispatch on `isGroupEntry`/`isSpacer`, and wire up DnD. ~800 lines of complex code.

2. **`defineRenderSlot()` + `<Slot.Render>`** — automatic middleware. A `ReorderSortMiddleware` sorts and hides items, but provides NO DnD (no drag handles, no groups, no spacers). 50 lines.

Both share the same backend (reorder_prefs table, HTTP API, push resource). The dual system is the root cause of bugs and confusion. Every host using path 1 has 20-40 lines of boilerplate (`DndWrapper` → `groupedEntries.map` → `isGroupEntry` dispatch → `GroupBox` → `ReorderItem`).

**Goal**: eliminate path 1 entirely. All DnD capability moves into the middleware pipeline. Hosts use `<Slot.Render>` and nothing else.

## Mental Model (3 concepts)

| Role | API | What it does |
|---|---|---|
| **Slot owner** | `defineRenderSlot("id", { reorder: { getLabel, enableGroups } })` | Declares a slot is reorderable |
| **Host** | `<Slot.Render>{(item) => ...}</Slot.Render>` | Renders with automatic DnD |
| **Data consumer** | `slot.useContributions()` | Raw items for non-rendering logic (e.g. routing) |

No `Reorder.area`, no `Reorder.useArea`, no `DndWrapper`, no `ReorderItem`, no `GroupBox`.

## Architecture: Two Middlewares

### `ReorderListMiddleware` (list middleware, priority 0)

Replaces the current `ReorderSortMiddleware`. Handles the entire list-level structure:

- Reads `reorderPrefsResource` (ranks, hidden flags) and `reorderGroupsResource` (user-created groups)
- Filters hidden items, sorts visible items by rank
- Wraps everything in `<DndContext>` + `<ReorderAreaContext.Provider>`
- Handles `enableGroups`: renders `<ReorderGroupBox>` around group members, interleaves ungrouped items
- Injects spacer elements between real items
- Appends `<RestoreButton />` in edit mode
- Handles all `onDragEnd` logic (reorder, group create, group join, group reorder)
- If slot has no reorder config: passes through unchanged

### `ReorderItemMiddleware` (item middleware, priority 50)

New. Handles per-item DnD affordances:

- Reads edit mode signal and reorder config for the slot
- If not edit mode or `excludeFromReorder`: passes through (just renders children)
- If edit mode: wraps children with drag handles and hide (×) button
  - `enableGroups` → three-zone drop targets (before/after/child)
  - No `enableGroups` → single-zone drop target
- Spacer items are rendered directly by the list middleware, not the item middleware

### Why two middlewares?

The list middleware handles the **macro structure** (context provider, sort order, group boxes, spacer injection, restore button). The item middleware handles the **per-item affordance** (drag handle, drop zones). This matches the existing architecture where the error boundary is an item middleware wrapping each contribution.

An item rendered inside a `GroupBox` gets the same item middleware treatment as a top-level item.

## What's Deleted

| Symbol | Why |
|---|---|
| `Reorder.area()` | Replaced by `defineRenderSlot` reorder config |
| `Reorder.useArea()` | Replaced by `<Slot.Render>` middleware |
| `ReorderableSlot<P>` type | Replaced by `RenderSlot<P>` |
| `UseAreaResult<P>` type | Gone — no host-facing DnD API |
| `HostOverride` type | Gone — no filter/subId overrides needed |
| `reorder.ts` (`{ Reorder }`) | Gone — no namespace object |
| `area.ts` (registry) | Gone — config lives in slot-render's `renderSlotConfigs` |

## What's Kept (unchanged)

- **Backend**: `reorder_prefs` table, HTTP API (`GET/PATCH/DELETE /api/reorder/:slotId`), `reorderPrefsResource`
- **Groups sub-plugin**: server tables, HTTP routes, `reorderGroupsResource`, core types
- **Edit mode signal**: module-level `setEditMode`/`useEditMode` in `edit-mode-store.ts`
- **Edit mode sub-plugin**: pen button on Shell.Toolbar, Esc handler
- **UI components**: `ReorderGroupBox`, `GroupRename`, spacer rendering, restore button
- **Utility functions**: `itemKey()`, `isSpacer()`, `isGroupEntry()`, `SPACER_PREFIX`

## Implementation

### Phase 1: Extract and create new files in `plugins/reorder/web/internal/`

**`sorting.ts`** (NEW) — Pure computation extracted from `use-area.tsx`:

```ts
export function computeReorderState<P extends { id: string }>(
  items: P[],
  rankMap: ReorderSlotPrefs,
  groupsData: ReorderGroupsPayload | null,
  config: ReorderConfig<P>,
): {
  sortedItems: P[];          // visible, non-spacer, sorted by rank
  hiddenItems: P[];          // items with hidden flag
  groupedEntries: TopLevelEntry<P>[];  // groups + ungrouped interleaved
  membershipMap: Map<string, { groupId: string; rank: Rank }>;
}
```

No React hooks. The `useMemo` bodies from `use-area.tsx` (lines 168-304) become this function.

**`dnd-list-middleware.tsx`** (NEW) — The `ReorderListMiddleware` component:

- Reads `getRenderSlotConfig(slotId)` to check if slot has reorder config
- If not: renders `<>{children}</>` (passthrough)
- If yes: reads resources, calls `computeReorderState`, renders DndContext + sorted items + groups + spacers + restore button
- Contains the drag-end handlers (moved from `use-area.tsx` lines 325-540)

**`dnd-item-middleware.tsx`** (NEW) — The `ReorderItemMiddleware` component:

- Reads `getRenderSlotConfig(slotId)` to check if slot has reorder config
- Reads `useEditMode()`
- Reads `contribution.excludeFromReorder` from the raw contribution
- If not reorderable: `<>{children}</>`
- If reorderable + edit mode: wraps with drag handles (existing `ReorderItemSingleZone` or `ReorderItemThreeZone`)

**`dnd-components.tsx`** (NEW) — Extract from `use-area.tsx`:

Move these components out of `use-area.tsx` into a standalone file (they're already self-contained):
- `ReorderItemSingleZone` (line 823)
- `ReorderItemThreeZone` (line 900)
- `SpacerReorderItem` (line 1001)
- `RestoreButton` (line 1085)
- `ReorderAreaContext` type and context

### Phase 2: Update reorder barrel and registration

**`plugins/reorder/web/index.ts`** — Change registration:

```ts
register: [{
  register() {
    registerSlotListMiddleware({ priority: 0, Component: ReorderListMiddleware });
    registerSlotItemMiddleware({ priority: 50, Component: ReorderItemMiddleware });
  },
}],
```

Exports: keep `setEditMode`, `useEditMode`, `itemKey`, `isSpacer`, `isGroupEntry`, `SPACER_PREFIX` (used internally and by edit-mode sub-plugin). Remove `Reorder`, `UseAreaResult`, `ReorderableSlot`, `HostOverride`, `ReorderConfig` (the canonical `ReorderConfig` lives in slot-render).

### Phase 3: Migrate slot declarations

Every `Reorder.area(defineSlot(...), opts)` → `defineRenderSlot(..., { reorder: opts })`:

| File | Before | After |
|---|---|---|
| `plugins/shell/web/slots.ts` | `Reorder.area(defineSlot<...>("shell.toolbar"), { getLabel, enableGroups })` | `defineRenderSlot<...>("shell.toolbar", { reorder: { getLabel, enableGroups } })` |
| `plugins/apps/web/slots.ts` | `Reorder.area(defineSlot<...>("apps.app"), { getLabel })` | `defineRenderSlot<...>("apps.app", { reorder: { getLabel } })` |
| `plugins/conversations/.../slots.ts` | `Reorder.area(defineSlot<...>("conversation.prompt-bar"), { getGroup })` | `defineRenderSlot<...>("conversation.prompt-bar", { reorder: {} })` |
| `plugins/conversations/.../slots.ts` | `Reorder.area(defineSlot<...>("conversation.above-prompt-input"))` | `defineRenderSlot<...>("conversation.above-prompt-input")` |
| `plugins/apps/plugins/{forge,file-explorer,debug}/.../slots.ts` | `Reorder.area(defineSlot<...>(...), ...)` | `defineRenderSlot<...>(..., { reorder: ... })` |

Note: PromptBar drops `getGroup` (section constraint). Items reorder freely. Section dividers are removed (per user decision).

### Phase 4: Migrate hosts

**`plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`**

- `toolbarSlot` type: `ReorderableSlot<AppShellToolbarItem>` → `RenderSlot<AppShellToolbarItem>`
- Remove `Reorder.useArea(toolbarSlot)` and all `groupedEntries` dispatch
- Replace with `<toolbarSlot.Render>{(item) => <ToolbarItem {...item} />}</toolbarSlot.Render>`
- Remove imports from `@plugins/reorder/web`

**`plugins/apps/web/components/apps-layout.tsx`**

- Replace `Reorder.useArea(Apps.App)` with `Apps.App.useContributions()` for routing
- `AppRail` renders `<Apps.App.Render>{(app) => <RailIcon app={app} />}</Apps.App.Render>`
- Remove `DndWrapper`/`ReorderItem` props from `AppRail`

**`plugins/conversations/.../conversation-view.tsx`**

- Remove `Reorder.useArea(Conversation.PromptBar)` and `Reorder.useArea(Conversation.AbovePromptInput)`
- Remove the `PromptBar` component (section dispatch logic)
- Replace with:
  ```tsx
  <Conversation.PromptBar.Render>
    {(item) => <item.component conversation={conversation} />}
  </Conversation.PromptBar.Render>
  ```
- Use `Conversation.PromptBar.useContributions().length > 0` for show/hide check

**`plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx`**

- `defineSlot` + `Reorder.area` → `defineRenderSlot` with `reorder: { getLabel }`
- `DetailSections.Section` type: `ReorderableSlot<...>` → `RenderSlot<...>`
- `Host` component: remove `Reorder.useArea`, replace with `<Section.Render>`

### Phase 5: Delete old code

- Delete `plugins/reorder/web/internal/use-area.tsx`
- Delete `plugins/reorder/web/internal/area.ts`
- Delete `plugins/reorder/web/internal/reorder.ts`
- Delete `plugins/reorder/web/internal/render-middleware.tsx`
- Remove old type exports from barrel

## Edge Cases

**`excludeFromReorder: true`** (pen button): The item middleware reads this from `contribution.excludeFromReorder`. The sorting logic pushes excluded items to the end. No change in behavior.

**`subId`**: `RenderSlot.Render` already accepts `subId` and provides it via `RenderSlotSubIdContext`. The list middleware reads it to compute `storageId = subId ? slotId:subId : slotId`. Same as current `ReorderSortMiddleware`.

**Apps.App routing**: Uses `Apps.App.useContributions()` (not sorted by reorder, but routing sorts by path length anyway). Visual rail uses `<Apps.App.Render>`.

**Edit-mode sub-plugin**: No change. It imports `setEditMode`/`useEditMode` from `@plugins/reorder/web` and contributes to `Shell.Toolbar`. The circular dependency avoidance (edit-mode as sub-plugin) remains necessary.

**Multiple DndContexts**: Each slot's `<Render>` gets its own `DndContext` from the list middleware. Multiple slots on the same page (e.g., sidebar + toolbar) have independent DnD contexts. This is correct — items can only drag within their slot.

**Slots without reorder config**: Both middlewares check `getRenderSlotConfig(slotId)`. Slots without reorder config (like `Conversation.ActionBar`) pass through unchanged. The middlewares are no-ops for non-reorder slots.

## Verification

1. `./equin build` — compiles and deploys
2. Test edit mode: pen button → drag handles appear on toolbar items, sidebar items → drag to reorder → ranks persist across refresh
3. Test groups: drag item onto item in toolbar → group created → expand/collapse → rename → delete group
4. Test spacers: add spacer in edit mode → drag spacer → delete spacer
5. Test hide/restore: hide item via × → restore via popover
6. Test Apps rail: reorder apps → routing still works → active app highlights correctly
7. Test PromptBar: items render without section dividers → reorder works
8. Test detail sections (task detail, agent detail): sections reorder correctly

## Files Changed

### New
- `plugins/reorder/web/internal/sorting.ts`
- `plugins/reorder/web/internal/dnd-list-middleware.tsx`
- `plugins/reorder/web/internal/dnd-item-middleware.tsx`
- `plugins/reorder/web/internal/dnd-components.tsx`

### Modified
- `plugins/reorder/web/index.ts` — new middleware registration, updated exports
- `plugins/shell/web/slots.ts` — Toolbar → defineRenderSlot
- `plugins/apps/web/slots.ts` — App → defineRenderSlot
- `plugins/apps/web/components/apps-layout.tsx` — useContributions + Render
- `plugins/apps/web/components/app-rail.tsx` — simplified, uses Render
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` — RenderSlot type, Render
- `plugins/conversations/plugins/conversation-view/web/slots.ts` — defineRenderSlot
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` — Render
- `plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx` — defineRenderSlot + Render
- `plugins/apps/plugins/forge/plugins/shell/web/slots.ts` — defineRenderSlot
- `plugins/apps/plugins/file-explorer/plugins/shell/web/slots.ts` — defineRenderSlot
- `plugins/apps/plugins/debug/plugins/shell/web/slots.ts` — defineRenderSlot

### Deleted
- `plugins/reorder/web/internal/use-area.tsx`
- `plugins/reorder/web/internal/area.ts`
- `plugins/reorder/web/internal/reorder.ts`
- `plugins/reorder/web/internal/render-middleware.tsx`
