# Fields declared once — Phase 2: every list derives its fields from its entity

Track page: `block-c8dbdc78-50f1-483a-bfbb-02f24825f9e0` (Design v2: `block-5f372b48-ddc0-4d06-a89b-8b65d44ddef7`).
Track instructions: `block-361815ed-5750-413a-b5ab-31c5dc855144`.
Phase 1 plan: `research/2026-10-12-global-fields-declared-once-phase1.md`.

## Context

Phase 1 let an extension expose fields once (`defineExtensionShape({ exposes })`). Every collection naming the entity gets them (`liveCollection({ exposes })`). But the rest is still hand-wired per list:

- **Base fields** are a hand-written `FieldDef[]` per list.
  - Conversations: `CONVERSATION_FIELDS`, `CONVERSATION_FILTERABLE`, and the `useConversationFieldDefs` id → property switch.
  - The filter domains (`liveText`, …) are hand-written beside a hand-picked row schema.
- **9 per-list `defineFieldExtensions` slots** remain: Tasks, Runs, PageTree, Library, Servers, Deployments, EventList, HomeApps and FileBrowser.
  - Most of them are browser joins: `TrackField`/`useStoredTracks`, `CategoryField`, `OriginField`, starred, tags, health.
- **`liveColumns` / `serveColumns`** remain for Sonata playback and midi. **`liveArmColumns`** remains for the 4 runs arms.
- **Phase 1's `absent`** is a freely chosen literal for a missing side row. It papers over `tasks_ext_track` storing only `"sidequest"`: its enum excludes `"main"`, and the wire type is widened. "No value" and "the default" were conflated. **Decided: delete `absent`.**
- **`tasks-core` tree-oracle C39 fails.**

**Exit for Phase 2 (track exit criteria 2 and 3):**

- Every list over a declared entity or row kind gets all its fields with no list code.
- A list's own code is only overrides by id plus fields it computes itself.
- `row`+`filterable`, `liveColumns`, `serveColumns`, `liveArmColumns`, `absent`, and every per-list `defineFieldExtensions` slot are deleted, enforced by tsc.

**Decided: two pushes.**

- **2a:** the new spelling, every live/entity DataView list migrated, and C39.
- **2b:** the remaining non-DataView declarations, Group C row kinds, and the final deletions.

## Census (done; summary)

| List | Rows | Today | Target |
|---|---|---|---|
| conversations (all / history / queue) | entity | hand base fields + switch | derived from the `conversations` entity |
| tasks (+ deps-tree) | `taskRows` `all`, entity `tasks` | `Tasks.Fields`: track, category, origin browser joins | `from: tasksEntity`; 3 exposures |
| Sonata library | `sonata.songs`, entity | `liveColumns` playback, midi (+ folders) | exposures on 2 shapes |
| runs | union over 4 raw ledgers | `liveArmColumns` + `Runs.Fields` presentation | arms declare a `FieldsRecord` |
| pages sidebar | `pages.tree` over raw `_blocks` | starred, agent-origin, tags browser joins | `_blocks` becomes an entity; presence ×2; tags with live options |
| deploy servers | `deploy.servers` is a **liveValue** (derived `sshKey`) | `Servers.Fields`: health status | an `all` collection over the entity; health exposes `ok` (null = unknown) |
| events list | entity `events` | `EventList.Fields`: sourceId options | base field; options from a live hook |
| home apps, file-explorer git, deployments release | registry rows / filesystem / probe | per-list slots | **Group C, 2b:** client fields on a row kind |
| ~15 other DataView collections (reports, dead-jobs, boot-traces, history.versions, release.history, deploy.run-history, claude-cli-calls, event-emissions, mail.threads, events.source-runs…) | free `z.object` or `fieldsToZodObject` | hand `fields` + `filterable` | `fields:` record (2a) |
| ~55 lookups / `all` sets with no DataView | mixed | `row:` | `fields:` / `from`+`pick` (2b) |

## Design

### 1. Entity declarations reach `core/` (`infra/entities`)

- `entityRef(name, fields)`: `EntityRef<N, F>` now carries its browser-safe `FieldsRecord` next to the name.
- Server `defineEntity(ref, …)` takes the ref and asserts that the table matches it.
- Labels move onto the field descriptors (`FieldMeta.label`). Enum value labels and variants move there too, as `enumTextField(values, { label, options: { v: { label, variant } } })`.
- `primary` (data-view's title field) becomes `FieldMeta.primary`.

### 2. One collection spelling (`network/live`)

```ts
liveCollection("conversations.history", {
  from: conversationsEntity,             // base entity: its exposures fold, `pick` reads from it
  pick: ["title", "status", "model", "kind", "createdAt", "updatedAt", "endedAt"],
  related: { task: tasksEntity },        // lookup-join aliases (Phase 1's non-base `exposes` keys)
  fields: { taskTitle: textField({ label: "Task" }) }, // own/computed fields (server binds them by join or expr)
  sortable: ["title", "createdAt", "updatedAt"],
  …
});
```

- **Derived from the field set:**
  - the row schema (`wireSchema` of picked ∪ own, plus `$columns`);
  - the filter domains, via Phase 1's `DOMAIN_OF_TYPE` (`exposed-columns.ts`), moved to one helper used for every owner. A type with no domain (json) is simply not filterable; `FieldMeta.filterable: false` opts a field out;
  - the labels, types and options.
- **`sortable` stays explicit**, since it must be index-backed.
- **A collection with no entity** declares only `fields`, which is the spelling for the free-zod ones.
- **tsc:**
  - a picked or own field must carry a `label` (`RequireLabel`);
  - `pick` keys must be keys of `from.fields`.
- **Deleted:** `row`, `filterable`, `exposes`, `contributed`. 2a keeps `row` only on non-DataView declarations; 2b deletes it.

### 3. The value of a missing side row is derived; `absent` is deleted (`infra/entity-extensions`)

- An exposed field reads the field's declared default when it has one; `defineExtension` keeps asserting that the DB default equals it.
- Otherwise it reads `null`, and the exposed wire type becomes `schema.nullable()` automatically.
- `COALESCE` uses that derived value. Results:
  - usage reads 0;
  - `lastPlayedAt` and `trackCount` read null (not MIDI);
  - health `ok` reads null (never checked);
  - category reads null (None);
  - origin `automationId` reads null (by hand).
- **Track migration:**
  - `track` becomes `enumTextField(["main", "sidequest"], { default: "main" })`, with DB default `'main'` (a migration generated by build);
  - the wire widening and `DEFAULT_TASK_TRACK`'s role in web code are deleted;
  - `setTaskTrack` keeps deleting on main, since it reads the same.
- **`as?: string` on an exposed field** keeps a persisted field id when the column name differs (health `ok` → id `status`). Saved views and filter presets keep their ids: `track`, `category`, `origin`, `starred`, `tags`, `status`, `playCount`, …

### 4. Presence fields (`infra/entity-extensions`, `query-resource`)

- `exposes.presence: { id, label, values?: { present, absent } }` renders as `(slice.key IS NOT NULL)`, or as a `CASE` when `values` is given.
- It is filterable and groupable on the server.
- starred: `{ id: "starred" }`, a bool.
- agent-origin: `{ id: "origin", values: { present: "agent", absent: "user" } }`. This keeps the Private / Scratch section filters.

### 5. One web presentation registry (`network/live/web`)

- Phase 1's `LiveExposures.Register({ exposure, present })` generalizes to `FieldPresentation.Register({ owner, fields: { f: { cell?, width?, align?, useOptions? } } })`.
- `owner` is an entity ref (base fields), an exposure, a run arm, or a row kind (2b).
- `useOptions` is a `Hook` value (`framework/hook-value`) that supplies options live. Its users:
  - the category registry;
  - the automations catalog (+ "By hand" for null);
  - the page-tag vocabulary;
  - event sources for `events.sourceId`;
  - the model catalog for `conversations.model`.
- Filtering stays on raw values.
- The registering plugin may differ from the exposing one. For example, midi exposes `sourceMissing` and folders registers its "File" badge cell.
- The live check is updated: every exposure, arm and row kind is served by its plugin's `server/` and registered by its `web/` (replacing the `liveColumns ↔ serveColumns` pairing).

### 6. DataView derives fields; list `fields` become overrides (`primitives/data-view`)

- **The derived set, in declaration order:**
  1. the collection's picked and own fields;
  2. the exposed fields of `from` and `related`;
  3. arm fields;
  4. presentation applied from the registry;
  5. a default cell per type (date → RelativeTime; enum → chip wearing the option variant).
- **Props:**
  - `overrides?: { [id in FieldIdsOf<C>]?: Partial<FieldPresentation & { visible, groupable, sortable, filterable }> }` is typed against the collection's ids, so an unknown id is a tsc error;
  - `extraFields?` holds fields the list computes itself (the Queue's `section`; the Deployments "Last run").
  - A hand `fields` prop is allowed only when neither `source` nor `collection` is given (discriminated union).
- **In-memory lists.**
  - Step 0 verifies that the `useLive` result can carry its collection. If it can, the rows arm accepts that result directly, the rows know their collection (no `collection` prop to forget), and `readiness` comes for free.
  - Otherwise, `collection` becomes required on the rows arm whenever the row type is `WithContributedColumns`.
- **Duplicate ids** between derived and extra fields still throw.
- **The global `DataViewSlots.FieldExtension`** (custom-columns) stays. It is minted internally, and `defineFieldExtensions` is no longer exported (2b).

### 7. Runs arms declare fields (`runs`, the 4 `runs-arm` plugins)

- `runArm(runs, kind, fields: FieldsRecord)` in core replaces `liveArmColumns`. It carries labels and options, and its domains are derived.
- Server `defineRunKind({ extra(j) })` is unchanged: it binds each declared field.
- Web presentation goes through `FieldPresentation.Register({ owner: arm })`. Arm sections (`section: "Build"`) come from the arm.
- `Runs.Fields` and each `*-run-fields.tsx` are deleted. `Runs.Kind` and `Runs.Leading` stay.

### 8. Group C: row kinds with client fields (2b)

- **`defineRowKind<TRow>(id, fields)` in core** is an entity without a table, for rows that aren't DB data:
  - `home.app`: registry contributions;
  - `file-explorer.entry`: filesystem.
- **`clientFields(owner, { f: { field, useValue } })`:** `owner` is a row kind or an entity ref, and the value comes from a `Hook`.
  - The fields filter in memory only. A client field has no column, so naming it in a server filter is a tsc error.
  - Deployments `release` is a client field on the `deploy_deployments` entity. It needs the filesystem candidate, `release_runs` and health.
- A DataView takes `rowKind=`, and every list of that kind gets the fields.
- **Upgrade path, recorded on the track page:** a kind that needs server filtering becomes a real server source without consumer changes.

### 9. C39 (`tasks-core/server/internal/tree-oracle.test.ts`)

- **Cause:** the old bundles parsed with plain `ConversationSchema` / `TaskListItemSchema`. These are non-strict `z.object`s, verified at `001d0c2d07~1`, so they strip unknown keys. A real old tab therefore accepts `waitingMenu` and `$columns`; the frozen literals' `.strict()` modelled a stricter client than ever shipped.
- **Fix:**
  - drop `.strict()` on `LegacyConversationsSchema`;
  - drop it on `LegacyRowsSchema` too, since `taskRows` gains `$columns` in 2a;
  - keep every frozen key required, so a removal, rename or type change still fails;
  - correct the comments: an additive field is compatible, and only a removal, rename or type change must rename the key.

## Steps

### Push 2a

0. Fix C39. Verify the `useLive` result → rows-arm option, and list the readers of `deploy.servers` `sshKey`.
1. entities: `entityRef(name, fields)`, and `defineEntity(ref)`. Add labels, `primary` and enum options to the field records of conversations, tasks, sonata_songs, events and the DataView-consumed entities.
2. entity-extensions: delete `absent` (derived default/null, auto-nullable wire), add `as`, add `presence`. Migrate track (enum + default, a generated migration). Update the usage and track shapes.
3. live core: `from` / `pick` / `related` / `fields`, derived domains, `RequireLabel`, `runArm`. live server: bind picked, own and related fields; presence and CASE renders; delete `serveColumns` and `LiveColumns.Serve`. live web: `FieldPresentation`.
4. data-view: derivation, `overrides`, `extraFields`, the rows-arm collection binding, the `fields` prop union.
5. Consumers:
   - conversations: delete `CONVERSATION_FIELDS` / `CONVERSATION_FILTERABLE` and the switch; the status cell and model options become entity presentation; the queue keeps `section`.
   - tasks + deps-tree: `from: tasksEntity`; expose track, category and origin; delete `TrackField`, `CategoryField`, `OriginField` and `Tasks.Fields`. Keep `useStoredTracks` (sidequest-autopilot reads it).
   - Sonata: playback and midi exposures; folders presentation; delete `liveColumns`, the columns files and `Library.Fields`.
   - runs: `runArm` ×4; delete `liveArmColumns` and `Runs.Fields`.
   - pages: a `_blocks` entity (verify a zero-diff migration); starred and origin presence; tags with live options; delete `PageTree.Fields`.
   - deploy servers: an `all` collection with `sshKey` moved to a per-id lookup; health `ok` as `status`; delete `Servers.Fields`.
   - events: the `sourceId` options hook; delete `EventList.Fields`.
   - The other ~15 DataView collections move to `fields:` / `from`+`pick`.
6. Docs: `CLAUDE.md` for live, data-view, entity-extensions and entities, and the per-plugin docs that name deleted slots. Run `./singularity build`, review, then push when told.

### Push 2b

7. Migrate the ~55 non-DataView `liveCollection` declarations off `row:`, then delete `row` (tsc).
8. Group C: `defineRowKind`, `clientFields`, `rowKind=`. Migrate home usage, file-explorer git and deployments release. Delete `HomeApps.Fields`, `FileBrowserSlots.Fields`, `Deployments.Fields` and the `defineFieldExtensions` export.
9. Update the track page (status, checkboxes, the Group C upgrade path). File the Phase 3 task with the page id and `block-361815ed-…`.

After 2a: update the track page and file the 2b task, in case 2b runs in a fresh session.

## Verification

- **Unit tests:**
  - derived absent: default vs null, including the auto-nullable wire type and a tsc test that `absent` no longer exists;
  - presence with and without `values`;
  - `as` id;
  - derived domains and `RequireLabel` (a tsc test);
  - `pick` keys (a tsc test);
  - data-view derivation, `overrides` against an unknown id (a tsc test), and the duplicate-id throw;
  - presentation `useOptions`;
  - `runArm` domains.
- **SQL goldens** (`live/server/testing/compile-sql-golden.ts`, `compile-union-golden.ts`, regenerated):
  - the derived COALESCE (track default `'main'`; trackCount with no COALESCE, i.e. null);
  - presence `IS NOT NULL` and CASE;
  - a filter `status = 'online'` over `ok`;
  - the run arms.
- **Oracles:**
  - `tree-oracle.test.ts`, C39 included;
  - `all-parity`, `conversations-oracle`, `serve-union-oracle`, `pages-tree-oracle`.
- **Routing:**
  - a `tasks_ext_track` write refills only that task's rows in `taskRows` and its conversations;
  - a starred write refills one page.
- **Saved-view ids are unchanged.** A test asserts the derived ids of each migrated list equal today's.
- `./singularity check` (type-check, live check, plugins-doc-in-sync), then `./singularity build`.
- **e2e:**
  - `sidequest-filter.ts` (Phase 1), re-run;
  - extend it to the task list: Track = Sidequest, plus group by Category;
  - screenshots of the pages sidebar (Starred, Private / Scratch sections), the Sonata library (Most played) and the deploy servers status.
