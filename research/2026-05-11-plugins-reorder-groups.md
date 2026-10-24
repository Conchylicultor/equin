# Reorder Groups — Phase 1

## Context

The reorder plugin currently supports flat ordering of slot contributions with optional static group partitioning (via `getGroup`). Users can reorder items within a static group, add spacers, and hide items. But there's no way to create ad-hoc visual groupings of items.

This design adds **user-created groups** to reorderable areas. Users can drag items onto each other to form groups, drag items in/out of groups, and reorder groups as units. Groups render as bordered boxes with editable titles and expand/collapse. This mirrors the proven UX from the conversation sidebar's grouping system, generalized to any reorder area.

Phase 2 (future) will add a `Reorder.GroupRenderer` slot so sub-plugins can provide alternative group renderings (card, collapsed menu, etc.). Phase 1 hardcodes a single default renderer.

## Data model

### New table: `reorder_groups`

```
reorder_groups
  id          TEXT PRIMARY KEY               -- "rgrp-<timestamp>-<random>"
  slot_id     TEXT NOT NULL                  -- scopes to reorder area (matches reorder_prefs.slot_id)
  title       TEXT NOT NULL DEFAULT 'Group'
  rank        rank_text NOT NULL             -- top-level ordering (interleaved with ungrouped items)
  expanded    BOOLEAN NOT NULL DEFAULT true
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  INDEX: (slot_id, rank)
```

### New table: `reorder_group_members`

```
reorder_group_members
  slot_id          TEXT NOT NULL
  contribution_id  TEXT NOT NULL
  group_id         TEXT NOT NULL REFERENCES reorder_groups(id) ON DELETE CASCADE
  rank             rank_text NOT NULL         -- within-group ordering
  PRIMARY KEY (slot_id, contribution_id)      -- one group per item per slot
  INDEX: (group_id, rank)
```

Key decisions:
- **Per-slot scope**: Groups are scoped to `storageId` (i.e. `slot.id` or `${slot.id}:${subId}`). A sidebar group can't contain toolbar items.
- **No FK to `reorder_prefs`**: Items may not have a `reorder_prefs` row yet (unranked items). Membership is independent.
- **Composite PK** on members enforces one-group-at-a-time per slot.
- **Static group constraint** (`getGroup`): enforced client-side in drag handlers, not at DB level. Items in a user group must share the same `getGroup` value.

### Rank interleaving

Top-level ordering mixes two rank sources:
- Ungrouped items: `reorder_prefs.rank` (fallback: natural registration order)
- Groups: `reorder_groups.rank`

Both use the same fractional-indexing strings (byte-ordered), so they sort correctly together without coordination.

## New sub-plugin: `plugins/reorder/plugins/groups/`

### File structure

```
plugins/reorder/plugins/groups/
  shared/
    index.ts                    -- barrel: schemas + resource descriptor
    internal/
      schemas.ts                -- Zod schemas, types, resourceDescriptor
  server/
    schema.ts                   -- re-exports tables for migration scanner
    index.ts                    -- ServerPluginDefinition: routes + resource
    internal/
      tables.ts                 -- _reorderGroups, _reorderGroupMembers
      resource.ts               -- defineResource("reorder.groups", ...)
      repo.ts                   -- DB mutation functions
      routes.ts                 -- HTTP handlers
```

No `web/` directory on the sub-plugin. Web components live in the parent's `web/internal/` (see below) — the sub-plugin is server-only. The parent imports types from `@plugins/reorder/plugins/groups/shared`.

### Server API routes

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/api/reorder/:slotId/groups` | `{ title?, contributionIds? }` | Create group (optionally with initial members) |
| PATCH | `/api/reorder/groups/:id` | `{ title?, expanded?, rank? }` | Update group |
| DELETE | `/api/reorder/groups/:id` | — | Delete group (cascade removes members) |
| POST | `/api/reorder/groups/:id/members` | `{ slotId, contributionIds }` | Add members to existing group |
| DELETE | `/api/reorder/:slotId/groups/members/:contributionId` | — | Remove one member |

### Resource

`reorderGroupsResource` — push resource parameterized by `{ slotId }`. Payload: `{ groups: ReorderGroup[], members: ReorderGroupMember[] }`. Notified after every mutation. Client subscribes via `useResource(reorderGroupsResource, { slotId })`.

### Repo functions

Follow the conversation-groups repo pattern (`plugins/conversations/.../grouped/server/internal/repo.ts`):

- `createGroup({ slotId, title?, contributionIds? })` — insert group with `Rank.between(lastGroupRank, null)` scoped to slot, optionally insert members
- `addMembersToGroup(groupId, slotId, contributionIds)` — upsert members with conflict on PK; rank via `Rank.between(lastMemberRank, null)` within group
- `removeMember(slotId, contributionId)` — delete membership row
- `updateGroup(id, patch)` — partial update (title/expanded/rank)
- `deleteGroup(id)` — hard delete, FK cascade cleans members

## Web changes: `plugins/reorder/web/internal/`

### New files

- `group-box.tsx` — Bordered group container with editable title, expand/collapse, drag handle (edit mode), delete button (edit mode), and droppable for join-group
- `group-rename.tsx` — Editable title input using `useEditableField` (same pattern as `plugins/conversations/.../grouped/web/components/group-rename.tsx`)

### `area.ts` changes

Add `enableGroups?: boolean` to `ReorderConfig`:

```ts
export type ReorderConfig<P> = {
  getGroup?: (item: P) => string | null;
  getLabel?: (item: P) => string;
  enableGroups?: boolean;  // NEW
};
```

Hosts that don't opt in see zero behavioral change.

### `use-area.tsx` changes

#### New types in `UseAreaResult`

```ts
export type ReorderGroup = {
  id: string;
  title: string;
  expanded: boolean;
  rank: Rank;
};

export type GroupEntry<P> = {
  kind: "group";
  group: ReorderGroup;
  members: (P | SpacerItem)[];
};

export type TopLevelEntry<P> = P | SpacerItem | GroupEntry<P>;
```

New fields on `UseAreaResult<P>`:
- `groupedEntries: TopLevelEntry<P>[]` — groups and ungrouped items interleaved by rank
- `GroupBox: ComponentType<{ group: ReorderGroup; children: ReactNode }>` — bound to context (storageId, editMode, dragInProgress)

Existing fields (`items`, `entries`, `hiddenItems`, `editMode`, `DndWrapper`, `ReorderItem`) are unchanged. `items` returns the flat list with group members inlined at their group's position.

#### Three-zone droppables (only when `enableGroups`)

When `enableGroups` is true, `ReorderItemActive` registers three `useDroppable` calls per item instead of one (mirroring `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx`):

| Zone | Droppable ID | DOM | Visual feedback |
|------|-------------|-----|-----------------|
| before | `reorder-drop-before-${id}` | 8px absolute strip at top | 2px primary line (existing `.reorder-drop-indicator`) |
| after | `reorder-drop-after-${id}` | 8px absolute strip at bottom | 2px primary line |
| child | `reorder-drop-child-${id}` | Center zone (full row) | `ring-1 ring-primary/40 bg-accent` |

When `enableGroups` is false, keep the current single-droppable behavior unchanged.

The before/after strips use `pointer-events-none` — `pointerWithin` resolves them by smallest bounding rect, same as the tree primitive.

#### `onDragEnd` dispatcher

Expanded to handle drop zone data:

```
if dragData is a group drag:
  → reorder group (compute rank between neighbors)

if dropZone is "before" or "after":
  → reorder item (existing logic, handles ungroup if item was in a group)

if dropZone is "child":
  if target is in a group → join that group
  if target is ungrouped → create new group with both items

if dropZone is "group-join" (group header):
  → add item to that group
```

Static group constraint: before any group operation, check `getGroup(dragged) === getGroup(target)` (or `getGroup(firstMember)` for existing groups). Silently no-op on mismatch.

Ungrouping: when an item inside a group is dropped on a before/after zone of a top-level item, the handler detects the item is grouped (via membership map), calls `removeMember`, then applies the new rank.

#### `GroupBox` component

Rendered by hosts iterating `groupedEntries`:

```tsx
{groupedEntries.map(entry => {
  if ('kind' in entry && entry.kind === "group") {
    return (
      <GroupBox key={entry.group.id} group={entry.group}>
        {entry.members.map(item => (
          <ReorderItem key={item.id} item={item}>
            {renderItem(item)}
          </ReorderItem>
        ))}
      </GroupBox>
    );
  }
  return (
    <ReorderItem key={entry.id} item={entry}>
      {renderItem(entry)}
    </ReorderItem>
  );
})}
```

`GroupBox` internals:
- `useDroppable` on the container for join-group drops
- `useDraggable` on drag handle (edit mode only) for group reordering
- Editable title via `GroupRename` (always editable, not just in edit mode — matches conversation groups)
- Expand/collapse chevron; collapses during any drag for reachability (`dragInProgress` from context)
- Delete button (edit mode only) — dissolves group, members return to top level
- Empty state: "Drop items here" placeholder

#### `RestoreButton` addition

New "Add Group" button in the popover (between hidden items list and "Add Spacer"):

```
[+ Add Group]      -- creates empty group at end of list
[+ Add Spacer]     -- existing
```

#### Context extension

`ReorderAreaCtxValue` gains:
- `addGroup: () => void`
- `dragInProgress: boolean`
- `membershipMap: Map<string, string>` — `contributionId → groupId`

### `reorder.ts` update

```ts
export const Reorder = { area, useArea };
```

No change needed — `useArea` already returns the new fields.

### `index.ts` barrel update

Export new types: `ReorderGroup`, `GroupEntry`, `TopLevelEntry`.

## Implementation order

1. **Sub-plugin server**: tables, resource, repo, routes, plugin definition
2. **Shared schemas**: Zod schemas + resource descriptor
3. **`area.ts`**: Add `enableGroups` to `ReorderConfig`
4. **`use-area.tsx`**: Subscribe to groups resource, compute `groupedEntries`, extend context, new `GroupBox` return field
5. **Three-zone droppables**: Split `ReorderItemActive` into before/after/child zones (conditional on `enableGroups`)
6. **`onDragEnd` dispatcher**: Handle child zone → group creation/join, ungroup on cross-boundary before/after
7. **`group-box.tsx` + `group-rename.tsx`**: Group container component
8. **RestoreButton**: Add "Add Group" button
9. **`./equin build`** to generate migration and verify
10. **Test**: Enable groups on Shell.Sidebar, create/dissolve groups, verify reorder

## Edge cases

- **Spacers and groups**: Spacers (`__spacer__` prefix) are not groupable. Skip group-creation logic for spacers; don't register child-zone droppable on `SpacerReorderItem`.
- **Empty groups persist**: Deleting last member does not auto-delete the group. User deletes explicitly via x button.
- **Cross-subId isolation**: Shell.Sidebar's three sub-areas (`buttons`, `pinned-panes`, `scroll-panes`) each have independent group namespaces. A group in `buttons` can't contain a `scroll-panes` item.
- **Item leaves group**: When removed from a group, the item's `reorder_prefs.rank` determines its top-level position. If it has no rank, it falls to natural order.
- **Dual notifications**: Group mutations notify `reorderGroupsResource`; if item ranks also change, additionally notify `reorderPrefsResource`. Both subscribed independently by the client.

## Verification

1. `./equin build` — generates migration, builds successfully
2. Enable `enableGroups: true` on `Shell.Sidebar` in `plugins/shell/web/slots.ts`
3. Enter edit mode (pen button)
4. Drag a sidebar item onto another → group created with both items
5. Verify group title is editable, expand/collapse works
6. Drag another item into the group → joins
7. Drag an item out of the group → returns to top level
8. Delete group via x → items return to top level
9. "Add Group" from restore popover → empty group appears
10. Reorder group by dragging its handle
11. Verify existing consumers (toolbar, action-bar, detail-sections) are unaffected
12. Refresh page → groups persist
