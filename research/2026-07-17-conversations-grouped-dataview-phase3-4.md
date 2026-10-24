# Phase 3 (rest) + Phase 4 — **Grouped** as a DataView tree, then delete `classic`

> Detailed sub-plan closing out
> `research/2026-06-29-global-conversations-dataview-migration.md`.
> Mirrors the shape of `research/2026-07-02-conversations-queue-dataview-phase3.md`
> (the Queue tab), which is the working precedent for everything structural here.

## Context

The conversations sidebar body is a `variant-region` with two variants: `classic`
(the bespoke `defineTabbedView` Queue/Grouped/History tabs) and `dataview`. Phase 1
migrated History; Phase 3's first half migrated the Queue. The `dataview` variant
today hosts **Queue + History only** — a user who wants Grouped must flip back to
`classic`, which is the sole reason `classic` still exists.

This plan does the remaining two things:

1. **Grouped as a DataView tree** (`data-view/plugins/grouped/`) — the last tab, and
   the north star's "closest natural fit to the primitive as it already exists"
   (`group → conversations`, both ranked, via `HierarchyConfig`).
2. **Phase 4 cutover + deletion** — `dataview` becomes the only way to render the
   sidebar; `classic/` and the three bespoke web tabs are deleted, and the
   variant-region collapses.

Same principle as every prior phase: **duplicate presentation, not data.** The
`conversation_groups` / `conversation_group_members` tables, the
`conversation-groups` resource, and the group CRUD endpoints stay exactly where they
are under `conversations-view/plugins/grouped/{server,shared}`.

**Intended outcome:** the sidebar renders entirely through the DataView primitive,
the bespoke conversation-list code is gone, and the sidebar is a first-class data
surface with search/filter/sort/group-by for free.

---

## 0. Prerequisite — promote `grouped/shared/` → `grouped/core/`

**This is the one blocking data-layer change, and it is not optional.**

`grouped/` never got the `shared/ → core/` migration the queue got. Its resource
descriptor and endpoint definitions live in
`plugins/conversations/plugins/conversations-view/plugins/grouped/shared/`, which is
**plugin-private** (CLAUDE.md R10: cross-plugin imports from `shared/` are
forbidden). The new sibling plugin under `data-view/plugins/grouped/` is a
*different plugin*, so it cannot reach any of it. Today the only public surface is
`server/index.ts` (tables + `addMemberToGroup`, consumed by `improve`).

Mirror `queue/core/` byte-for-byte:

| From | To |
| --- | --- |
| `grouped/shared/internal/schemas.ts` | `grouped/core/internal/schemas.ts` |
| `grouped/shared/endpoints.ts` | `grouped/core/endpoints.ts` |
| `grouped/shared/index.ts` | `grouped/core/index.ts` |

`grouped/core/index.ts` re-exports exactly what `shared/index.ts` does today —
`ConversationGroup`, `ConversationGroupMember`, `ConversationGroupsPayload`, the
three zod schemas, `conversationGroupsResource`, and the five endpoints
(`createConversationGroup`, `patchConversationGroup`, `deleteConversationGroup`,
`addConversationGroupMembers`, `removeConversationGroupMember`). Update the two
relative importers (`grouped/server/index.ts`, `grouped/web/components/*` — the
latter dies in Phase 4 anyway). `git mv` so history follows.

Nothing else needs promoting: `useTaskAutoGroups` is being rewritten in the new
plugin (§2), and the classic components are deleted, not reused.

### 0b. One new endpoint — `moveConversationGroupMember`

Classic has **no drag-to-reorder within a group** — `addMembersToGroup` only ever
appends via `nextRankUnder`. The tree view renders before/after sibling drop zones
**unconditionally** whenever `hierarchy.onMove` is supplied, so a user *will* drag a
member between two members. Silently no-oping that violates "fail loudly"; the
honest fix is to make the affordance real.

Add to `grouped/core/endpoints.ts` + `grouped/server/internal/{routes,repo}.ts`,
mirroring `reorderQueue`'s neighbor-based shape:

```ts
export const moveConversationGroupMember = defineEndpoint({
  route: "POST /api/conversation-groups/members/:conversationId/move",
  body: z.object({ targetId: z.string().min(1), zone: z.enum(["before", "after"]) }),
});
```

Server resolves the rank against the **complete** sibling set
(`computeFlatReorder` over the group's members) — the client never mints a member
rank, per the rank primitive's filtered-projection rule.

### 0c. Relax `createConversationGroup` to allow an empty group

`CreateGroupBodySchema.conversationIds` is `.min(1)` today because classic only ever
creates groups from a drag. The tree's native create affordance
(`HierarchyConfig.onCreate` → root "New group" button) creates an **empty** group and
auto-opens its label into rename via the tree primitive's pending-focus signal —
strictly better than classic's dashed drop zone. Groups already persist when empty
(`tables.ts`: *"Groups persist even when empty — the user explicitly removes them"*)
and `GroupBox` already has an empty state, so empty groups are an established valid
state. Change `.min(1)` → `.min(0)` and default `conversationIds` to `[]`.

---

## 1. The new plugin — `data-view/plugins/grouped/`

Mirror the Queue sibling exactly:

```
plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/grouped/
├── CLAUDE.md
├── package.json
└── web/
    ├── index.ts
    └── components/
        ├── sidebar-grouped.tsx       ← the <DataView> wiring
        ├── grouped-fields.ts         ← FieldDef<GroupedRow>[]
        ├── grouped-item-actions.tsx  ← defineItemActions + action components
        ├── use-grouped-rows.ts       ← resources → flat GroupedRow[]
        └── use-auto-groups.ts        ← ported union-find derivation
```

`web/index.ts` (mirroring `data-view/plugins/queue/web/index.ts`):

```ts
SidebarDataView.View({
  id: "grouped",
  title: "Grouped",
  icon: MdGroupWork,     // same icon the classic tab uses
  order: 8,              // between queue (5) and history (10) — classic's Q/G/H order
  component: SidebarGroupedBody,
}),
GroupedItemActions({ id: "remove-from-group", component: RemoveFromGroupAction }),
GroupedItemActions({ id: "delete-group",      component: DeleteGroupAction }),
GroupedItemActions({ id: "close",             component: CloseAction }),
```

Config: `defineDataView("conversations-sidebar-grouped")` in `sidebar-grouped.tsx`,
with the authored config at
`config/conversations/conversations-view/data-view/grouped/conversations-sidebar-grouped.jsonc`
(the `data-view:configs-authored` check requires it):

```jsonc
{ "views": [ { "id": "grouped", "name": "Grouped", "view": { "type": "tree" } } ] }
```

> **Ship the default in `.origin.jsonc`, not just `.jsonc`.** The Queue tab has a
> latent bug worth not repeating: its `groupBy: "section"` default lives **only** in
> the local `conversations-sidebar-queue.jsonc`; the committed
> `.origin.jsonc` is `{"views": []}`, so a fresh user gets an ungrouped queue. File
> that as a separate fix; make sure Grouped's `.origin.jsonc` carries the view.

### The row model — a discriminated union

The tree's `getParentId` resolves parent ids against **rows in the same array**
(`buildTree`'s `byId.has(parentId)`; an unresolved parent silently makes the row a
root). So groups must be rows. `TRow` becomes a union — this is legitimate primitive
usage, not a workaround: `HierarchyConfig` is generic over one `TRow` and every
accessor dispatches on the discriminant.

```ts
type GroupedRow =
  | { kind: "group";      id: string; title: string; parentId: null; rank: Rank; expanded: boolean; count: number }
  | { kind: "auto-group"; id: string /* `auto:${clusterKey}` */; title: string; parentId: null; rank: Rank;
      expanded: boolean; rootConvIds: string[] }
  | { kind: "bucket";     id: "bucket:ungrouped" | "bucket:closed"; title: string; parentId: null; rank: Rank; expanded: boolean }
  | { kind: "conv";       id: string; parentId: string /* group | auto-group | bucket id */; rank: Rank; conv: Conversation; groupId: string | null }
  | { kind: "fork";       id: string; parentId: string /* root conv id */; rank: Rank; conv: Conversation };
```

Root order (minted with `Rank.nBetween(null, null, n)` in emit order): user groups
(by `group.rank`) → auto-groups → `Ungrouped` → `Closed`.

**Ranks for synthetic rows are minted, not borrowed** — the exact precedent the tree
already documents for alias nodes. A minted rank is projection-local, therefore the
consumer **must be endpoint-based** (`dest.targetId` / `dest.zone`), never
`dest.rank`. This is already the sanctioned contract for any filtered projection.

`use-grouped-rows.ts` combines `conversationGroupsResource` (`grouped/core`),
`tasksResource` (`tasks/tasks-core/core`) and `useConversations()`
(`@plugins/conversations/web`) through `useCombinedResources`, gates on `pending`
(classic deliberately blocks on *both* resources to avoid classifying from a
half-loaded snapshot — keep that), reproduces the attempt/fork collapse and the
group/ungrouped partition, runs `useAutoGroups`, and emits the flat `GroupedRow[]`.

### `<DataView>` wiring (`SidebarGroupedBody`)

```tsx
<Scroll axis="y" fill className="h-full">   {/* mount point is Column scrollBody={false} */}
  <DataView<GroupedRow>
    storageKey={SIDEBAR_GROUPED_VIEW}
    rows={rows} fields={groupedFields} rowKey={(r) => r.id}
    views={["tree"]}
    loading={pending}
    selectedRowId={activeId ?? undefined}
    onRowActivate={(r) => { if (r.kind === "conv" || r.kind === "fork") onNavigate(r.conv.id); }}
    itemActions={GroupedItemActions}
    hierarchy={{
      getParentId: (r) => r.parentId,
      getRank: (r) => r.rank,
      isExpanded: (r) => r.expanded,
      onToggleExpanded,   // group → PATCH {expanded}; auto-group/bucket → localStorage
      onMove,             // the dispatch table below
      onCreate: async () => (await fetchEndpoint(createConversationGroup, {}, { body: { conversationIds: [] } })).id,
    }}
    viewOptions={{ tree: {
      renderRow: …,       // conv/fork rows → <ConversationItem conv={r.conv} />
      rowAccent,          // system tint + collapsed-with-active-child tint
      leadingIcon,        // MdCallMerge on auto-groups
      trailing,           // count badge on group rows
      dragOverlay,        // folder chip for groups, ConversationItem for convs
      addLabel: "New group",
    } }}
  />
</Scroll>
```

### `onMove` dispatch table — the whole drag surface

The tree hands `onMove(id, { parentId, rank, targetId, zone })`. A **whole-row
("child") drop** arrives as `targetId: null` + the drop target's id in `parentId`; an
**edge drop** arrives with `targetId` set and `parentId` = the target's parent. That
single distinction reproduces classic's entire `DropTarget` union — the primitive owns
the drop *geometry*, the consumer owns its *meaning*. `computeDrop`'s `child` zone
accepts **any** row as a parent (verified in `tree/core/internal/tree.ts`), so
conv-onto-conv is expressible as-is; no primitive change is needed for it.

Let `ids` = the dragged conv plus its captured auto-group siblings (classic's
"drag one, move the cluster" rule — capture at drag start so a live-state push mid-drag
can't change the set).

| Dragged | `parentId` resolves to | Action | Classic equivalent |
| --- | --- | --- | --- |
| conv | a **conv** already in group G | `addConversationGroupMembers(G, ids)` | `kind:"conv"` → join |
| conv | a **conv** not in any group | `createConversationGroup({ title: target.title \|\| "Group", conversationIds: [targetId, ...ids] })` | `kind:"conv"` → **create group** |
| conv | a **group** row | `addConversationGroupMembers(G, ids)` (no-op if all already members) | `kind:"group"` |
| conv | an **auto-group** row | `createConversationGroup({ title, conversationIds: [...rootConvIds, ...ids] })` — promote | `kind:"auto-group"` |
| conv | `bucket:ungrouped` | `removeConversationGroupMember` for each id currently grouped | `kind:"ungroup"` |
| conv | a **group**, with `targetId` set (edge drop between members) | `moveConversationGroupMember({ targetId, zone })` (§0b) | *new — classic had none* |
| conv | `null` (root, edge drop between groups) | `createConversationGroup({ conversationIds: ids })` | `kind:"new-group"` |
| group | `null` with `targetId` = another group | `patchConversationGroup(id, { rank: Rank.between(prevRank, nextRank) })`, recomputed against the **full unfiltered `groups` array**, not `dest.rank` | `kind:"group-gap"` |
| anything else | — | return (no-op) | no-op |

> Group reorder is the one place the client legitimately mints a rank — exactly as
> classic does — because the consumer holds the complete, unfiltered group list. Do
> **not** use `dest.rank`: the tree computed it over a possibly-filtered projection
> that also contains minted synthetic ranks.

---

## 2. Feature parity — every classic behavior, decided

| # | Classic behavior (file) | Verdict | Seam |
| --- | --- | --- | --- |
| 1 | Drag conv→conv creates a group (`grouped-conversation-list.tsx`) | **Ported** | `hierarchy.onMove`, `targetId: null` + `parentId` = a conv row |
| 2 | Drag conv→group joins (`…list.tsx`) | **Ported** | `onMove`, `parentId` = a group row |
| 3 | Drop on a member row joins its enclosing group (`draggable-row.tsx` id trick) | **Ported** | `onMove`: `parentId` = a conv row whose `groupId` is set → join |
| 4 | Drag conv→auto-group promotes to a real group | **Ported** | `onMove`, `parentId` = an auto-group row |
| 5 | Drag conv→"Ungrouped" bulk-ungroups the cluster | **Ported** | `onMove`, `parentId = "bucket:ungrouped"` |
| 6 | Auto-group cluster moves as one (`activeSiblingConvIds`) | **Ported** | consumer-side in `onMove`; capture siblings at drag start via `useLatestRef` |
| 7 | Group reorder via gap zones (`group-gap-zone.tsx`) | **Ported** | the tree's native before/after sibling zones |
| 8 | Group rename → `PATCH {title}` (`group-rename.tsx`) | **Ported** | `FieldDef.primary` + `onEdit` → `EditableTreeLabel` (needs **G1**, §4) |
| 9 | Auto-group rename → promotes to a real group | **Ported** | same `onEdit`, dispatching on `kind: "auto-group"` |
| 10 | Group ranks / member ranks | **Ported** | `hierarchy.getRank`; group rank client-minted, member rank server-resolved (§0b) |
| 11 | Task auto-groups (union-find over task deps, ≥2 attempt-groups, `clusterKey`, `" · "` title) | **Ported verbatim** | `use-auto-groups.ts` — copy `use-task-auto-groups.ts` unchanged, re-shaped to emit rows |
| 12 | Group `expanded` persisted server-side | **Ported** | `isExpanded` / `onToggleExpanded` → `PATCH {expanded}` |
| 13 | Auto-group / bucket expand in localStorage | **Ported** | same accessors, dispatching on `kind` |
| 14 | Delete group (label varies when non-empty) | **Ported** | `GroupedItemActions` → `deleteConversationGroup` |
| 15 | "Remove from group" row action | **Ported** | `GroupedItemActions`, rendered when `row.groupId != null` |
| 16 | "Close conversation" row action | **Ported** | `GroupedItemActions` + a module-scoped `CloseConversationContext` (the Phase-1 `CloseConvAction` pattern) |
| 17 | Count badge on group headers (hover-revealed) | **Ported** | `viewOptions.tree.trailing` |
| 18 | `hasActiveChild` tint on a collapsed group | **Ported** | `viewOptions.tree.rowAccent` |
| 19 | System-conversation row tint (`bg-muted/30`) | **Ported** | `viewOptions.tree.rowAccent` |
| 20 | Custom `DragOverlay` (folder chip / conv card) | **Ported** | `viewOptions.tree.dragOverlay` |
| 21 | Fork nesting (`[root, ...forks]`) | **Ported** | `kind: "fork"` rows with `parentId` = root conv id |
| 22 | Auto-focus rename on a **created** group | **Ported** | `hierarchy.onCreate` returns the new id → the tree's pending-focus auto-opens edit |
| 23 | Show/hide **system** conversations (eye toggle + localStorage) | **Replaced** | a `kind` enum field with `filterable: true` + a default `kind != system` filter in the authored config. The DataView filter pill *is* this control; keeping a bespoke eye button beside a filter bar is the exact duplication this migration exists to remove. |
| 24 | Dashed "Drop here to create a new group" zone (`new-group-drop-zone.tsx`) | **Replaced** | the tree's root **"New group"** button (`onCreate`, §0c) + root-edge conv drop (row 7 of the dispatch table). Strictly better: it auto-opens rename, and needs no extra-drop-zone seam in the primitive (which would be a conversation-specific hack). |
| 25 | Auto-focus rename on a **drag-created** group (`pendingFocusGroupId`) | **Dropped** | pending-focus is wired to `onCreate` only. Drag-created groups already inherit the target conversation's title (classic's own default), which is usually right; the `onCreate` path covers deliberate creation. Re-adding would need a generic "focus row N" imperative handle on the tree — not worth it for parity. |
| 26 | All groups collapse to headers **during a drag** (`group-container.tsx`) | **Dropped** | a workaround for header reachability in a hand-rolled DnD list. The tree ships auto-scroll, `measuringAlways` re-measurement, and `keepMounted` drag-source pinning; collapsing every row mid-drag would fight all three. |
| 27 | "Empty — drop a conversation here" / "No ungrouped conversations" placeholders | **Dropped** | a childless group row renders as a plain leaf. No per-row empty-body seam exists, and inventing one for two strings is not worth a primitive change. |
| 28 | Infinite pagination of **Closed** (`useGoneConversationsPagination` + `InfiniteScrollFooter`) | **Dropped** | Exactly the Queue tab's ruling for its Done section: *"infinite pagination of Done is out of scope — the History tab covers full history."* The bounded `recentGone` set still renders as the `Closed` bucket from live-state. Classic's footer sat below the whole list anyway, visually detached from the section it paginated — a known quirk. **This makes `use-gone-conversations-pagination.ts` dead** (§5). |
| 29 | Group drag **handle** (`MdDragIndicator` grip) | **Dropped (drift)** | the tree makes the whole row the drag source, Notion-style — deliberately, per the tree's own docs. |
| 30 | Escape does not cancel a rename (`group-rename.tsx` quirk) | **Dropped (bug-fix drift)** | `EditableTreeLabel`'s editor has proper cancel semantics. Classic's Escape-flushes-anyway was a bug. |

---

## 3. Data-layer exports needed

- **§0** — `grouped/shared/` → `grouped/core/` (blocking; the new plugin cannot
  legally reach `shared/`).
- **§0b** — one new endpoint, `moveConversationGroupMember`, to make the tree's
  member-reorder zones honest.
- **§0c** — `createConversationGroup` accepts an empty `conversationIds`.
- Nothing else. `useTaskAutoGroups` is copied into the new plugin (it is a pure
  derivation with no data layer); the classic components are deleted, not shared.

---

## 4. Primitive gap — exactly one

Almost everything Grouped needs already exists. The union `TRow`, minted synthetic
ranks, and consumer-interpreted `child`-zone drops are all *sanctioned* uses of the
current API, not hacks. One real gap remains:

### G1 — per-row edit gating: `FieldDef.canEdit?: (row: TRow) => boolean`

`FieldDef.onEdit` is declared **per field**
(`data-view/core/internal/types.ts:208`): `onEdit?: (row, next) => void | Promise<void>`.
The tree renders `EditableTreeLabel` whenever the primary field declares `onEdit`
(`tree-view.tsx:72`) — for **every** row. Grouped needs the primary `title` field
renameable on `group` / `auto-group` rows and read-only on `conv` / `fork` / `bucket`
rows (conversations have no rename endpoint). Without a gate the only options are an
editor that silently discards writes (violates "fail loudly") or no rename at all.

Generic, and the primitive already has the precedent — `ManualOrderConfig.getRank`
returns `Rank | null`, where `null` means "this row is not a drag source". Do the
same for editing:

```ts
// data-view/core/internal/types.ts — FieldDef<TRow>
/**
 * Per-row edit gate. Default: always editable when `onEdit`/`onEditValues` is
 * declared. Return false → the cell/label renders read-only for that row (no
 * editor, no inert affordance) — for heterogeneous row unions where only some
 * kinds are writable, and for read-only/archived rows.
 */
canEdit?: (row: TRow) => boolean;
```

Threaded through the three places that decide "is this cell editable":

- `data-view/plugins/tree/web/components/tree-view.tsx` — the
  `primaryField.onEdit || primaryField.onEditValues` test gains
  `&& (primaryField.canEdit?.(row) ?? true)`; the secondary-chip `FieldCell` path
  gets the same gate.
- `data-view/web/…/FieldCell` → `EditableCell` (table/list/gallery) — same gate, so
  the capability is uniform across every view rather than a tree quirk.
- Document in `data-view/CLAUDE.md` alongside `onEdit`.

**Deliberately NOT built (deferred, noted):** a `HierarchyConfig.canDrop?(dragged,
dest)` predicate. Illegal drops (a group onto a conv) currently no-op in the
consumer's `onMove` with no hover feedback — which is exactly what classic does today,
so it is not a parity regression. Build it when a second consumer wants it.

---

## 5. Phase 4 — the deletion list

Every path below was verified with `rg` for remaining importers.

### Delete outright

| Path | Why it's dead |
| --- | --- |
| `conversations-view/plugins/classic/` (whole plugin) | the only `classic` variant registration; nothing imports it |
| `conversations-view/plugins/history/` (whole plugin) | classic-only tab; replaced by `data-view/plugins/history` |
| `conversations-view/plugins/grouped/web/` (dir) | classic-only tab; replaced by `data-view/plugins/grouped`. **Keep `grouped/{core,server}/`** — the data layer |
| `conversations-view/plugins/queue/web/components/queue-view.tsx` | classic-only tab body |
| `conversations-view/web/slots.ts` (`ConversationsView`, `ViewProps`) | the classic tabbed host; last contributors die with the tabs above |
| `conversations-view/web/internal/use-gone-conversations-pagination.ts` | **verified**: importers are exactly `grouped/web/components/grouped-view.tsx` + `history/web/components/history-view.tsx` — both deleted. Dead (given §2 row 28). Drop its `export` from `conversations-view/web/index.ts` too |
| `config/conversations/conversations-view/sidebar-region/` | region deleted (below) |

### Keep — explicitly

- `queue/web/classify-queue.ts` + `queue/web/components/apply-reorder.ts` (+ its
  `.test.ts`) — consumed by `data-view/plugins/queue`. `queue/web/index.ts` shrinks
  to the exports + a contribution-less plugin definition.
- `grouped/{core,server}/` — tables, resource, CRUD; `addMemberToGroup` is still
  consumed by `improve/server`.
- `conversations-view/web/components/{conversations-sidebar,conversation-list,conv-count-label}.tsx`
  — the mount point stays.
- `primitives/css/lint/index.ts:114-115` — two allowlist entries naming deleted
  `grouped/web/components/*` files. Remove the stale entries.

### The `sidebar-region` — **recommendation: collapse it**

Delete `conversations-view/plugins/sidebar-region/` (`core/`, `web/`, `server/`) and
its config dir, and mount the DataView host directly.

**Why collapse:**

1. It exists **only** as the migration's fallback switch. The north star names this
   as the Phase 4 endgame: *"delete `classic/` and collapse the region (or mount the
   new host directly)."*
2. A variant picker with one option is user-visible cruft, sitting permanently in the
   sidebar chrome next to the launch button.
3. It is not free: a config descriptor, a `DynamicEnum.Options` contribution, a
   `ThemeEngine.VariantGroup` entry (so the theme customizer grows a dead
   "Conversation list" section), a committed config file, and a whole plugin with
   three runtimes — all for a closed set of size 1. That is precisely the CLAUDE.md
   rule *"for a closed list… prefer plain data over introducing a slot"*.
4. The "endgame is a pure deletion" argument in the north star was about not being
   forced to edit the mount point **in order to delete `classic`** — which still
   holds; the region does its job right up to the moment `classic` is gone.
   Collapsing afterward is a separate, deliberate step, not a violation.
5. Re-introducing it later is ~20 lines of `defineVariantRegion` + a one-line mount
   point change. Keeping infrastructure alive for a speculative second variant is the
   cost we'd be paying every day until it arrives.

**How to collapse without a cycle** — this is the subtle part. `ConversationSidebarProps`
lives in `sidebar-region/core` *specifically* so the mount point can render the region
without a cycle back into `conversations-view`. Preserve that property:

- Move `ConversationSidebarProps` into the DataView umbrella —
  `data-view/web/host.ts` defines and exports it (or a tiny `data-view/core/`).
  It is structurally identical to the dying `ViewProps`; the region's own doc comment
  already anticipates this (*"The two converge when the tabbed view is eventually
  deleted"*).
- `conversation-list.tsx` renders `<SidebarDataView.Host {...props} className="h-full" />`
  directly, importing from `@plugins/conversations/plugins/conversations-view/plugins/data-view/web`,
  and drops the `<Picker />` from the header `Stack`.
- Resulting edge: `conversations-view` → `conversations-view/plugins/data-view`
  (parent → descendant, a legal plain import). `data-view` and its tabs import
  **nothing** from `conversations-view` afterwards, so the graph stays a DAG.
  ✔ Verify with `./equin check plugin-boundaries`.
- Delete `data-view/web/components/dataview-body.tsx` and the `SidebarRegion.Variant`
  contribution in `data-view/web/index.ts` (the umbrella keeps only the host export).

**Alternative considered:** keep the region "for future variants". Rejected — nothing
concrete is queued, and a one-option picker is worse than no picker. If a second
variant ever lands, that task re-adds the region as its first step.

---

## 6. Config migration

`config/conversations/conversations-view/sidebar-region/conversations-sidebar.origin.jsonc`
pins `{"variant": "classic"}`; `defineVariantRegion` also hard-codes
`defaultVariant: "classic"` (`sidebar-region/core/region.ts`). Only the `.origin.jsonc`
is committed — no user `.jsonc` exists in the repo, but a user's machine may have one.

**Do it in two steps, in this order:**

1. **Cutover (soak).** Flip `defaultVariant: "dataview"` in `sidebar-region/core/region.ts`
   **and** set `.origin.jsonc` to `{"variant": "dataview"}` (`./equin build`
   rewrites the `// @hash`). A user with a local `.jsonc` pinning `classic` keeps it;
   the staged origin change surfaces in the review pane's **config-defaults** section
   (`review/plugins/config-defaults`) with a before→after diff and Apply/Discard —
   that is the sanctioned path for a "default for everyone" change. Leave `classic`
   registered here so the fallback is one click away while it soaks.
2. **Deletion.** Delete the region (§5). **The migration question then dissolves
   entirely**: with no variant config, no `defaultVariant`, and no picker, every user
   lands on the DataView host unconditionally — a stale local `.jsonc` pinning
   `classic` can no longer strand anyone, because nothing reads it. `config_v2`
   ignores config rows whose descriptor is gone (the same fail-soft path as an orphan
   `view.type`); sweep the file with the plugin.

If step 1 and step 2 land in the same push, step 1 is redundant — but keep it as a
separate commit so a bisect can park on "dataview default, classic still available".

---

## 7. Verification

1. `./equin build` (regenerates the registry, data-view codegen, migrations for
   §0b; runs `data-view:configs-authored`, `plugins-*-in-sync`, `plugin-boundaries`,
   `type-check`). Open `http://att-1784289044-hh04.localhost:9000`.
2. **Parity soak (before deleting anything).** With both variants live, toggle
   classic ↔ dataview against the same DB and confirm identical group structure.
3. Drive with `e2e/screenshot.mjs` (before/after captures) on the **Grouped** tab:
   - drag conv A onto conv B (both ungrouped) → a new group appears titled after B;
   - drag a conv onto that group → joins;
   - drag a conv onto an auto-group → the auto-group promotes to a real group;
   - drag a conv onto **Ungrouped** → leaves its group;
   - drag a group onto another group's edge → reorders;
   - drag a member between two members → reorders (the §0b endpoint);
   - click **New group** → an empty group appears with its label already in edit mode;
   - rename a group; rename an auto-group (→ promotes);
   - click "Remove from group", "Delete group", "Close conversation".
   - **Confirm a conversation row's label is NOT editable** (the G1 gate).
4. **`query_db` checks** — the load-bearing DB assertions:
   - `SELECT * FROM conversation_group_members ORDER BY group_id, rank;` — after a
     conv→conv drag, both conversations share one `group_id` with distinct ascending
     ranks; after a member reorder, the moved row's rank sits strictly between its new
     neighbours; a conv moved A→B has exactly **one** row (the PK-upsert path), never two.
   - `SELECT id, title, rank, expanded FROM conversation_groups ORDER BY rank;` —
     group reorder writes a rank strictly between its neighbours; expand/collapse
     persists; a group created via **New group** exists with zero members.
   - Perform each mutation from **classic** and from **dataview** and diff the
     resulting rows — they must be identical. This is the parity proof.
   - After "Delete group": the group row is gone and its member rows cascaded
     (conversations survive and reappear under Ungrouped).
5. Confirm the **Closed** bucket shows `recentGone` and that no infinite-scroll footer
   remains; History still covers full history.
6. Toggle the `kind != system` filter and confirm system conversations appear/hide
   (the replacement for the eye button).
7. **Post-deletion:** `./equin check` clean — especially `plugin-boundaries`
   (no importer of `classic`/`history`, no cycle from the new parent→child mount edge)
   and `plugins-registry-in-sync` / `plugins-doc-in-sync`. Confirm the sidebar renders
   with no variant picker, and that the theme customizer no longer lists a
   "Conversation list" variant group.
8. Regression: Queue + History tabs unaffected; `improve`'s `addMemberToGroup` still
   compiles against `grouped/server`.

---

## Critical files

- **Primitive (G1):** `plugins/primitives/plugins/data-view/core/internal/types.ts`,
  `…/plugins/tree/web/components/tree-view.tsx`, `…/web/…/EditableCell`, `…/CLAUDE.md`
- **Precedent to mirror:** `…/conversations-view/plugins/data-view/plugins/queue/web/**`
  (index, `sidebar-queue.tsx`, `queue-fields.ts`, `queue-item-actions.tsx`, `use-queue-rows.ts`)
- **Tree contract:** `plugins/primitives/plugins/data-view/plugins/tree/CLAUDE.md`,
  `plugins/primitives/plugins/tree/core/internal/tree.ts` (`computeDrop`)
- **Data layer (promote + extend):** `…/conversations-view/plugins/grouped/shared/**` → `core/`,
  `…/grouped/server/internal/{repo,routes,tables}.ts`
- **Behavior source of truth (to port then delete):**
  `…/grouped/web/components/grouped-conversation-list.tsx` (the real brain),
  `…/use-task-auto-groups.ts`
- **Mount point / switch:** `…/conversations-view/web/components/conversation-list.tsx`,
  `…/web/slots.ts`, `…/plugins/sidebar-region/**`,
  `config/conversations/conversations-view/sidebar-region/conversations-sidebar.origin.jsonc`
- **New:** `…/data-view/plugins/grouped/web/**`,
  `config/conversations/conversations-view/data-view/grouped/conversations-sidebar-grouped{,.origin}.jsonc`
