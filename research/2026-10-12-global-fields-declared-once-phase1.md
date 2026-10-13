# Fields declared once — Phase 1: conversations by track

Track page: `block-c8dbdc78-50f1-483a-bfbb-02f24825f9e0` (Design v2: `block-5f372b48-ddc0-4d06-a89b-8b65d44ddef7`).
Track instructions: `block-361815ed-5750-413a-b5ab-31c5dc855144`.

## Context

None of the three conversation lists can filter or group by a task's track (main or sidequest):

- the sidebar Queue (an in-memory DataView over `rows`);
- the sidebar History (the `conversations.history` live window);
- All-conversations (the `conversations.all` live window).

**Why.** Fields are wired per list, by hand:

- History and All-conversations each have a `defineFieldExtensions` slot (`HistoryFields`, `AllConversationsFields`). `usage` fills each one, and keeps one `liveColumns` handle per collection.
- The Queue has no slot at all.
- `task-track` only contributes to the task list, and only as a browser join over `useStoredTracks`.

**Phase 1 exit criterion.**

- In all three lists, Filter → Track = Sidequest and Group by Track work. History and All-conversations do it server-side.
- `task-track` exposes the track once, and no code names a conversation list.
- `AllConversationsFields`, `HistoryFields` and usage's duplicate `liveColumns` are deleted.

**Scope (decided).** Phase 1 derives only the *exposed extension* fields. The lists keep their base `FieldDef`s (`useConversationFieldDefs`). Deriving base fields from the entity and overriding list fields by id moves to Phase 2.

## Census findings (step 0)

- **History and All-conversations** are window collections declared `contributed: true`. They accept extension joins only (`serve-collection.ts:387`), folded at `bindDeferredResources`.
- **Why the Queue's collections refuse contributed columns:**
  - `conversationsActive` is a routed P8 `all` set (boot preload, L2-persisted, definition fingerprint). `serveCollection` binds it eagerly at module eval. `compileCollection` refuses contributions (`serve-collection.ts:330`), and `liveCollection` refuses `contributed` beside `all`.
  - The P8 plan (`research/2026-10-06-global-scoped-change-routing-p8-v3.md`, C3/C4) gives no deeper reason than "`all` cannot be contributed". It is unbuilt, not impossible.
  - The runtime's `definitionOf` already reads the plan off a deferred bind (`resource-runtime/core/runtime.ts:4153`).
  - `bindDeferredResources` runs before the preload assert and the L2 sweep (`server-core/shared/boot-stages.ts:124`).
  - So a deferred `all` is safe.
  - `conversationsGone` is a plain scroll window that was simply never declared contributed.
- **Reaching a related entity (conversation → task → `tasks_ext_track`)** needs no new routing:
  - a LEFT lookup on the side table keyed by its parent key, `on` = `attempt.taskId`;
  - the existing reverse-route probe sends a track write to exactly that task's conversations.
- **Track storage.** `tasks_ext_track` stores only `"sidequest"`; no row means main (`DEFAULT_TASK_TRACK` in web code).
- **COALESCE today** is applied only to `extension` joins, from the column's literal DB default (`query-resource/server/internal/joins.ts:595`).
- **Grouping.**
  - Server groups are read only over a collection's own filterable columns: `checkGroupBy` (`live/core/internal/query-codec.ts:456`) and `compileGroupsQuery`.
  - data-view therefore gives contributed columns only "prefix" grouping.
- **Census of the other contributors.** These match Design v2's census and are untouched in Phase 1:
  - Sonata `liveColumns`;
  - runs `liveArmColumns`;
  - the per-list slots of tasks, pages, deploy, events, home and file-explorer.

## Design

### 1. An extension exposes fields (`infra/entities`, `infra/entity-extensions`)

- **Entity refs.**
  - `infra/entities/core` gets `EntityRef<N> = { kind: "entity"; name: N }` and `entityRef(name)`.
  - `tasks-core/core` exports `conversationsEntityRef`, `attemptsEntityRef` and `tasksEntityRef`.
  - `defineEntity` keeps its signature. Asserts tie each ref to a table (`table name === ref.name`) in `defineExtension` and in the collection compile.
- **`exposes` on `defineExtensionShape`:**

  ```ts
  exposes?: {
    parent: EntityRef;
    name: string;                      // the extension name → slice `${parent}_ext_${name}`
    fields: { [K in Exclude<keyof F, ServerOnly>]?: {
      label: string;                   // required by tsc
      absent: Value<F[K]> | WidenedValue | null;  // value when the side row is missing
      options?: Record<V, { label: string; variant?: BadgeVariant; hint?: string }>;
    } };
  }
  ```

  - **tsc rejects** exposing a `serverOnly` field.
  - **The wire type** is the field's schema widened by `absent`. For track: a stored `["sidequest"]` with absent `"main"` becomes `z.enum(["main","sidequest"])`.
  - **The shape carries `exposure: EntityExposure | null`**: `{ parent, slice, fields: { label, wire, typeId, options, absent } }`.
- **`defineExtension` asserts:**
  - the table name equals `exposure.slice`;
  - `exposure.parent` equals the parent table's name;
  - any literal `meta.columns[f].default` equals `absent`.
- **The handle's `join(alias, opts?: { on })`.** The `on` option is used for related reach.

### 2. Joins (`infra/query-resource`)

- **`ExtensionJoin` gains `on?: ColumnRef`.**
  - Without it, nothing changes: the join is keyed on the base id, with an alias route.
  - With it, the join renders as a LEFT join keyed on `on` (a column of an earlier join, e.g. `attempt.taskId`).
  - It routes as a `reverse` route on `key`, probed through `on`'s chain, as a LEFT `lookup` does today.
- **`ExtensionJoin` gains `absent?: Record<col, literal>`.**
  - The COALESCE becomes `absent?.[col] ?? literalDefault(col)` (`joins.ts:595`).
  - It is bound with `sql.param(value)`, not the column's write encoder, because a parsed enum column would reject `'main'`.
  - So track needs no DDL change, and `setTaskTrack` keeps deleting the row on main.

### 3. Collections fold exposures (`network/live`)

- **`liveCollection` gets `exposes?: { [relation]: EntityRef }`.**
  - `base` is the collection's own entity; any other key is the alias of a declared lookup join.
  - It is allowed on window collections and on `all` collections. The `contributed` / `columnScope` refusals beside `all` stay.
  - Rows get `$columns`.
- **Column sets.**
  - `LiveColumnsOwner` gains `{ kind: "exposed"; entity }`.
  - `exposedColumns(exposure)` is memoized per exposure.
    - Name: `slice`. Wire names: `tasks_ext_track.track`.
    - The filter domain is derived from `typeId`: text/enum → `liveText`, int/float → `liveNumber`, date → `liveInstant`, bool → `liveBoolean`, tags → `liveStringArray`. An unmapped type throws.
    - It provides `read(row)` and `column(f)`.
  - The exhaustive owner switches get a new arm, each a tsc error until handled:
    - `query-codec.ts:176`
    - `serve-collection.ts:368`
    - `serve-union.ts:215`
    - data-view `live-fields.ts:124`
- **Server slot `LiveColumns.Expose(extensionHandle)`.**
  - **At bind**, a collection folds every exposure whose `parent` is one of its `exposes` values:
    - `base` → `ext.join(slice)`;
    - relation R → `ext.join(slice, { on: R's key column })`.
  - **Asserts at bind:**
    - the relation's join table is the entity;
    - one entity is reached through only one relation;
    - no slice or field-id collision.
  - **A boot orphan check**, mirroring the existing one: an exposure that no collection reaches is not an error, because an entity may have no list yet. That is logged only if useful, never silently merged.
- **Window collections.** Generalize `serveContributed` to `serveDeferred`, which also covers `exposes`. Folding reuses `contributedFields`, `fold` and `readField`, so values land in `$columns[slice][field]`.
- **`all` collections.**
  - With `exposes`, `serveCollection` uses `defineDeferredResource` for `all` and `rows`.
  - `compileAllSpecs(collection, opts, exposed)` appends the joins and projects the wire names.
  - It passes `wire: { encodeRow: fold, ids: { $columns: "exposed:<sorted slices.fields>" } }`, so the definition fingerprint covers the fold.
  - The first boot after deploy recomputes the persisted set (definition mismatch), as expected.
- **groupBy over exposed columns.**
  - `checkGroupBy` and the group / count decode take `columnSets`, like the window decode does.
  - `groupReads` and `groupSchemas` include exposed filterable columns.
  - `compileGroupsQuery` itself is unchanged.
- **Web slot `LiveExposures.Register({ exposure, present? })`.**
  - `present` is optional per-field presentation: `cell`, `width`, `align`.
  - It is read by `useExposures()`.
- **A check in `live/check`** extends today's `liveColumns ↔ serveColumns` pairing. Every shape with `exposes` must be registered by its plugin's `server/` (`LiveColumns.Expose`) and its `web/` (`LiveExposures.Register`).

### 4. DataView appends exposed fields (`primitives/data-view`)

- **`useExposedFields(collection, origin)`** returns one `FieldDef` per registered exposure field that the collection reaches:
  - `id` is the bare field key (`track`, `costUsd`), so saved views keep their ids;
  - `label`;
  - `type`: enum when there are options, otherwise derived from the type;
  - `options`;
  - `value = read(row)[f]`;
  - `cell` from `present`, else the type's default (the enum chip wears the option variant);
  - `column` only when live.
- **Collection binding.** A live DataView uses `source.collection`. An in-memory DataView takes a new `collection?:` prop on the rows arm.
- **Merging.** The host builds `[...fields, ...exposed]` before `CollectFieldExtensions`. A duplicate id throws.
- **Grouping.** `resolveLiveFields` puts an exposed column with a groupable domain into `groupColumns`, so Group by Track gets server sections, not a prefix.

### 5. Consumers

- **tasks-core:**
  - `conversationsActive` and `conversationsGone` get `exposes: { task: tasksEntityRef }` (one shared const).
  - Base exposures stay off them on purpose: usage upserts on every transcript append, and folding it into the boot-preloaded active set would push a diff to every client per append. The Queue shows no usage today either.
- **task-track:**
  - The shape gets `exposes` (label "Track", absent `DEFAULT_TASK_TRACK`, options from `TRACK_META`).
  - Server: `LiveColumns.Expose(tasksTrack)`. Web: `LiveExposures.Register`.
- **usage:**
  - The shape gets `exposes` (costUsd, tokens and agentCount, absent 0; DB defaults asserted equal).
  - Server: `LiveColumns.Expose(conversationUsage)`. Web: register cells (`formatUsd`, `formatTokensCompact`).
  - **Delete:** `shared/columns.ts`, `server/internal/columns.ts`, `web/components/usage-fields.tsx`, and both `LiveColumns.Serve` / slot contributions.
- **all-conversations / history:**
  - `contributed: true` becomes `exposes: { base: conversationsEntityRef, task: tasksEntityRef }`.
  - **Delete:** `AllConversationsFields` (`panes.tsx`, its index slot and export), `HistoryFields` (`sidebar-history.tsx`, index), and both `fieldExtensions=` props.
- **Queue:**
  - `QueueRow` becomes `WithContributedColumns<Conversation> & …`.
  - `sidebar-queue` passes `collection: conversationsActive`.
  - The rows of `conversationsGone` carry the same slice.
  - The in-memory `matchesFilter` filters Track with no list code.

### 6. Left for Phase 2 (recorded on the track page)

- The task list's `TrackField` / `useStoredTracks` browser join. That is a second track path until tasks migrate.
- Base-field derivation and overrides by id.
- Sonata, runs and the other per-list slots.
- Deleting `liveColumns`, `serveColumns` and `defineFieldExtensions`.

## Steps

1. entities core `EntityRef`, and refs in tasks-core core.
2. The extension shape's `exposes`, with types, asserts and `join(alias, { on })`.
3. query-resource `ExtensionJoin.on` and `absent`: render, route and COALESCE.
4. live core: the exposed owner, `exposedColumns`, `liveCollection.exposes`, codec groups and count.
5. live server: the `Expose` slot, `serveDeferred`, the deferred `all` fold, groups over exposed columns, bind asserts.
6. live web registration, data-view `useExposedFields`, the `collection` prop, groups; the live check.
7. Consumers: tasks-core, task-track, usage, all-conversations / history, Queue. Deletions as listed.
8. Docs: `CLAUDE.md` for entity-extensions, live ("Exposed fields"), data-view and usage.
9. Update the track page (status, checkboxes, a Phase 1 notes sub-page if needed). File the Phase 2 task with the page id and `block-361815ed-…`.

## Verification

- **Unit tests:**
  - shape `exposes`, including a tsc test that a `serverOnly` field is rejected;
  - `exposedColumns` domains;
  - the codec decode of groups and count with exposed sets;
  - `useExposedFields` (live and memory, duplicate-id throw);
  - `resolveLiveFields` sections for an exposed enum.
- **SQL goldens** (`live/server/testing/compile-sql-golden.ts`, regenerated):
  - a base exposure (COALESCE);
  - a related exposure through `task` (reverse route probed via `attempt`);
  - a filter `track = 'sidequest'`;
  - groups on `tasks_ext_track.track`;
  - the deferred `all` with the fold, and its definition changing with the exposure set.
- **Boot and oracle:**
  - a deferred `all` is declared for preload and bound before the L2 sweep (in the style of `serve-contributed-boot.test.ts`);
  - `tree-oracle.test.ts` and `all-parity.test.ts` still pass.
- **Routing:** a `tasks_ext_track` write refills only that task's conversations.
- `./singularity check`, then `./singularity build`.
- **e2e** `conversations/plugins/conversations-view/plugins/data-view/e2e/sidequest-filter.ts`:
  - seed a sidequest task with a conversation;
  - in Queue, History and All-conversations, filter Track = Sidequest and group by Track;
  - assert the rows, and that the live lists send a server filter.
