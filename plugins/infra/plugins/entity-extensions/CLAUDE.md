# entity-extensions

Lets sub-plugins attach typed DB fields to a parent plugin's entity table without coupling the parent. Mirrors `attachments.defineLink` — both factories return a typed handle; the underlying pgTable never crosses the consumer's barrel.

## Why

A child plugin that wants per-entity state (toggles, settings, soft-delete flags) should not force the parent plugin to declare a column. Adding `auto_launch` to `_agents` to power a sub-plugin's row action backwards-couples the parent's schema to the feature. With this primitive, the child owns its own `<parent>_ext_<name>` side-table end-to-end: tables, live-state resource, HTTP route, UI.

## API

An extension is an **entity with a parent key and two timestamps added for you**. It is declared in two halves, so the browser can read the row schema without importing drizzle:

```ts
// shared/resources.ts (or core/ when another plugin reads the row) — browser-safe
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

export const transposeShape = defineExtensionShape({
  key: "songId",                       // the parent key's name
  fields: { semitones: intField() },   // the plugin's own fields
  // serverOnly?:     ["contentHash"]              — own fields kept off the wire
  // wireTimestamps?: ["createdAt" | "updatedAt"]  — timestamps put ON the wire
});
export const TransposeRowSchema = transposeShape.schema;   // { songId, semitones }
```

```ts
// server/internal/tables.ts
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { transposeShape } from "../../shared/resources";

export const songTranspose = defineExtension(_songs, "transpose", transposeShape, {
  columns: { semitones: { default: 0 } },   // DB-only concerns, own fields only
});
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
// The leading `_` and the `internal/` location keep cross-plugin imports
// impossible — only `songTranspose` (the handle) goes in barrels.
export const _songTransposeExt = songTranspose.table;
```

```ts
await songTranspose.upsert(songId, { semitones: 3 });   // insert or overwrite
await songTranspose.update(songId, { semitones: 4 });   // existing row only; undefined if none
const row = await songTranspose.get(songId);   // full row, server-only columns included
await songTranspose.delete(songId);
```

This creates `sonata_songs_ext_transpose(parent_id text PK FK → sonata_songs.id ON DELETE CASCADE ON UPDATE CASCADE, semitones integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at …)`. Drizzle-kit picks the table up via the `tables.ts` pattern in `SCHEMA_GLOBS` (`plugins/database/plugins/migrations/core/internal/schema-glob-patterns.ts`) — no central registration.

### `defineExtensionShape({ key, fields, serverOnly?, wireTimestamps?, exposes? })` — `core/`

Returns a frozen `{ key, fields, serverOnly, schema, exposure }`:

- `fields` is the **complete** field record, in column order: `{ [key]: textField(), ...fields, createdAt: dateField(), updatedAt: dateField() }`. The order is load-bearing — drizzle-kit diffs columns positionally, and it is the order every extension table has always had.
- `serverOnly` is the plugin's `serverOnly` plus every timestamp not listed in `wireTimestamps`.
- `schema` is `wireSchema(fields, serverOnly)` from `entities/core` — the same helper `defineEntity` uses, so the browser's schema and the server's come from the same code with the same inputs.

### `defineExtension(parent, name, shape, meta?)` — `server/`

Built on `defineEntity`. The table is `<parent>_ext_<name>`; the key column is the shape's key (`primaryKey`), stored as `parent_id` with the FK to `parent.id` ON DELETE CASCADE ON UPDATE CASCADE (so a later rewrite of the parent's ids — `plugins/ids` — carries the side row); both timestamps default to `now()`. `meta` takes the DB-only concerns:

- `columns` — `default` / `name` / `references` for the plugin's **own** fields (`defineEntity`'s `meta.columns`). The key and the timestamps are the primitive's, so they are not declarable here.
- `indexes` — see below.

The handle is an `Entity` (`name`, `table`, `schema`, `wireColumns`) plus `key`, `get(id)`, `upsert(id, values)`, `update(id, patch)` and `delete(id)`, all keyed on `table[key]`. `schema` **is** `shape.schema` — the same object, not a rebuilt one. `upsert`'s values are the plugin's own columns, every one without a DB default **required** (tsc): it is an `INSERT … ON CONFLICT DO UPDATE`, and Postgres checks NOT NULL on the proposed insert row before it sees the conflict, so a partial upsert fails even when the row exists. To change some columns of an existing row, use `update` (a plain `UPDATE`; `undefined` when there is no row). Neither writes `updatedAt` (see below).

### `exposes` — fields every list of the parent shows

`defineExtensionShape({ …, exposes: { parent, name, fields: { f: { label, absent, options? } } } })`
declares, once, which own fields every list whose rows reach `parent` (an
`EntityRef` — `entityRef("tasks")`, tasks-core's `tasksEntityRef`) shows, sorts,
filters and groups by. `absent` is what a parent with NO side row reads (track:
`"main"`, usage: `0`); the wire type is the field's widened by it. `options`
must name every wire value (tsc). The shape carries the resolved
`exposure: EntityExposure | null` (`slice` = `<parent>_ext_<name>`).
`defineExtension` asserts the parent table and name match the exposure and a
literal `meta.columns[f].default` equals `absent`.

Wire it in the plugin's two runtimes — `LiveColumns.Expose(ext)` (server) and
`LiveExposures.Register({ exposure: shape.exposure, present? })` (web, with
per-field `cell` / `width` / `align`); the `live:exposures-registered` check
enforces both. A collection names the entities it reaches (`liveCollection({
exposes })`) and folds every exposure of them — see `network/live`'s CLAUDE.md,
"Exposed fields". `tasks/task-track` and `conversations/usage` are the
reference exposures.

### The key is named after the parent

Each extension names its parent key (`songId`, `conversationId`, `taskId`, `blockId`, `serverId`). The table's JS property and the wire field share that name, so no loader renames `parentId` to the domain key. Only the DB column keeps the generic `parent_id` name — the DDL is unchanged by the name you pick.

### Wire, timestamps and `serverOnly`

- **Own fields are on the wire** unless listed in `serverOnly` (`defineEntity`'s rule). A server-only column stays in the DDL and in `get`'s row, but is never selected by `wireColumns`, so it cannot leak.
- **Timestamps are off the wire** unless listed in `wireTimestamps`. They belong to the primitive, so leaving them off by default cannot drop a column the plugin cares about — and it keeps a write that changes nothing from sending a row diff just because `updatedAt` moved.

### Loaders

A side table holds one row per parent, and a reader almost always wants the row of the ONE parent on screen. So the default is a **lookup-only `liveCollection`** (`network/live`): the client subscribes to the ids it draws, and a write to another parent's row never reaches it. The reference is `conversations/conversation-progress`:

```ts
// shared/ — the declaration, keyed on the shape's key
export const conversationProgressRows = liveCollection(
  "conversation-progress",
  { row: ConversationProgressSchema, id: "conversationId" },
);

// server/internal/resource.ts — no `select`: the projection is the row schema
export const conversationProgressRowsServed = serveCollection(
  conversationProgressRows,
  { from: conversationProgress },
);

// web — no whole-table read, no `.find(id)`
const progress = useLiveRow(conversationProgressRows, conversationId);
```

Because the handle is an entity, no form has a row projection left to write:

| Collection form | Serve |
|---|---|
| **lookup-only** `liveCollection(key, { row, id })` (default) | `serveCollection(c, { from: ext })`, **no `select`** — the entity is an `EntitySource`, its row fields bind to its columns by name |
| windowed `liveCollection` (a reader lists rows, a bounded window of them — `automations.tasks`) | the same, plus the declaration's `filterable` / `sortable` / `default` / `maxLimit` |
| `all` `liveCollection` (a reader needs the whole set — at most one row per parent, a field projecting it for every parent: `pages-starred.all`, `automations.origins`) | the same, plus the declaration's `all: { orderBy, unbounded: { reason } }` |

The old push forms (`defineResource` over the whole table, or a fold into a `Record`) re-sent every parent's row to every subscriber on any write and made each reader `.find(id)` its one row; the last of them (Sonata's per-song settings) are lookup collections now, and `no-legacy-resource-spelling` rejects the spelling.

**A reader that lists the PARENT by an extension column** (sort the songs by last-played, filter them by play count) joins the extension into the parent's collection instead: `ext.join(alias)` returns the extension as a join spec (`ExtensionJoin`, `infra/query-resource/core` — LEFT, 1:1 on the parent's id), and the parent collection binds its columns through overrides:

```ts
serveCollection(songsCollection, {
  from: _songs,
  joins: [songPlayback.join("playback")],
  columns: { lastPlayedAt: (j) => j.playback.lastPlayedAt },
});
```

A side row I / U / D then refills its parent row — only in the tuples whose SQL reads the join, and for a tuple that only projects it, only when that tuple holds the parent (`plugins/infra/plugins/query-resource/CLAUDE.md`, *Joins*). The spec carries the extension's `wireColumns`, so `j.playback` offers only those — a server-only column (by default the timestamps) cannot be bound. A parent with no side row reads the extension's DEFAULTS, not NULL: a column whose meta declares a literal `default` (`columns: { playCount: { default: 0 } }`) is read as `COALESCE(playback.play_count, 0)` everywhere the SQL reads it — the projection, a filter, a sort — so "never played" is `playCount = 0` in SQL as it is in the extension's own semantics. Every other field bound to the join must be nullable (a parent with no side row reads NULL; checked at module eval). A collection whose columns OTHER plugins own reads an extension this way through a contributed-column handle (`network/live`'s `liveColumns` + `serveColumns(handle, { join: ext.join(alias) })`).

A `select: { conversationId: t.parentId, … }` map or a `.map((r) => ({ songId: r.parentId, … }))` is the hand-rolled projection `no-hand-rolled-entity-projection` bans: a column added to the table silently misses the wire.

### `indexes`

The table ships with exactly one index: the implicit btree behind the `parent_id` primary key. That covers every read the handle's own methods make, so **a table read only by its key needs no `indexes` at all**. Declare one only when the plugin composes a query off `.table` keyed by something else — that read is otherwise a seq scan, and there is no other supported way to add the index (generated migrations are never hand-edited).

`meta.indexes` is a callback receiving the typed columns `t` and a builder pair `b`:

```ts
export const promptBlock = defineExtension(_tasks, "prompt_block", promptBlockShape, {
  // b.index("block_created") → index("tasks_ext_prompt_block_block_created_idx")
  indexes: (t, b) => [b.index("block_created").on(t.blockId, t.createdAt)],
});
```

**The name is derived, not authored.** The caller gives a short table-local suffix; the primitive prefixes the derived table name and appends `_idx`. An extension's table name is computed (`<parent>_ext_<name>`), so re-typing it as a string would be pure drift — a typo or a later parent rename yields a silently misleading index name that Postgres accepts without complaint. Binding the prefix makes a wrong name unrepresentable.

`b.index` / `b.uniqueIndex` return **drizzle's own builders**, so the full surface stays available: `.on()`, `.using("gin", …)`, `.where(sql\`…\`)`, `.desc()`. `t` is keyed by JS property name and covers the key, `createdAt` and `updatedAt` alongside the plugin's own fields.

### `updatedAt`

Derived, never written: every side-table gets the derived-`updatedAt` trigger of [`entities`](../entities/CLAUDE.md) → **Derived updatedAt**, so `updated_at` moves to `now()` only when a counted column really changes, and any app write to it RAISEs. `defineExtension` builds the total `touchedBy` map itself — the key and `createdAt` never count, **every own column counts by default** — so a new column cannot be missed (over-counting is the only possible error, and it is harmless). Override a column with `meta.touchedBy` (`false`, or `{ into, outOf }` typed against the column's value type): e.g. `touchedBy: { checkedAt: false }` for a column a probe rewrites every run. A presence-only extension (no own columns) compiles a trigger that never bumps. A direct `db.update(ext.table)` / `insert … onConflictDoUpdate` must not set `updatedAt` either.

### Module-eval throws

- **Reserved field names** (`defineExtensionShape`). A plugin field named after the chosen key, `createdAt` or `updatedAt` would collide with the primitive's own field, so the declared shape and the DDL would disagree. It throws, naming the key and the field. A key named `createdAt` / `updatedAt` throws too.
- **Identifier length** (`defineExtension`). `<table>_<suffix>_idx` past Postgres's 63-**byte** limit is silently truncated, which can collide with another index. It throws with the offending name and its byte length. The suffix shape is validated too (`/^[a-z0-9_]+$/`, non-empty).
- Everything `defineEntity` checks (a field type with no storage, a `serverOnly` key that is not a field).

## Wire-up

Each consumer plugin owns its own:
- `shared/resources.ts` (or `core/` when another plugin reads the row) — `defineExtensionShape(...)`, the row schema (`= shape.schema`) and the `liveCollection(...)` declaration
- `server/internal/tables.ts` — `defineExtension(parent, name, shape, meta?)`, plus the `.table` re-export
- `server/internal/resource.ts` — `serveCollection(c, { from: ext })`, in one of the forms above
- `shared/endpoints.ts` (or `core/`) — `defineEndpoint(...)` for the `POST /api/<feature>/:id` mutation
- `server/index.ts` — spreads `...served.declare` into `contributions` and wires the mutation via `implement(...)`
- `web/components/...` — `useLiveRow(c, parentId)` for reads + `useEndpointMutation(...)` / `fetchEndpoint(...)` (from `@plugins/infra/plugins/endpoints/web`) for the mutation

The parent plugin doesn't change. `sonata/transpose` is the reference consumer.

## Migration: moving data into or out of an extension

If no data needs preserving, accept the auto-generated migration as-is — that is the common case.

To preserve it, do the whole move in **one push**: add the new shape and remove the old one in `schema.ts`, and write the backfill across with `./singularity build --custom-migration --migration-name <slug>`. The generated schema migration is phased and claims the backfill, so the runner applies **expand** (the new extension or destination table) → the backfill → **contract** (the `DROP` of the old column/table). The backfill therefore reads the old shape and writes the new one, both present at that point.

Never hand-edit the generated SQL to interleave the DML: the push-time hand-edit detector aborts, and the phases already put it in the right place. The phase model lives in [`database/migrations/CLAUDE.md`](../../../database/plugins/migrations/CLAUDE.md) → **Phased schema migrations**.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Lets sub-plugins attach typed DB fields to a parent's entity table via 1:1 side-tables. Each consumer owns its <parent>_ext_<name> table; FK CASCADE on parent delete.
- Load-bearing: yes
- Server:
  - Uses:
    - `database.db`
    - `database.DbExecutor`
    - `infra/entities.DefaultedKeys`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/entities.Entity`
    - `infra/entities.EntityColumns`
    - `infra/entities.EntityMeta`
    - `infra/entities.EntityMetaBase`
    - `infra/entities.TouchedBy`
  - Exports (types):
    - `EntityExtension`
    - `ExtensionIndexBuilders`
    - `ExtensionMeta`
  - Exports (values):
    - `defineExtension`
    - `EntityExtensions`
- Core:
  - Uses:
    - `fields/date/config.dateField`
    - `fields/date/config.DateFieldDef`
    - `fields/text/config.textField`
    - `fields/text/config.TextFieldDef`
    - `infra/entities.wireSchema`
  - Exports (types):
    - `AnyExtensionShape`
    - `EntityExposure`
    - `ExposedAbsent`
    - `ExposedField`
    - `ExposedFieldDecl`
    - `ExposedOption`
    - `ExposesDecl`
    - `ExposureRow`
    - `ExposureRowSchema`
    - `ExtensionFields`
    - `ExtensionServerOnly`
    - `ExtensionShape`
    - `ExtensionShapeDef`
    - `ExtensionTimestamp`
    - `ExtensionWireShape`
  - Exports (values):
    - `defineExtensionShape`
    - `EXTENSION_TIMESTAMPS`
- Cross-plugin:
  - Imported by: 33 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×13
    - `tasks` ×10
    - `conversations` ×6
    - `page` ×3
    - `plugin-meta/plugin-health`

<!-- AUTOGENERATED:END -->
