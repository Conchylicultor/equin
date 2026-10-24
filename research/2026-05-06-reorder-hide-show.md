# Reorder Edit UI: hide and restore contributions

## Context

The reorder plugin (`plugins/reorder/`) provides iOS-style edit mode for reorderable slots. Currently, edit mode only allows drag-to-reorder. This extends it so that in edit mode, users can also **hide** (×) and **restore** (+) contributions — making all reorder areas dynamically customizable by default.

## Design

### Why extend reorder vs. separate plugin

The "×" button is part of `ReorderItem`'s edit-mode rendering; the "+" restore button is automatically rendered inside `DndWrapper`. No external slot contributions needed, no cycle risk, no host code changes needed. Existing hosts get the feature for free.

### Storage

Extend the existing `reorder_prefs` table with a `hidden` boolean column. Make `rank` nullable (NULL = natural order) so items can be hidden without needing a dummy rank. This keeps the composite PK `(slotId, contributionId)` as the single source of truth.

### UX

- Edit mode "×" badge (top-right of each `ReorderItem`) hides the contribution
- A dashed "+ N hidden" button appears at the end of the area when items are hidden
- Clicking "+" opens a popover listing hidden items by label; clicking restores them
- Rank is preserved on hide, so restore puts items back near their original position
- `excludeFromReorder` items cannot be hidden (same gating as drag)

---

## Implementation

### 1. Schema: nullable rank + hidden column

**`plugins/reorder/server/internal/tables.ts`**

```ts
export const _reorderPrefs = pgTable(
  "reorder_prefs",
  {
    slotId: text("slot_id").notNull(),
    contributionId: text("contribution_id").notNull(),
    rank: rankText("rank"),                              // nullable — NULL = natural order
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.slotId, t.contributionId] })],
);
```

### 2. Shared resource schema

**`plugins/reorder/shared/resource.ts`**

```ts
export const ReorderSlotPrefsSchema = z.record(
  z.string(),
  z.object({
    rank: RankSchema.optional(),
    hidden: z.boolean().optional(),
  }),
);
```

### 3. Server resource loader

**`plugins/reorder/server/internal/resource.ts`**

Select `hidden` alongside `rank`; return `{ rank?: Rank, hidden?: boolean }` per entry.

### 4. Server handlers

**`plugins/reorder/server/internal/handlers.ts`**

PATCH accepts `{ contributionId, rank?, hidden? }` — at least one of rank/hidden required:
- **Rank update** (drag): upsert with `rank`; leave `hidden` unchanged on conflict
- **Hide**: upsert with `hidden: true`; rank nullable (preserve existing if row exists)
- **Restore**: update existing row `hidden = false`

GET returns `{ [id]: { rank?, hidden } }`.

### 5. Web: `getLabel` in `ReorderConfig`

**`plugins/reorder/web/internal/area.ts`**

```ts
export type ReorderConfig<P> = {
  getGroup?: (item: P) => string | null;
  getLabel?: (item: P) => string;       // NEW
};
```

### 6. Web: `ReorderAreaContext`

**`plugins/reorder/web/internal/use-area.tsx`**

Module-level context shared by `DndWrapper`, `ReorderItemActive`, and `RestoreButton`:

```ts
type ReorderAreaCtxValue = {
  storageId: string;
  hiddenItems: BaseItem[];
  getLabel: (item: BaseItem) => string;
};
const ReorderAreaContext = createContext<ReorderAreaCtxValue | null>(null);
```

`DndWrapper` provides it (reading from refs for stable identity).

### 7. Web: split items / hiddenItems

**`plugins/reorder/web/internal/use-area.tsx`**

```ts
export type UseAreaResult<P extends BaseItem> = {
  items: P[];
  hiddenItems: P[];     // NEW
  editMode: boolean;
  DndWrapper: ComponentType<{ children: ReactNode }>;
  ReorderItem: ComponentType<{ item: P; children: ReactNode }>;
};
```

In the `useMemo`: filter out items where `rankMap[item.id]?.hidden` before sorting. Compute `hiddenItems` as the complement (excluding `excludeFromReorder` items).

### 8. Web: "×" button in `ReorderItemActive`

Small absolute-positioned badge (top-right, `bg-destructive`). `onPointerDown` with `stopPropagation` prevents dnd-kit drag. Fires `PATCH /api/reorder/${storageId}` with `{ contributionId: item.id, hidden: true }`.

### 9. Web: `RestoreButton` in `DndWrapper`

Rendered after `{children}` when `editMode && hiddenItems.length > 0`. Dashed-border button showing "+ N hidden". Popover lists hidden items by label (`getLabel`); clicking one fires `PATCH` with `{ contributionId, hidden: false }`.

### 10. Slot owners: provide `getLabel`

- `plugins/shell/web/slots.ts` — `Shell.Sidebar: getLabel: item => item.title`
- `plugins/shell/web/slots.ts` — `Shell.Toolbar: getLabel: item => item.label ?? item.id`
- `plugins/apps/web/slots.ts` — `Apps.App: getLabel: item => item.tooltip`
- Others: fall back to `item._pluginName ?? item.id`

---

## Files to modify

| File | Change |
|------|--------|
| `plugins/reorder/server/internal/tables.ts` | Nullable rank, add hidden boolean |
| `plugins/reorder/shared/resource.ts` | Optional rank + hidden in schema |
| `plugins/reorder/server/internal/resource.ts` | Include hidden in loader |
| `plugins/reorder/server/internal/handlers.ts` | Three-op PATCH, hidden in GET |
| `plugins/reorder/web/internal/area.ts` | `getLabel` in `ReorderConfig` |
| `plugins/reorder/web/internal/use-area.tsx` | Context, item split, DndWrapper, ×, RestoreButton |
| `plugins/reorder/web/index.ts` | Verify `hiddenItems` in re-exported type |
| `plugins/shell/web/slots.ts` | Add `getLabel` to Sidebar/Toolbar |
| `plugins/apps/web/slots.ts` | Add `getLabel` to Apps.App |

---

## Edge cases

- **Hiding a never-dragged item**: rank stays NULL; restore uses natural order
- **Hiding last visible item**: area renders empty + RestoreButton
- **`excludeFromReorder` items**: no "×" shown, excluded from hiddenItems
- **Multiple subId hosts**: each DndWrapper has its own storageId in context; scoped correctly
- **Migration on forked DBs**: `hidden DEFAULT false` is safe; `DROP NOT NULL` on rank is safe (all existing rows have a rank)

---

## Verification

1. `./equin build` — migration + rebuild
2. Enter edit mode → "×" badges appear on reorderable items
3. Click "×" → item hidden, "+ N hidden" button appears
4. Click "+" → popover shows item label → click restores it
5. Rank preserved: restore puts item near its original position
6. Exit edit mode → hidden items stay hidden, "+" disappears
7. Refresh → state persists (DB-backed push resource)
8. Second tab → hide propagates via resource push within ~50ms
