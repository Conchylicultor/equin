# `defineExtension` derives its wire schema

## Context

`defineExtension` (`plugins/infra/plugins/entity-extensions`) builds a 1:1 side-table
`<parent>_ext_<name>` from **raw drizzle column builders**. It returns only a
drizzle table, and a drizzle table cannot run in the browser. So every plugin that
sends extension rows to the browser hand-writes the row's zod schema in `shared/`,
then hand-writes a loader that copies columns into it and renames `parentId` to
the domain key (`songId`, `conversationId`, …).

That is the shape `no-hand-rolled-entity-projection` exists to ban. Adding a
column to the table does not add it to the wire, and nothing warns you. Today:

- Five loaders are allowlisted in the rule's `ignores` as "deferred": transpose,
  key-mode, midi, queue and auto-start. (Auto-start and queue have since moved to
  `windowQueryResource` with a `select: {…}` map, which has the same hole: the map
  is untyped.)
- Other plugins avoid the rule with a drizzle column projection (chord-mode, and
  about ten `select: { conversationId: t.parentId, … }` maps). The effect is the same.

`defineEntity` (`plugins/infra/plugins/entities`) already fixed this for plain
tables. It builds the pgTable **and** the zod wire schema from one `FieldsRecord`,
and the browser rebuilds the identical schema from the same record through
`wireSchema()` in `entities/core`. This plan does the same for extensions:
**an extension becomes an entity with a parent key and timestamps added for you.**

Decided with the user: **each extension names its parent key** (`songId`,
`conversationId`, `taskId`, `blockId`, `serverId`). The table's JS property and
the wire field share that name, so there is no rename left to write.

## Design

### 1. `defineExtensionShape` — new, in `entity-extensions/core` (browser-safe)

```ts
// shared/shape.ts (or core/ when another plugin reads the row)
export const transposeShape = defineExtensionShape({
  key: "songId",
  fields: { semitones: intField() },
  // serverOnly?:     ["contentHash"]           — user fields kept off the wire
  // wireTimestamps?: ["createdAt" | "updatedAt"] — timestamps put ON the wire
});
export const TransposeRowSchema = transposeShape.schema;   // { songId, semitones }
```

It returns a frozen `{ key, fields, serverOnly, schema }`:

- `fields` is the complete record, in this order: `{ [key]: textField(), ...fields,
  createdAt: dateField(), updatedAt: dateField() }`. Order matters because
  drizzle-kit compares columns by position, and this is today's order.
- `serverOnly` is the user's `serverOnly`, plus every timestamp not listed in
  `wireTimestamps`.
- `schema = wireSchema(fields, serverOnly)`. This reuses `entities/core`, so
  `defineEntity`'s server-side schema and this browser-side schema come from the
  same code with the same inputs.
- Before anything else it throws if `fields` already contains `key`, `createdAt` or
  `updatedAt`. This is `assertNoReservedColumns`, moved into `core/` and keyed on
  the chosen key.

**Timestamps stay off the wire unless asked for.** They belong to the primitive,
not to the plugin, so leaving them off by default cannot bring the bug back. It
also keeps a write that changes nothing from sending a row diff just because
`updatedAt` moved. Your own fields follow `defineEntity`'s rule: they are on the
wire unless listed in `serverOnly`.

### 2. `defineExtension(parent, name, shape, meta?)` — rewritten on `defineEntity`

The first two arguments stay in place, so the db-schema facet's regex parser does
not change.

```ts
export const songTranspose = defineExtension(_songs, "transpose", transposeShape, {
  columns: { semitones: { default: 0 } },          // DB defaults / name / references: user fields only
  indexes: (t, b) => [b.index("…").on(t.…)],       // unchanged bound-builder API
});
export const _songTransposeExt = songTranspose.table;   // drizzle-kit discovery, unchanged
```

Inside, it calls `defineEntity(`${getTableName(parent)}_ext_${name}`, shape.fields, …)` with:

- `primaryKey: shape.key`
- `columns`: the user's `meta.columns`, plus
  `[key]: { name: "parent_id", references: { column: () => parent.id, onDelete: "cascade" } }`
  and `createdAt` / `updatedAt: { default: defaultNow() }`
- `serverOnly: shape.serverOnly`
- `indexes: (t) => meta.indexes?.(t, builders) ?? []`, with the existing
  `extensionIndexName` builders

The result is an `Entity` (`name`, `table`, `schema`, `wireColumns`) with four more members:

```ts
interface EntityExtension<K, F, D, S> extends Entity<ExtensionFields<K, F>, D, S> {
  readonly key: K;
  get(id: string): Promise<Row | undefined>;            // full $inferSelect, server-only cols included
  upsert(id: string, patch: Partial<Omit<Insert, K | "createdAt" | "updatedAt">>): Promise<Row>;
  delete(id: string): Promise<void>;
}
```

`schema` **is** `shape.schema` (the same object). `get` / `upsert` / `delete` look
up the key column as `table[key]` instead of `t.parentId`. `ExtensionMeta<F>`
narrows to `{ columns?: EntityMeta<F>["columns"]; indexes? }`, typed over the
user's fields only, so a plugin cannot redeclare the key or the timestamps. The
return goes through a single `as unknown as` cast, as in `defineEntity`.

Because the handle has the same shape as an `Entity`, query-resource already
recognises it (`isEntitySource` in `query-resource/server/internal/identity.ts`).
`from: ext` defaults the projection to `wireColumns` and takes the identity from
the single primary key, which is the named key.

New imports for `entity-extensions`: `infra/entities` (server + core),
`fields/core`, `fields/text/config/core` and `fields/date/config/core`. I checked
for cycles: no fields plugin, `sql-column` or `rank` imports entities or
entity-extensions.

### 3. What a loader looks like afterwards

| Resource form | After |
|---|---|
| push `defineResource` | `schema: z.array(ext.schema)`, `loader: () => db.select(ext.wireColumns).from(ext.table)` |
| `windowQueryResource` / `queryResource` | `from: ext`, **no `select`**, `point: { by: ext.table.<key> }` |
| push resource that folds rows into a `Record` (task-effort, task-preprompt, turn-summary) | `db.select(ext.wireColumns)` then the same fold. The fold is a real transform, and each value's schema is `ext.schema` |

## Mapping columns to fields (DDL must stay byte-identical)

The survey confirmed each column type maps to a field type that produces the same
column in the database:

| Raw drizzle today | Field | Notes |
|---|---|---|
| `text(n).notNull()` / nullable | `textField()` / `nullable(textField())` | `text` storage emits `text(n)` |
| `parsedText(n, S)` | `parsedTextField(S, { default })` | Stored as `text`, so identical DDL. `default` is only a wire default |
| `integer` / `boolean` | `intField()` / `boolField()` | |
| `timestamp(n, {withTimezone:true})` | `dateField()` / `nullable(dateField())` | Default mode, so the TS type is still `Date` |
| `parsedJson(n, S)` | `jsonField({ schema: S, default })` | Stored as `jsonb` |
| `rankText(n)` | `rankField()` | `rank_text` domain |
| `.default(v)` / `.defaultNow()` | `meta.columns.<k>.default` (`v` / `defaultNow()`) | |
| column name ≠ snakeCase(key) | `meta.columns.<k>.name` | Only `conversation-preprompt.text` → `prompt_text` |
| `.references(() => _tasks.id, cascade)` | `meta.columns.<k>.references` | Only `todo/task-link.taskId` |

**Where the wire is narrower than the column.** When a text column's wire schema
narrows the value (an enum, say), move that narrowing into the field
(`enumTextField` / `parsedTextField`). The column is still `text`, so the DDL
does not change, and the value is now decoded when read on the server too. The one
column where this does not work is queue `rank`: the column is the `rank_text`
domain and its field schema must stay a plain `string`. So the queue's descriptor
uses `queueShape.schema.extend({ rank: RankSchema })`. An `.extend` cannot drop a
column, and the wire behaves exactly as it does today.

## The 23 call sites

Put the shape next to the plugin's existing row schema. That is `shared/` when
only the plugin's own web code reads the row, and `core/` when another plugin
reads it (queue already uses `core/resources.ts`). Extensions with no wire
resource can declare the shape inline in `tables.ts`.

| Extension | key | Fields (DB default) | serverOnly | wireTimestamps |
|---|---|---|---|---|
| pages/starred | blockId | — | | createdAt |
| pages/agent-origin | blockId | source | | createdAt |
| tasks/task-effort | taskId | level `parsedTextField(StoredEffortSchema)` | | updatedAt |
| tasks/task-category | taskId | category | | |
| tasks/auto-start | taskId | autoStartAt date, autoStartModel `parsedTextField(StoredModelSchema)` | | |
| tasks/task-preprompt | taskId | prepromptId | | updatedAt |
| plugin-meta/plugin-health | taskId | reviewId (+ index) | | |
| apps/deploy/health | serverId | ok, checkedAt, failureKind?, failureMessage?, checkedPublicKey?, hostKeyLine?, platform? | hostKeyLine | |
| conversations/conversation-preprompt | conversationId | prepromptId, title, text (`name: "prompt_text"`), icon? json(AvatarSpecSchema) | | updatedAt |
| conversations/conversation-progress | conversationId | phase, source (`parsedTextField`) | | updatedAt |
| sonata/playback-history | songId | playCount int (0), lastPlayedAt? date | | |
| sonata/sources/chord-grid | songId | chordText | | |
| sonata/transpose | songId | semitones int (0) | | |
| conversations-view/queue | conversationId | rank, pinned (false) | | |
| sonata/sources/midi | songId | attachmentId, trackCount, sourcePath?, sourceMissing (false), contentHash? | contentHash | |
| conversation-view/turn-summary | conversationId | messageId, summary, caveats (""), actions (""), generatedAt (now) | | |
| sonata/sources/ultimate-guitar | songId | 9 text/int fields (`key?` nullable) | | |
| conversation-view/notes | conversationId | notes | | updatedAt |
| sonata/rich/chord-mode | songId | enabled (false) | | |
| sonata/rich/key-mode | songId | enabled (false) | | |
| sonata/rich/rhythm-controls | songId | enabled (false), bass/chord json(RhythmPatternSchema), bassPatternId/chordPatternId (DEFAULT_*_FIGURATION_ID) | | |
| page/prompt/link | taskId | pageId, blockId (+ index) | | createdAt |
| page/annotations/todo/task-link | blockId | taskId (references `_tasks.id` cascade, + index) | | createdAt |

`?` = nullable. Two existing omissions (midi's `contentHash`, deploy-health's
`hostKeyLine`) are deliberate, and they become explicit `serverOnly` entries.

Per plugin, the same mechanical steps:

1. `tables.ts`: declare the shape and move DB defaults into `meta.columns`.
2. `shared` / `core` row schema: replace it with `shape.schema` (keep the exported
   name and type alias, so imports do not change).
3. Resource loaders: switch to the forms in §3, which deletes every `select` map,
   `.map` and `plainPattern`.
4. Server code: replace `.table.parentId` and `row.parentId` with the key (about
   100 edits: queue ~34, auto-start 11, midi 9, …).
5. Fix whatever `tsc` flags on the web side. Known cases:
   - `parentId` → the key in starred, agent-origin, task-category, deploy-health
     and prompt-link.
   - playback `lastPlayedAt` becomes a `Date` instead of an ISO string.
   - rhythm `onsets` becomes `readonly`.
   - prompt-link's origin rows gain `createdAt`.

**Needs your approval — edits under `plugins/framework/`:**

- `plugins/framework/plugins/cli/plugins/deploy/cli/internal/target.ts:261`: a
  one-line rename, `serverHealth.table.parentId` → `.serverId`. This is the only
  place outside its own plugin that reads an extension table's key.
- `plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/`:
  - delete the `ignores` block in `lint/index.ts`.
  - make the rule's message name `defineExtension` / `defineExtensionShape` next
    to `defineEntity`.
  - rewrite the "deferred exception" paragraph of its `CLAUDE.md`.

## Critical files

- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`: rewritten.
- `plugins/infra/plugins/entity-extensions/core/{index.ts, internal/define-extension-shape.ts, internal/reserved.ts}`: new. `index-names.ts` keeps only the index-name half.
- `plugins/infra/plugins/entity-extensions/server/index.ts`: new type exports (`EntityExtension`, `ExtensionMeta`, `ExtensionShape`).
- `plugins/infra/plugins/entity-extensions/CLAUDE.md`: rewrite API and Wire-up. The loader becomes one line, and the reserved-column rule now refers to the chosen key.
- Reused as-is: `defineEntity` and `defaultNow` (`entities/server`), `wireSchema` (`entities/core`), `fieldsToZodObject` / `nullable` (`fields/core`), `isEntitySource` (query-resource).
- Representative call sites: `sonata/transpose/{server/internal/tables.ts,resource.ts,shared/resources.ts}`, `conversations-view/queue/{server/internal/*.ts,core/resources.ts}`, `todo/task-link/server/internal/tables.ts`.

## Tests

- `entity-extensions/server/internal/define-extension.test.ts` (new, bun):
  - build one extension each way (old raw-drizzle and new shape-based) and compare
    `getTableConfig` for both: column names, order, SQL types, not-null, defaults,
    primary key, and the FK with cascade.
  - the key column's DB name is `parent_id`.
  - `schema` keys are exactly the key, plus the fields, minus `serverOnly`, plus
    `wireTimestamps`.
  - a type-level check that `wireColumns` rows equal `z.infer<schema>`.
  - `get` / `upsert` / `delete` go through the key column.
- `entity-extensions/core/internal/define-extension-shape.test.ts`: reserved keys
  throw, and the `serverOnly` / `wireTimestamps` combinations produce the right keys.
- Existing: `index-names.test.ts`, `entities` tests, query-resource tests, and queue's `apply-reorder.test.ts`.

## Verification

1. `./equin build` (in the background). **The key signal is that no new
   migration gets generated.** A clean `migrations-in-sync` proves all 23 tables
   kept byte-identical DDL. If a migration appears, stop and diff the snapshot.
   Do not accept the migration.
2. `./equin check`:
   - `type-check`: this covers web and server; every wire-shape change surfaces here.
   - `eslint`: the rule now runs with no allowlist.
   - `plugin-boundaries`: no import cycle from the new `entities` / `fields` edges.
   - `plugins-doc-in-sync` and `table-defs-in-schema-glob`.
3. `./equin test plugins/infra/plugins/entity-extensions plugins/infra/plugins/entities plugins/infra/plugins/query-resource plugins/conversations/plugins/conversations-view/plugins/queue`.
4. `query_db` on the worktree DB: `information_schema.columns` for
   `sonata_songs_ext_midi`, `conversations_ext_queue` and `blocks_ext_todo_task`
   (or whatever name the todo-task table actually has) match `main`.
5. Drive the app:
   - `./equin run plugins/tasks/plugins/auto-start/e2e/auto-start-verify.ts`.
   - the todo-dispatch e2e in `page/annotations/todo/task-link/e2e/`.
   - screenshots of the conversation sidebar queue, where order and pins must render.
   - screenshots of a Sonata song with transpose, chord mode and rhythm set.

## Implementation notes (what changed against the plan)

- **`defineExtension`'s generic is the whole shape** (`<Sh extends AnyExtensionShape, const M>`),
  not `<K, F, S, W>`. TypeScript cannot work the plugin's own fields back out of
  the complete record, so the precise types are read off the shape's own members.
- **`parsedTextField`'s `default` is now `NoInfer<T>`** (`fields/text/config`).
  Its literal default was also an inference site, which widened `T` to
  `string`. That silently dropped the union on task-effort, deploy-health's
  `failureKind` and progress's `phase` / `source`. `T` now comes from the schema
  alone.
- **`cli:codegen-manifests-not-frozen` was refined.** The deploy CLI reads the
  deploy-health table directly (it needs the server-only host-key pin). That
  table is now built by `defineEntity`, so the CLI's closure reached the
  `fieldsEager` manifest. The check now measures:
  - the startup closure, with each `defineCliCommand` `run` thunk cut out;
  - the run closure of every command whose live code calls the manifest writer
    (derived: today that is `build`, `regen-generated` and, conservatively,
    `check`).

  `importClosure` also now records every parsed module, not only the ones that
  survive tree-shaking. The runtime evaluates re-export barrels and side-effect
  manifests that the old sourcemap-based list dropped.
- **Deploy's unreachable platform checks.** `platform` is decoded against
  `PLATFORM_TAGS` whenever the server reads the column. So the
  `isPlatformTag(health.platform)` refusals in `run-deploy.ts` / `target.ts`
  can no longer fire. They are left in place because the writer only ever
  stores a valid tag or null.
- **Verified:**
  - `./equin build` generated no migration: all 23 tables are byte-identical.
  - All checks pass.
  - 234 tests pass.
  - `auto-start-verify.ts` passes.
  - The queue sidebar and a Sonata song render with their extension state.

## Out of scope — to file as follow-up tasks

- `windowQueryResource` / `queryResource` take an **untyped** `select` map. A map
  that leaves out a column is not a `tsc` error, and the derived schema's field
  `.default()` then fills in the missing value without any warning. This plan
  removes every such map over an extension, but the right fix is to type `select`
  against the descriptor's row type.
- Moving the three push resources that fold rows into a `Record` (task-effort,
  task-preprompt, turn-summary) to bounded point resources, under the
  bounded-working-set contract.
