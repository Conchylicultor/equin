# Reorder groups → contributed node-type registry

## Context

The reorder primitive's order/hidden/spacer state already lives in a config_v2
`reorder-tree` field (`items`) — a recursive tagged-node tree authored in JSONC
files and editable in-app via the pen-drag editor (see
`research/2026-06-04-global-reorder-config-integration.md` and
`…-tree-config-field.md`). The tree format already **reserves** a
`{ group: string; items: ReorderNode[] }` arm so groups could slot in later.

Groups are the one piece left out of that migration: still 100% DB-backed
(`plugins/reorder/plugins/groups/` — two Postgres tables, four endpoints
`createGroup`/`patchGroup`/`addMembers`/`removeMember`, `reorderGroupsResource`),
consumed via `groupsData`/`membershipMap` in `sorting.ts` +
`dnd-list-middleware.tsx`, rendered by `group-box.tsx`/`group-rename.tsx`. The
ordering uses `Rank` (a parallel system bolted onto the positional tree), and
**nothing creates groups anywhere** — it is dead-but-wired. The config-pane field
renderer skips group nodes entirely, so groups are middleware-only.

The settled redesign (discussed with the user): stop treating "group" as a single
hardcoded concept. A group is whichever **contributed node type** an author picks —
a sidebar `header`, a toolbar overflow `menu`, a visual `box`. Introduce a
**registry of reorder node types** (mirroring the `fields` primitive's
`fields.identity` registry), with `spacer` migrated in as the first built-in node
type and **one** container node type (`header`, labeled box + collapse) shipped in
this pass. Both consumers — the live pen-drag middleware and the config-pane field
renderer — render every node type from the one registry, so groups stop being
middleware-only. The DB-backed groups plugin is deleted entirely. Authoring of
container membership/order/creation is **config-only**; in-app edit mode keeps
reorder / hide / restore / add-spacer / collapse-toggle.

**Intended outcome:** a clean, extensible node-type system with no parallel DB
storage or Rank ordering; groups become agent-editable + git-committable like
everything else; new node types (menu, box, …) are later one-plugin contributions.

### Settled scope

- One level only — **no nesting** (containers hold items + spacers, not containers).
- Container `collapsed?: boolean` persisted in config (survives app publishing).
- Config-only group authoring — **no in-app group creation**; containers are **not
  top-level draggable** in this pass (no drag handle, no rank).
- Ship the registry + `spacer` (migrated) + **one** container type (`header`).

## Design

### Tree format becomes registry-driven (extensions own their payload)

Items stay terse and core. Every **extension** node uses an explicit `{ type }`
shape, but the core format reserves **only the structural fields the generic
catalog-walker must understand** — everything else is opaque payload that each node
type defines and validates itself:

```ts
type ReorderNode =
  | string                                   // terse item (= { item })
  | { item: string; hidden?: boolean }
  | { type: string;                          // structural: registry dispatch
      id?: string;                           // structural: generic addressing (patch/remove)
      items?: ReorderNode[];                 // structural: child-list recursion (containers)
      [payload: string]: unknown };          // per-type payload, OWNED by the node type
```

- **`label`/`collapsed` are NOT universal** — they belong to the `header` node
  type's own payload schema, not the core format. A `spacer` has no payload; a
  future `menu` defines its own (`overflowAfter`, …); a `divider` has none.
- Each **node type owns a zod schema for its payload** (declared in its plugin).
  `{ type:"spacer", id }`, `{ type:"header", id?, label, collapsed?, items:[...] }`,
  etc. are each validated by their own type's schema — the core format only knows
  `type`/`id`/`items`.
- **Container-ness** = a node with an `items[]` array (the structural recursion
  point); the registry's `container` flag mirrors it for editor affordances.
- **Unknown / invalid `type` or payload** → skipped at render (fail-soft, matching
  the existing unknown-token behavior).

**Validation altitude (loose server, strict web):** the field-level zod
`nodeSchema` stays generic — `string | {item,hidden?} | {type: required, items?:
recursive, ...passthrough}` (`type` required, `{item}` arm first so item nodes
aren't swallowed, `.passthrough()` so per-type payload + back-compat `{spacer}`
survive). The server therefore validates only *structure*; each node type's payload
schema is applied **web-side** in normalize/render (invalid payload → skip/default).
This keeps the core format registry-free and isomorphic, and avoids a web→server
schema bridge for what is layout cosmetics. (If strict isomorphic per-type
validation is ever wanted, node-type schemas would need a build-time manifest like
`reorderable-slots`; out of scope here — flag for the user.)

`normalizeNode` stays structural (no registry): `string`→item; `"item" in node`
→item; `"spacer" in node`→`{kind:"node",type:"spacer",id}` (**back-compat read**,
emit-new only); `"type" in node`→`{kind:"node", type, id?, payload, members:
node.items}`; else defensive skip.

### The node-type registry (mirrors `fields.identity`, no core-identity split)

New umbrella `plugins/reorder/plugins/node-types/`:

- `node-types/core` — **types only** (no registered identity values, unlike
  `fields` — normalization is structural so no `extends`/`coerce` core dimension is
  needed). The type is generic over its payload `P` so each node type owns its
  structure:
  ```ts
  interface ReorderNodeType<P = unknown> {
    type: string;
    container: boolean;
    schema: ZodType<P>;                 // node type OWNS its payload schema
    render(props: ReorderNodeRenderProps<P>): ReactNode;
    insert?: { label: string; create(): ReorderNode };
  }
  interface ReorderNodeRenderProps<P> {
    payload: P;                         // validated per-type payload (label, collapsed, …)
    id?: string;
    editMode: boolean;
    children?: ReactNode;               // pre-rendered members (containers only)
    onPatch(next: Partial<P>): void;    // write payload back (e.g. collapse toggle), addressed by id
    onRemove(): void;
  }
  ```
  (type-only `ReactNode`; `ZodType` from zod; type-only `ReorderNode`.)
- `node-types/web` — owns slot `ReorderNodes.NodeType =
  defineSlot<{ nodeType: ReorderNodeType }>("reorder.node-type")` (plain data slot,
  per `plugins/framework/plugins/web-sdk/core/slots.ts`); exports
  `useReorderNodeTypes(): Map<string, ReorderNodeType>` reading the slot. Imports
  only `web-sdk/core` + `node-types/core` → **no back-edge**, so both consumers
  (`reorder/web`, `fields/reorder-tree/config/web`) can **import the barrel
  directly** (provably cycle-free — the `data-view` raw-string read is unnecessary
  here).
- Built-in node types as sub-plugins, each contributing `ReorderNodes.NodeType(...)`
  from `web/index.ts`, importing `editor/web` for sortable primitives:
  - `node-types/plugins/spacer/` — `{ type:"spacer", container:false, schema:
    z.object({}), render: p => <SpacerReorderItem itemKey={p.id!}
    editMode={p.editMode} onRemove={p.onRemove}/>, insert:{ label:"Add Spacer",
    create: () => ({type:"spacer", id: crypto.randomUUID()}) } }`.
  - `node-types/plugins/header/` — owns its payload `schema: z.object({ label:
    z.string().optional(), collapsed: z.boolean().optional() })`; a `HeaderBox`
    (chevron + label + pre-rendered `children`; rebuilt from `group-box.tsx` minus
    DB/drag/rename) that reads `payload.label`/`payload.collapsed` and calls
    `onPatch({ collapsed: !payload.collapsed })`; `{ type:"header", container:true,
    schema, render: p => <HeaderBox {...p}/> }`.

### Editor refactor (presentational, simpler)

`ReorderEntry` collapses from `item | spacer | group` to
`ReorderItemEntry | ReorderNodeEntry { kind:"node"; id; node; memberIds? }`
(`memberIds` present for containers so the shared `SortableContext` registers child
ids; a container pushes **only** memberIds, never its own sortable id — not
top-level draggable). Remove all group machinery (`DRAG_GROUP_PREFIX`,
`reorderCollisionDetection`, `groupsEnabled`, `GroupingZone`, group dispatch in
`handleMove`, `onGroup*`/`onAddGroup`, "Add Group" row) and native spacer
special-casing. Replace `onAddSpacer`/`onDeleteSpacer` with generic
`inserts: {label; onInsert: () => void}[]` (registry-driven, surfaced in the
popover) and `onRemoveNode: (id) => void`. `handleMove` simplifies to
`onDrop(activeId, overId)`; collision is always default `closestCenter`.
`SpacerReorderItem`/`SortableReorderItem` stay **exported from `editor/web`** as
reusable primitives (the spacer node-type imports `SpacerReorderItem`);
`ReorderAreaContext` keeps a generic `onRemoveNode` (drop `onDeleteSpacer`,
`groupsEnabled`). The `create()` half of an insert lives consumer-side (tree-aware);
the editor's `onInsert` is opaque.

### Both consumers render through the registry

- **Live middleware** (`dnd-list-middleware.tsx` + `applyTree` in `sorting.ts`):
  `applyTree` drops all `groupsData`/`membershipMap`/`GroupEntry`/Rank logic and
  emits **structured top-level entries** — `Contribution | NodeEntry { kind:"node";
  type; id?; payload; members?: (Contribution|SpacerItem)[] }` — registry-agnostic
  pure data (payload stays opaque here; the registry interprets it). When the walk
  hits a node with `items`, it resolves each member against `byKey` and **consumes
  them** (so the unconsumed-tail append doesn't re-emit members at top level); nested
  containers are ignored (no-nesting policy). The middleware builds the map via
  `useReorderNodeTypes()`, validates each node's `payload` against its type's
  `schema`, and renders via the registry `render()` — items via `renderItem`,
  container nodes get pre-rendered member `children`, and every node gets
  `onPatch`/`onRemove` closures (id-addressed tree rewrites). `inserts` are built
  from node-types declaring `insert`.
- **Config pane** (`reorder-tree-renderer.tsx` + `tree-ops.ts`): same registry map,
  members rendered as label chips. `treeToView` emits item/spacer/container view
  entries (instead of skipping groups); `reorderTree` preserves container subtrees
  positionally (replacing the old `group`-filter tail).

### Container identity = lazily-assigned uuid (not positional)

Containers carry an optional `id`. The app addresses a container by `id` for
collapse-toggle and member resolution; a hand-authored container without `id`
renders fine and gets a uuid assigned the **first time** it is toggled in-app
(exactly the spacer uuid-on-create pattern). This eliminates the render-vs-storage
index-divergence footgun of positional addressing for ~zero cost.

### Write path preserves container subtrees verbatim

**Critical:** `materializeTree` must take the **raw `items` tree** (not only the
flat entries) and re-emit container subtrees verbatim — rebuilding from the flat
list would flatten containers out of existence. In-app edits only rewrite the
top-level item/spacer order *around* untouched container nodes (membership/order
inside a container is config-only this pass). Spacers emit `{type:"spacer",id}`.
In-app payload writes go through a **generic `onPatch(id, partial)`** that shallow-
merges into the addressed node's payload (e.g. the header's collapse toggle sets
`collapsed`) — the format/middleware never names `collapsed`; only the `header` node
type does.

## Implementation steps

1. **Format type** — `fields/reorder-tree/core/internal/reorder-tree.ts`: new
   `ReorderNode` reserving only structural `type`/`id`/`items` + opaque payload (drop
   `{spacer}`/`{group}` arms; do **not** add `label`/`collapsed` to the format).
2. **Schema + normalize** — `fields/reorder-tree/plugins/config/core/internal/reorder-tree.ts`:
   generic 3-arm `nodeSchema` (`type` required, `{item}` first, `.passthrough()` for
   opaque payload); rewrite `NormalizedNode` + `normalizeNode` (structural,
   payload-opaque; back-compat `{spacer}` read). Keep `reorderTreeField` signature.
3. **`node-types/core`** (new) — generic `ReorderNodeType<P>` (incl. `schema:
   ZodType<P>`) + `ReorderNodeRenderProps<P>` (`payload`/`onPatch`/`onRemove`) types,
   `package.json`, `CLAUDE.md`.
4. **`node-types/web`** (new) — `slots.ts` (`ReorderNodes.NodeType`),
   `internal/use-node-types.ts` (`useReorderNodeTypes`), barrel.
5. **Editor refactor** — `editor/web/internal/types.ts` (`ReorderNodeEntry`,
   `inserts`, `onRemoveNode`); `reorder-editor.tsx` (de-group, `sortableIds`,
   simplified `handleMove`); `items.tsx` (drop `GroupingZone`/`groupsEnabled`, rename
   to `onRemoveNode`, `RestoreButton` iterates `inserts`); `editor/web/index.ts`
   exports.
6. **Spacer node-type** (new) — `node-types/plugins/spacer/` (`schema: z.object({})`,
   `insert`).
7. **Header node-type** (new) — `node-types/plugins/header/` + `HeaderBox`; owns its
   payload `schema` (`label`/`collapsed`); collapse toggle via `onPatch`.
8. **`applyTree` rewrite** — `reorder/web/internal/sorting.ts`: structured container
   entries, drop all groups/Rank/membership.
9. **Middleware rewrite** — `reorder/web/internal/dnd-list-middleware.tsx`: delete
   groups wiring; `materializeTree` takes raw tree + preserves containers; registry
   map + per-type `payload` validation; generic `onPatch(id, partial)` (id-addressed,
   lazy uuid) + `onRemove(id)`; `inserts`; `renderOverlay` skips non-contribution ids.
10. **Config pane** — `tree-ops.ts` (new shapes, container preservation) +
    `reorder-tree-renderer.tsx` (registry render, member chips,
    `inserts`/`onRemoveNode`).
11. **Delete groups** — remove `plugins/reorder/plugins/groups/` wholesale +
    `reorder/web/internal/group-box.tsx` + `group-rename.tsx`.
12. **Build** — `./equin build`: drizzle DROP TABLE migration for
    `reorder_groups`/`reorder_group_members`; regenerates `server.generated.ts`,
    `web.generated.ts`, `docs/plugins-*.md`, CLAUDE.md autogen blocks, re-materialized
    origin `.jsonc`. Update hand-written prose in `reorder/CLAUDE.md` (replace the
    "groups stay DB-backed" caveat with the node-type model + in-app scope limits) and
    `editor/CLAUDE.md`.
13. **Check** — `./equin check`: boundaries (confirm no cycle from
    `reorder/web` / `config/web` → `node-types/web`), `migrations-in-sync`,
    `config-origins-in-sync` (re-stamp any drifted committed override),
    `plugins-doc-in-sync`.

## Critical files

- `plugins/fields/plugins/reorder-tree/plugins/config/core/internal/reorder-tree.ts`
  — generic schema + structural `normalizeNode` (format keystone).
- `plugins/fields/plugins/reorder-tree/core/internal/reorder-tree.ts` — `ReorderNode`.
- `plugins/reorder/plugins/node-types/{core,web}/**` — the new registry (mirror
  `plugins/fields/web/slots.ts` + `plugins/primitives/plugins/data-view/web/internal/use-field-identities.ts`).
- `plugins/reorder/plugins/node-types/plugins/{spacer,header}/web/**` — built-ins.
- `plugins/reorder/web/internal/sorting.ts` — `applyTree` → structured container entries.
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — `materializeTree` (raw-tree
  container preservation), registry wiring, collapse/remove, groups deletion.
- `plugins/reorder/plugins/editor/web/internal/{reorder-editor,items,types}.tsx` —
  de-grouping + `ReorderNodeEntry` + `inserts`/`onRemoveNode`.
- `plugins/fields/plugins/reorder-tree/plugins/config/web/components/{reorder-tree-renderer.tsx,tree-ops.ts}`
  — config-pane registry rendering.
- Delete: `plugins/reorder/plugins/groups/**`, `reorder/web/internal/{group-box,group-rename}.tsx`.

### Reused existing machinery

- `defineSlot` (`web-sdk/core/slots.ts`) + the `fields.identity` read pattern
  (`use-field-identities.ts`) — the registry template.
- `SortableReorderItem` / `SpacerReorderItem` / `RestoreButton` /
  `ReorderAreaContext` (`editor/web`) — kept as presentational primitives.
- `reorderDirectiveDescriptor` / `reorderDescriptors` / config registrations
  (`reorder/shared/directive.ts`, `web|server/internal/config-registrations.ts`) —
  unchanged; the `items` field type is unchanged at the descriptor level.
- Drizzle DROP-on-delete (deleting `tables.ts` generates the migration on build).

## Verification

1. **Build:** `./equin build` — confirm the groups `DROP TABLE` migration is
   generated, the two node-type plugins appear in `web.generated.ts`, and origin
   `.jsonc` re-materializes spacers as `{type:"spacer"}`.
2. **Check:** `./equin check` — boundaries (no cycle to `node-types/web`),
   `migrations-in-sync`, `config-origins-in-sync`, `plugins-doc-in-sync`; both
   runtimes type-check.
3. **Hand-authored round-trip:** add to a committed slot override an `items` array
   with `{type:"header", label:"Tools", collapsed:false, items:["<pid>:a","<pid>:b"]}`
   plus a top-level `{type:"spacer", id}`; rebuild; confirm zod accepts it and the
   header renders members inside a collapsible box (members not re-emitted at top
   level).
4. **E2e (use the `verify`/`run` skill, `e2e/screenshot.mjs`):**
   - Live toolbar pen-drag: enter edit mode → drag a top-level item → add a spacer via
     the insert popover → delete it → hide/restore an item → toggle the header's
     collapse; confirm each writes through to `config/<plugin>/<slot>.jsonc` and
     reloads correctly.
   - Config settings pane: open the same slot's `reorder-tree` field; confirm the
     config-authored header renders as a labeled box with member chips + working
     collapse, reorder a top-level item, confirm `onChange` persists.
   - Confirm the **same** config-authored header renders in **both** surfaces — the
     core proof that the registry-driven container works for both consumers.
5. **Cleanup:** `mcp__singularity__query_db "SELECT * FROM reorder_groups"` now errors
   (table dropped); grep confirms no remaining references to `reorderGroupsResource` /
   `ReorderGroup` / `DRAG_GROUP_PREFIX`.
