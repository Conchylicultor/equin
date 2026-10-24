# Conversation groups (drag-to-group in the conversation list)

## Context

The sidebar conversation list is a flat shadcn `SidebarMenu` rendered by
`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`.
The only existing "grouping" is implicit fork-grouping by `attemptId` (forks of
the same root nest as `SidebarMenuSub` rows beneath the root).

The user wants a manual organizing layer on top of this: drag conversation A
onto conversation B and a labeled box appears containing both. Subsequent drags
add to existing boxes. This is the first user-driven structure on the
conversation list, and we want it to be a solid, persisted primitive — not
local UI state.

Decisions confirmed with user:

- **Group is a named, persisted entity.** Has its own row, renameable inline,
  survives reload, can be empty.
- **Drop A onto B (B already in group G) → A joins G.** Standard "drag into
  folder" UX.
- **Flat — one level of grouping.** A conversation is in at most one group; no
  nested groups. Existing fork-grouping (attempt-based) stays as-is *inside*
  whatever group the root is in.
- **Active conversations only.** Gone conversations are auto-removed from
  their group (cascade) and stay in the flat "recent gone" section.

## Recommended approach

A new sub-plugin under the conversations umbrella owns the entire group
domain: schema, server endpoints, live-state resource, and the grouped list
UI. The existing `conversations-view` keeps the sidebar contribution but
delegates list rendering to a component exported by the new plugin.

### New plugin: `plugins/conversations/plugins/conversation-groups/`

Layout (one barrel per runtime, per the plugin boundary rules):

```
plugins/conversations/plugins/conversation-groups/
├── package.json
├── CLAUDE.md
├── shared/
│   └── index.ts              # ConversationGroup type + Zod schemas + groupsResource descriptor
├── server/
│   ├── index.ts              # barrel: re-exports + definePlugin (routes registration)
│   └── internal/
│       ├── tables.ts         # _conversationGroups + _conversationGroupMembers
│       ├── repo.ts           # listGroupsWithMembers, createGroup, addMember, removeMember, etc.
│       ├── routes.ts         # POST/PATCH/DELETE /api/conversation-groups...
│       └── on-gone.ts        # subscribes to status-change → drops member when status='gone'
└── web/
    ├── index.ts              # exports GroupedConversationList, useConversationGroups
    └── components/
        ├── grouped-conversation-list.tsx   # replaces the current list body
        ├── group-box.tsx                   # collapsible labeled box
        ├── draggable-row.tsx               # wraps ConversationItem with useDraggable+useDroppable
        └── group-rename.tsx                # inline rename via useEditableField
```

### Schema (new tables, owned by this plugin)

`server/internal/tables.ts`:

```ts
export const _conversationGroups = pgTable("conversation_groups", {
  id:        text("id").primaryKey(),                  // "cgrp-<ts>-<hex>"
  title:     text("title").notNull(),
  expanded:  boolean("expanded").notNull().default(true),
  rank:      rankText("rank").notNull(),               // ordering of groups themselves
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const _conversationGroupMembers = pgTable(
  "conversation_group_members",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => _conversations.id, { onDelete: "cascade" }),  // cross-table FK; import from tasks-core
    groupId: text("group_id")
      .notNull()
      .references(() => _conversationGroups.id, { onDelete: "cascade" }),
    rank: rankText("rank").notNull(),                  // ordering within group
    createdAt: timestamp(...).defaultNow().notNull(),
  },
  (t) => [index("cgm_group_rank_idx").on(t.groupId, t.rank)],
);
```

`conversation_id` is the PK so each conversation is in at most one group
(matches the "flat" decision). `ON DELETE CASCADE` on the conversation FK
means a deleted conversation auto-drops its membership; on the group FK it
means deleting a group cleans up memberships.

Reuses `rankText` from `@server/db/types` (same fractional-indexing string
type used by `_tasks.rank`). No changes needed in `tasks-core`.

> **Migration step:** run `./equin build` after writing the schema —
> drizzle-kit picks up the new tables and emits a migration; commit it.
> Never run `drizzle-kit generate` manually (per CLAUDE.md).

### API (server/internal/routes.ts)

All endpoints push to `conversationGroupsResource` after the transaction.

- `POST   /api/conversation-groups` — body `{ title?: string, conversationIds: string[] }`. Creates a group at the next rank, inserts members at sequential ranks. Returns the new group + membership rows. **This is the "drop A onto B" call when neither is already grouped.** Title defaults to the first conversation's title (or "Group").
- `PATCH  /api/conversation-groups/:id` — body `{ title?, expanded?, rank? }`. Inline rename, collapse toggle, group reorder.
- `DELETE /api/conversation-groups/:id` — deletes group; FK cascade drops memberships.
- `POST   /api/conversation-groups/:id/members` — body `{ conversationId }`. Adds member at end of group. **This is the "drop A onto B" call when B is already in a group, and the "drop A onto group header" call.** Replaces any pre-existing membership for `conversationId` (one-line upsert on the PK).
- `DELETE /api/conversation-groups/members/:conversationId` — removes member; group remains (per "can be empty" decision).
- `PATCH  /api/conversation-groups/members/:conversationId` — body `{ groupId, rank }`. Move/reorder a single member. Reuse the upsert path for cross-group moves.

Mutations live in `repo.ts`, follow the `tasks-core/internal/mutations/cross-table.ts` convention: a single `db.transaction(...)`, then resource notifications *after* commit.

### Live-state resource

`shared/index.ts`:

```ts
export const conversationGroupsResource = resourceDescriptor<{
  groups: ConversationGroup[];          // ordered by rank
  members: { conversationId: string; groupId: string; rank: string }[];
}>("conversation-groups");
```

Push semantics match `recentConversationsResource` — single payload notified on every mutation. Volume is tiny (groups + ~one row per active conversation), so a full snapshot per change is fine and matches the existing pattern.

### Lifecycle: conversation goes gone → drop membership

`server/internal/on-gone.ts` subscribes to `taskStatusChanged` / status writes. The cleanest hook is in the existing `markConversationClosed` path — but since that's in `tasks-core`, do this without modifying `tasks-core`:

- Subscribe via `defineTriggerEvent`/`trigger` (the events plugin) to `taskStatusChanged` filtered on `status='gone'`, or simpler: use a small `defineJob` triggered on the conversation status-change event already emitted by tasks-core. The job deletes the membership row and notifies the resource.

This keeps the boundary clean — `conversation-groups` reacts to status events without `tasks-core` knowing groups exist.

### Web: rendering + DnD

The current `conversation-list.tsx` already builds `attemptGroups` for forks. Wrap that logic so it runs *inside* each group, not at the top level.

`useConversationGroups()` returns:

```ts
{
  groups: ConversationGroupWithMembers[];   // [{ id, title, expanded, members: convId[] }, ...] sorted by rank
  groupIdByConvId: Map<string, string>;
  ungroupedActive: ConversationEntry[];     // conversations in `active` not in any group
}
```

The new `GroupedConversationList` component composes:

```
<DndContext sensors=[PointerSensor distance=4]>
  {groups.map(g => <GroupBox key={g.id} group={g} convs={g.members.map(...)} />)}
  {ungroupedActive.map(conv => <DraggableRow conv={conv} />)}
  {recentGone.map(renderItem)}                        // unchanged, no DnD
  {paginatedItems.map(renderItem)}                    // unchanged
</DndContext>
```

`conversations-view/web/components/conversation-list.tsx` changes minimally: replaces the `<SidebarMenu>{...}</SidebarMenu>` body with `<GroupedConversationList active={...} system={...} showSystem={...} recentGone={...} ... />` from `@plugins/conversations/plugins/conversation-groups/web`. All non-group state (showSystem toggle, infinite-scroll cursor, gone pagination) stays in conversations-view.

#### `<DraggableRow>` (each ungrouped conversation, and each conversation inside a group)

Uses `@dnd-kit/core` directly (no need for the tree primitive — flat model):

- `useDraggable({ id: conv.id, data: { kind: 'conv', convId: conv.id } })` — wraps the row.
- `useDroppable({ id: 'drop-conv-' + conv.id, data: { kind: 'conv', convId: conv.id } })` — same row is also a drop target.

Visual: hover ring or `bg-accent/40` highlight when `isOver`, indicating "drop here to group".

#### `<GroupBox>` (the labeled container)

```
<div className="rounded-md border border-border/60 bg-muted/20 p-1 space-y-0.5">
  <header>
    <button onClick={toggleExpanded}>chevron</button>
    <RenameInput value={title} onCommit={...} />            // useEditableField
    <button onClick={ungroupAll}>×</button>                 // optional v2
  </header>
  {expanded && <div className="pl-2 space-y-0.5">
    {convs.map(conv => <DraggableRow conv={conv} />)}
  </div>}
</div>
```

The header div *itself* is a `useDroppable({ id: 'drop-group-' + group.id, data: { kind: 'group', groupId: group.id } })` — drop a conversation anywhere on the box to add to that group.

The `<RenameInput>` uses `useEditableField` from `@plugins/primitives/plugins/editable-field/web` (debounced autosave + flush-on-blur, already used by task headers).

#### Drop dispatch (single `onDragEnd` in `<DndContext>`)

```ts
function onDragEnd({ active, over }) {
  if (!over) return;
  const draggedId = active.data.current?.convId;
  const target    = over.data.current;          // { kind: 'conv', convId } | { kind: 'group', groupId }
  if (!draggedId || !target) return;
  if (target.kind === 'conv' && target.convId === draggedId) return;

  if (target.kind === 'group') {
    // join group
    fetch(`/api/conversation-groups/${target.groupId}/members`, { method: 'POST', body: { conversationId: draggedId } });
    return;
  }

  // target.kind === 'conv'
  const targetGroupId = groupIdByConvId.get(target.convId);
  if (targetGroupId) {
    // join target's group
    fetch(`/api/conversation-groups/${targetGroupId}/members`, { method: 'POST', body: { conversationId: draggedId } });
  } else {
    // create a new group with both
    fetch(`/api/conversation-groups`, { method: 'POST', body: { conversationIds: [target.convId, draggedId] } });
  }
}
```

Drop *out* of a group (for v1) is via the small `×` button on each row inside a group (calls `DELETE /api/conversation-groups/members/:convId`). Drag-out can be a v2 — the user explicitly approved persisted, named groups, so a click-to-ungroup affordance is sufficient and avoids the "where is the user dropping it?" ambiguity that would force us to model an "ungrouped well" drop zone.

### Plugin registration

- Add `"conversation-groups"` to `web/src/plugins.ts` and `server/src/plugins.ts`.
- Update `plugins-doc-in-sync` runs as part of `./equin build`; the plugin's `CLAUDE.md` autogen block is regenerated automatically.

## Files to create

- `plugins/conversations/plugins/conversation-groups/package.json`
- `plugins/conversations/plugins/conversation-groups/CLAUDE.md` (autogen block + a short prose section about drop semantics)
- `plugins/conversations/plugins/conversation-groups/shared/index.ts`
- `plugins/conversations/plugins/conversation-groups/server/index.ts`
- `plugins/conversations/plugins/conversation-groups/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-groups/server/internal/repo.ts`
- `plugins/conversations/plugins/conversation-groups/server/internal/routes.ts`
- `plugins/conversations/plugins/conversation-groups/server/internal/on-gone.ts`
- `plugins/conversations/plugins/conversation-groups/web/index.ts`
- `plugins/conversations/plugins/conversation-groups/web/components/grouped-conversation-list.tsx`
- `plugins/conversations/plugins/conversation-groups/web/components/group-box.tsx`
- `plugins/conversations/plugins/conversation-groups/web/components/draggable-row.tsx`
- `plugins/conversations/plugins/conversation-groups/web/components/group-rename.tsx`

## Files to modify

- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — replace the `<SidebarMenu>` body with `<GroupedConversationList .../>`. Keep all surrounding state (showSystem, gone pagination, sentinel observer, navigation, close handler).
- `plugins/conversations/plugins/conversations-view/package.json` — add `@plugins/conversation-groups` workspace dep.
- `web/src/plugins.ts` — register `conversationGroupsPlugin` (default import).
- `server/src/plugins.ts` — register the server plugin.

## Reused primitives (no new infrastructure)

- `@dnd-kit/core` — already in root `package.json` (used by `primitives/tree`).
- `useEditableField` from `@plugins/primitives/plugins/editable-field/web` — for inline group rename.
- `rankText` + `findNextRankUnder`-style fractional rank pattern from `tasks-core` (re-implement a small helper inside the plugin since `findNextRankUnder` is task-specific; the algorithm is `generateKeyBetween(prev, null)` from `fractional-indexing`).
- `defineTriggerEvent` / `trigger` / `defineJob` from `@plugins/infra/plugins/{events,jobs}/server` — for the gone-cascade reaction.
- `resourceDescriptor` from `@plugins/primitives/plugins/live-state` — for the live-state push.
- The cross-table mutation pattern in `plugins/tasks-core/server/internal/mutations/cross-table.ts` — copy the `db.transaction` + post-commit `notify()` shape.

## Out of scope for v1 (call out and defer)

- **Reordering inside a group, and reordering groups themselves.** Schema supports it (rank columns), API endpoint supports it (`PATCH .../members/:id` with new rank); UI hooks for before/after drop zones and a separate group-reorder handle are deferred. Default ordering is insertion order (oldest membership first within a group; oldest group first overall).
- **Drag-out-of-group via DnD.** Use the per-row `×` ungroup button instead. Adding a true "ungrouped" drop zone is feasible but adds visual noise.
- **Showing gone conversations inside groups.** They're auto-cascaded out on `gone` and live in the existing flat recent-gone section.

## Verification

1. `./equin build` from this worktree — confirms the migration is generated, cleared, the build succeeds, gateway is notified.
2. Open `http://att-1777490382-j0lv.localhost:9000/`. Sidebar conversation list renders unchanged for a user with zero groups.
3. **Create-by-drop:** drag any active conversation onto another. Expected: a labeled box appears containing both. Title defaults to first conv's title. Persists across reload.
4. **Join-by-drop:** drag a third conversation onto either member of the box (or onto the box header). Expected: it joins the existing group, no new group created.
5. **Rename:** double-click the group title, type a new name, blur. Expected: title persists; verify by reload and by inspecting `_conversationGroups.title` directly.
6. **Collapse/expand:** chevron toggles `expanded`; persists across reload.
7. **Ungroup:** click the per-row `×` ungroup button. Expected: conversation returns to ungrouped section; group remains (possibly empty).
8. **Empty group survives:** drag the last member out — group stays in the list (per the "named, persisted entity" decision). `DELETE /api/conversation-groups/:id` removes it cleanly.
9. **Gone cascade:** close (`×` close action) a grouped conversation. Expected: row disappears from group within ~1s (live-state push), conversation appears in recent-gone, `_conversationGroupMembers` row is gone in DB.
10. **Multi-browser sync:** open the app in a second tab; mutations from tab 1 should appear in tab 2 within the next push tick (verifies the resource notify path).
11. **Forks behave inside groups:** group a conversation that has forks. Expected: forks still nest under their root inside the group box, indented as `SidebarMenuSub` rows (existing fork-grouping logic preserved).
12. Use the scripted Playwright helper at `e2e/screenshot.mjs` to capture before/after of the drag — pass `--url http://att-1777490382-j0lv.localhost:9000/` and verify the box is rendered.

## Critical files referenced

- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — current list, integration point.
- `plugins/tasks-core/server/internal/tables.ts` — `_conversations` table; FK target.
- `plugins/tasks-core/server/internal/mutations/cross-table.ts` — transaction + post-commit notify pattern.
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` and `use-tree-row.tsx` — reference DnD wiring with `@dnd-kit/core` (we don't depend on TreeList itself, just mirror its sensor/onDragEnd shape).
- `plugins/primitives/plugins/editable-field/web/index.ts` — inline rename hook.
- `server/db/types.ts` — `rankText` column type.
- `web/src/plugins.ts`, `server/src/plugins.ts` — plugin registration.
