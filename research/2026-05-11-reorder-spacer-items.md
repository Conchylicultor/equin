# Reorder: User-Insertable Spacer Items

## Context

The toolbar currently splits items into left/right sides via a **group-boundary spacer**: contributions set `group: "namespace"` (left) or `group: "actions"` (right), and the host renders a `<div className="flex-1" />` between groups. Groups also prevent cross-group DnD — items can only be reordered within their group.

We want to replace this with a **single flat list** where users insert spacer items at arbitrary positions during edit mode. This gives full reorder freedom and user-controlled layout.

Spacers are a generic feature of the `Reorder` primitive, not toolbar-specific.

## Design

### Spacer data model — rows in `reorder_prefs`

Store spacers as regular rows in `reorder_prefs` using an ID prefix convention:

- **Prefix**: `__spacer__` (e.g. `__spacer__a1b2c3d4`)
- **Create**: `PATCH /api/reorder/:slotId` with `{ contributionId: "__spacer__<uuid>", rank }` — reuses existing upsert
- **Move**: same PATCH with updated rank — identical to moving a regular item
- **Delete**: new `DELETE /api/reorder/:slotId/:contributionId` endpoint (spacers are deleted, not hidden — they shouldn't appear in the restore popover)

No schema change needed. The `reorder_prefs` table already stores `(slot_id, contribution_id, rank, hidden)`.

### Type changes

```ts
// New exports from @plugins/reorder/web
export const SPACER_PREFIX = "__spacer__";
export type SpacerItem = { readonly id: string; readonly _spacer: true };
export function isSpacer(item: { id: string }): item is SpacerItem;

// UseAreaResult.items changes
items: (P | SpacerItem)[]   // was P[]
```

Hosts discriminate with `isSpacer(item)` before accessing `P`-specific fields.

### No default spacers

The toolbar starts with all items left-aligned (no spacer). Users add spacers manually via edit mode. This keeps the implementation simple — no `defaultSpacerAfter` config, no client-side seeding logic.

### Visual rendering

| Mode | Spacer renders as |
|------|-------------------|
| Normal | `<div className="flex-1" />` — invisible, pushes items apart |
| Edit | Dashed placeholder (`border-dashed`, muted color, drag handle, × button) |

### UX for adding/removing spacers

- **Add**: In the RestoreButton popover (already visible in edit mode), an "Add Spacer" button creates a spacer at the end of the list. User drags it to position.
- **Remove**: × button on the spacer in edit mode calls DELETE (not hide).
- **Move**: Standard DnD drag, same as any other item.

## Implementation Steps

### 1. Server: DELETE endpoint

**File**: `plugins/reorder/server/internal/handlers.ts`

Add `handleDeleteContribution(req, params)`:
- Params: `slotId`, `contributionId`
- Guard: reject if `contributionId` doesn't start with `__spacer__` (only spacers can be deleted via this endpoint)
- Query: `db.delete(_reorderPrefs).where(and(eq(slotId), eq(contributionId)))`
- Notify: `reorderPrefsResource.notify({ slotId })`

**File**: `plugins/reorder/server/index.ts`

Register: `"DELETE /api/reorder/:slotId/:contributionId": handleDeleteContribution`

### 2. `useArea`: Core logic (heaviest change)

**File**: `plugins/reorder/web/internal/use-area.tsx`

#### 2a. SpacerItem type + helpers

```ts
export const SPACER_PREFIX = "__spacer__";
export type SpacerItem = { readonly id: string; readonly _spacer: true };
export function isSpacer(item: { id: string }): item is SpacerItem {
  return item.id.startsWith(SPACER_PREFIX);
}
```

#### 2b. Update `UseAreaResult`

```ts
export type UseAreaResult<P extends BaseItem> = {
  items: (P | SpacerItem)[];    // was P[]
  hiddenItems: P[];             // unchanged — spacers never hidden
  editMode: boolean;
  DndWrapper: ComponentType<{ children: ReactNode }>;
  ReorderItem: ComponentType<{ item: P | SpacerItem; children: ReactNode }>;
};
```

#### 2c. Inject spacers in the `useMemo` sort block

After splitting visible/hidden from contributions:

1. Scan `rankMap` for keys starting with `SPACER_PREFIX` → create `SpacerItem` objects
2. Merge spacers into `visible` for sorting. Spacers get `naturalIdx = Infinity` (sort purely by rank). Spacers have no group (`getGroup` guard: `isSpacer(item) ? null : getGroup?.(item)`).

#### 2d. Update `onDrop`

The drop handler's `getGroup` call must guard for spacers: `isSpacer(item) ? null : gg?.(item)`. The sibling filter must include spacers as valid drop targets. The `excludeFromReorder` check: `isSpacer(item) ? false : !!item.excludeFromReorder`.

#### 2e. Update `ReorderItem`

Add spacer branch:

```tsx
function ReorderItem({ item, children }) {
  const editMode = useEditMode();
  if (isSpacer(item)) {
    return <SpacerReorderItem item={item} editMode={editMode} />;
  }
  if (!editMode || item.excludeFromReorder) return <>{children}</>;
  return <ReorderItemActive item={item}>{children}</ReorderItemActive>;
}
```

`SpacerReorderItem`:
- **Normal mode**: `<div className="flex-1" />`
- **Edit mode**: draggable dashed div with × delete button. Uses same `useDraggable`/`useDroppable` hooks as `ReorderItemActive`. × calls `DELETE /api/reorder/${storageId}/${item.id}`. Shows drop indicators like `ReorderItemActive`.

#### 2f. Update `RestoreButton`

Add `addSpacer` to `ReorderAreaCtxValue`. In the popover, add an "Add Spacer" button (before the Marketplace section):

```tsx
<div className="border-t border-border p-1">
  <button onClick={() => { ctx.addSpacer(); setOpen(false); }}>
    Add Spacer
  </button>
</div>
```

The `addSpacer` callback (defined in `DndWrapper`):
1. Generate ID: `__spacer__${crypto.randomUUID()}`
2. Compute rank at end: `Rank.between(maxRankInSlot, null)`
3. PATCH: `{ contributionId: id, rank }`

### 3. Web barrel exports

**File**: `plugins/reorder/web/index.ts`

Add: `export { isSpacer, SPACER_PREFIX, type SpacerItem } from "./internal/use-area";`

### 4. Shell toolbar: remove groups

**File**: `plugins/shell/web/slots.ts`

```ts
Toolbar: Reorder.area(
  defineSlot<{
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    onClick?: () => void;
    component?: ComponentType;
    group?: string;  // keep field for compat, just unused
  }>("shell.toolbar"),
  {
    getLabel: (item) => item.label ?? item.id,
    // getGroup removed → all items freely reorderable
  },
),
```

### 5. Toolbar host: remove group-boundary spacer

**File**: `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`

Import `isSpacer` from `@plugins/reorder/web`. Replace the toolbar render loop:

```tsx
{toolbarArea.items.map((item) => (
  <toolbarArea.ReorderItem key={item.id} item={item}>
    {!isSpacer(item) && (
      <PluginErrorBoundary slot={toolbarSlotId}>
        <ToolbarItem {...item} />
      </PluginErrorBoundary>
    )}
  </toolbarArea.ReorderItem>
))}
```

The group-boundary `{i > 0 && item.group !== ... && <div className="flex-1" />}` is removed entirely.

### 6. (Optional) Remove `group` from toolbar contributions

Contributions that set `group: "namespace"` or `group: "actions"` can drop the field since `getGroup` is no longer configured. Not strictly necessary — the field is just ignored.

## Verification

1. `./equin build` — deploys successfully
2. **Normal mode**: toolbar shows all items left-aligned (no spacer by default)
3. **Edit mode**: pen button → add spacer → spacer appears as dashed placeholder, draggable, × button visible
4. **Drag spacer**: drag between action buttons → persists on reload
5. **Delete spacer**: × → spacer gone, not in restore popover
6. **Add spacer**: edit mode → Add button popover → "Add Spacer" → appears at end → drag to position
7. **Multiple spacers**: two spacers split space evenly
8. **Free reorder**: drag worktree-switcher to right side (was impossible with groups)
9. **Cross-tab sync**: drag in tab 1 → tab 2 updates
10. **Sidebar unaffected**: sidebar still uses groups, no spacers injected
