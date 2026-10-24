# `indexes` option on `defineExtension`

## Context

`defineExtension(parentTable, name, columns)`
(`plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`)
builds `<parent>_ext_<name>` with exactly one index: the implicit btree behind
the `parent_id` primary key. There is no way for a consumer to declare an index
on any of the columns it adds.

Extension tables are not always read by parent id. The handle's own methods
(`get`/`upsert`/`delete`) are `parentId`-only, but `.table` is deliberately
exposed so the defining plugin can compose richer drizzle queries — and two of
them key on a foreign column today:

- `tasks_ext_prompt_block.block_id` — "which tasks did this prompt block
  launch?" (`plugins/page/plugins/prompt/plugins/link/server/internal/resource.ts:42`),
  `WHERE block_id = X ORDER BY created_at`. The table's own comment already
  names this an unindexed seq scan and names the fix: *"the structural fix is an
  `indexes` option on `defineExtension` — filed as task
  `task-1785249879009-19heph` — not a hand-written migration in this plugin."*
- `tasks_ext_health_review.review_id` — "which tasks belong to this review?"
  (`plugins/plugin-meta/plugins/plugin-health/server/internal/routes.ts:37`),
  `WHERE review_id = X` joined to `_tasks`.

Neither has an index and there is no supported way to add one: the migration
workflow forbids hand-editing generated SQL, and every `_ext_` migration in
`plugins/database/plugins/migrations/data/` confirms it — zero `CREATE INDEX`
statements on any extension table.

The sibling primitive `defineEntity` already solved this with `meta.indexes`
(`plugins/infra/plugins/entities/server/internal/define-entity.ts:125-145`), a
passthrough into `pgTable`'s third-argument array. This change gives
`defineExtension` the same capability, adapted for one difference that matters:
an extension's **table name is derived**, not authored, so the caller cannot
write a drift-free index name by hand.

Outcome: an extension owner declares its own indexes next to its own columns,
`./equin build` generates the migration, and the two known seq scans go
away.

## Design

### API — name-bound index builders

Optional 4th argument, an options object (room to grow, mirroring
`defineEntity`'s `meta`). The `indexes` callback receives the typed columns
`t` **and** a builder pair `b` pre-bound to the derived table name, so the
caller supplies only a short table-local suffix:

```ts
export const promptBlock = defineExtension(
  _tasks,
  "prompt_block",
  {
    pageId: text("page_id").notNull(),
    blockId: text("block_id").notNull(),
  },
  {
    // b.index("block_created") → index("tasks_ext_prompt_block_block_created_idx")
    indexes: (t, b) => [b.index("block_created").on(t.blockId, t.createdAt)],
  },
);
```

`b.index(suffix)` / `b.uniqueIndex(suffix)` return drizzle's own builders, so the
full expressive surface stays available — `.on()`, `.using("gin", …)`,
`.where(sql\`…\`)`, `.desc()` — exactly as in
`plugins/release/server/internal/tables.ts` and
`plugins/search/plugins/engine/server/internal/tables.ts`.

**Why this deviates from `defineEntity`'s full-name form.** `defineEntity`'s
caller authors the table name, so writing `index("slow_ops_kind_idx")` duplicates
nothing. `defineExtension`'s caller does not: `tasks_ext_prompt_block` is
computed from `getTableName(parentTable)` + `name`. Requiring the caller to
re-type it as a string is a drift the primitive can simply remove — a typo or a
later parent rename yields a silently misleading index name that Postgres accepts
without complaint. Binding the prefix makes a wrong name unrepresentable.

`t` is typed as `BuildExtraConfigColumns<string, ExtensionColumns<C>, "pg">`
(same shape as `EntityMeta.indexes`, `plugins/infra/plugins/entities/server/internal/types.ts:167`),
where `ExtensionColumns<C> = BaseColumns & C` — so `parentId`, the user columns,
`createdAt` and `updatedAt` are all indexable and all precisely typed.

### Two loud failures the primitive should add

Both are module-eval throws, in keeping with fail-loudly:

1. **Reserved column names.** `columns` containing `parentId`, `createdAt` or
   `updatedAt` today produces an incoherent table (the runtime spread order lets
   `parentId` lose to the user column but `createdAt`/`updatedAt` win). Throw
   instead.
2. **Identifier length.** `${tableName}_${suffix}_idx` over Postgres's 63-byte
   limit is silently truncated, which can collide with another index. Throw with
   the offending name. Also validate the suffix shape (`/^[a-z0-9_]+$/`,
   non-empty).

## Files to change

**`plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`** — the primitive.

- Extract the three fixed columns into a non-generic `baseColumns(parentTable: ParentTable)`
  helper and derive `type BaseColumns = ReturnType<typeof baseColumns>`, so the
  `ExtensionColumns<C>` type used by the callback cannot drift from the runtime
  columns. Keep the runtime key order **exactly** as today —
  `{ parentId, ...columns, createdAt, updatedAt }` — so drizzle-kit sees no
  column reordering and generates no spurious migration.
- Add `ExtensionIndexBuilders` + `ExtensionMeta<C>` interfaces and the optional
  4th parameter (defaulting to `{}` — every existing call site keeps compiling
  untouched).
- Pass `(t: any) => meta.indexes?.(t, builders) ?? []` as `pgTable`'s third
  argument. The single `as any` at the runtime/type boundary is the same one
  `define-entity.ts:125` uses.
- Export `ExtensionMeta` / `ExtensionIndexBuilders` types from
  `plugins/infra/plugins/entity-extensions/server/index.ts`.

**`plugins/infra/plugins/entity-extensions/server/internal/index-names.ts`** (new)
— pure name derivation + the two validations, with no `db` import, so it is unit
testable. `define-extension.ts` imports `db` at module scope, which is why this
logic gets its own file rather than living inline.

**`plugins/infra/plugins/entity-extensions/server/internal/index-names.test.ts`** (new)
— `bun:test`, next to source per the testing convention: name derivation,
suffix validation, the 63-byte throw, the reserved-key throw.

**`plugins/page/plugins/prompt/plugins/link/server/internal/tables.ts`** — declare
`b.index("block_created").on(t.blockId, t.createdAt)`. The composite serves both
reads in `resource.ts`: `WHERE block_id = X ORDER BY created_at` (index-ordered,
no sort node) and the scoped refill `WHERE block_id = X AND parent_id IN (…)`.
Delete the "UNINDEXED seq scan / filed as task" paragraph from the file comment.

**`plugins/plugin-meta/plugins/plugin-health/server/internal/tables.ts`** — declare
`b.index("review_id").on(t.reviewId)` on `healthReviewExt`.

**Docs.**
- `plugins/infra/plugins/entity-extensions/CLAUDE.md` — add an `indexes` section
  to the API block (the derived-name rule, the two throws, when *not* to bother:
  a table read only by `parent_id` needs nothing).
- `plugins/page/plugins/prompt/plugins/link/CLAUDE.md` — rewrite the last
  paragraph of "Why the block-keyed resource is hand-written"; the seq scan and
  its filed task are gone.

**Migrations.** Generated by `./equin build`, never hand-written: two
`CREATE INDEX` statements. Commit the generated `.sql` + snapshot.

## Not in scope

The task also notes the gap is *silent* — nothing warns that the column you
filter on is unindexed. That detector is a separate, table-agnostic feature (the
natural shape is a scheduled monitor over `pg_stat_user_tables` filing a
`seq-scan-pressure` report through the existing reports engine, alongside
`debug/queue-health` and `debug/op-rate`, catching every table rather than only
extension tables). File it with `add_task` rather than bundling it here.

Also considered and rejected: reimplementing `defineExtension` on top of
`defineEntity` to inherit `meta.indexes` for free. They take different inputs —
raw drizzle column builders vs a `FieldsRecord` — so this would force all 22
consumers to re-express their columns as fields. A separate migration if ever
wanted, not a prerequisite for an index.

## Verification

1. `./equin build` — regenerates the two migrations and the plugin docs,
   then applies the migrations on server restart.
2. `./equin check` — `migrations-in-sync` (generated SQL committed),
   `type-check` (the new generics compile, all 22 existing call sites still
   typecheck against the now-4-arity signature), `table-defs-in-schema-glob`,
   `plugins-doc-in-sync`.
3. `bun test plugins/infra/plugins/entity-extensions/server/internal/index-names.test.ts`.
4. `query_db` MCP against this worktree:
   `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename LIKE '%\_ext\_%' ORDER BY 1;`
   → expect `tasks_ext_prompt_block_block_created_idx` and
   `tasks_ext_health_review_review_id_idx` alongside the two pkeys.
5. Confirm the index actually serves the block read (these tables are small
   enough that the planner will still prefer a seq scan, so force it):
   `SET enable_seqscan = off; EXPLAIN SELECT parent_id, page_id, block_id, created_at FROM tasks_ext_prompt_block WHERE block_id = '<id>' ORDER BY created_at;`
   → expect `Index Scan using tasks_ext_prompt_block_block_created_idx` with
   **no** `Sort` node above it.
6. End-to-end sanity in the app: open a page with a `/prompt` block that has
   launched tasks (`http://<worktree>.localhost:9000/pages`) and confirm the
   launched-conversation chips still render, and that the task detail's origin
   backlink still resolves — i.e. the resource reads are unchanged in behavior.
7. `add_task` the follow-up unindexed-read detector.
