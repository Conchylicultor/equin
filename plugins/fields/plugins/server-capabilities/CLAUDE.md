# server-capabilities

The server-owned **field-capability library**. `storage` is the one capability
`fields` owns directly (see the parent `fields/CLAUDE.md`) — it is intrinsic to a
type's identity, so it lives on the server runtime to keep `drizzle-orm/pg-core`
out of the browser bundle. This leaf owns:

- the `Fields.Storage` + `Fields.ValueTextCast` server-contribution tokens,
- `resolveFieldStorage(typeId)` / `resolveFieldValueTextCast(typeId)`,
- the storage / value-cast contribution + builder types.

There is no filter-SQL capability any more. Filtering is the one filter language
(`network/live/plugins/filter`): each column declares a DOMAIN, the DataView
lowers its operators into the language in the browser, and the server compiles
the result with `filterSql` — no per-field-type SQL, and no registry consulted
at query time. The one per-type fact a server-delegated DataView still needs is
how a TEXT-stored custom-column value reads as SQL: `Fields.ValueTextCast`
contributes the cast (`(c)::numeric`, …), the domain that cast is filtered in
(`number`, …) AND the SQL type it produces (`numeric`, …) — what a live scroll's
cut over a sorted custom column casts its exact-text operand back to; a type with
no cast reads raw TEXT, in the `text` domain, as `text`.

## The storage contract: two arms, two different promises

A field type either has a **fixed** column, or its column is **narrowed by the
field's own schema** — and in the second case that schema is what must run for
the narrowing to be true.

```ts
export type StorageColumnFor<V> = PgColumnBuilderBase<
  ColumnBuilderBaseConfig<ColumnDataType, string> & { data: V }
>;

export type FieldStorageContribution<B = unknown> = { type: FieldType<B> } & (
  | { build: (name: string) => StorageColumnFor<B>; decode?: never }
  | {
      decode: <V extends B>(name: string, valueSchema: ZodParser<V>) => StorageColumnFor<V>;
      build?: never;
    }
);
```

The signature it replaced — `(name: string) => PgColumnBuilderBase` — lost both
halves: it never saw the schema, so it *could not* decode, and its return type
said nothing, so a `date` token handing back a `boolean()` column typechecked.
Now:

1. *Inexpressible* — a `decode` arm cannot return a plain `text(name)`. Its
   return type is `StorageColumnFor<V>` for a caller-chosen `V`, and the only
   text builder producing one is `parsedText`, whose `V` is inferred from the
   schema argument and from nowhere else.
2. *Type error* — every builder's return type is pinned to its token's declared
   value type.
3. *Check/lint* — the escape hatch, `text(name).$type<V>()`, writes `text(`
   literally, which is exactly the root `sql-column/no-asserted-column-type`
   already scopes on. No new rule. On the jsonb side `$type` is not even a
   spelling: drizzle's `$Type<T, TType>` writes `_.$type` and never `_.data`,
   which is what `StorageColumnFor` reads, so an author who wanted to assert
   would have to write a bare cast — visible as one, and the only cast left in
   these arms is `widestJsonColumn`'s, which carries its proof beside it.

Three types decode — `text`, `json`, `tags` — and `bool` / `int` / `float` /
`date` / `uuid` / `rank` are fixed. **No arm asserts.** That is what makes
`defineEntity`'s `EntityColumns` cast a pure re-statement for every column in
every entity rather than the place a jsonb column's `T` came from.

Each decoding arm branches on the schema the author actually wrote, so a schema
that does not narrow the column gets no decoder and pays nothing: `text` on
`ZodString`, `json` on `ZodUnknown`. `tags` has no such branch — its token
declares `string[]`, which no `ZodUnknown` can produce, so every tags column
decodes.

Design: `research/2026-08-25-global-decoded-entity-columns.md` (the text tier)
and `research/2026-08-26-global-decoded-jsonb-entity-columns.md` (the jsonb
tier, where the cost question is settled: a zod parse costs what the SCHEMA's
depth costs, not what the payload's size costs, so the per-field opt-in dial that
tier seemed to need is the schema itself).

**`resolveFieldStorage(typeId)` returns the whole contribution**, not a builder,
because the caller must pick an arm — and only the caller (`defineEntity`) holds
the field schema the `decode` arm needs.

## Why a separate leaf (not `fields/server`)

`resolveFieldStorage` runs SYNCHRONOUSLY at module-eval inside `defineEntity`
(drizzle `pgTable(...)` needs the column builders eagerly) — BEFORE the boot-time
`collectContributions` pass populates the live registry. So the `Fields.Storage`
token records each contribution into a module-level **eager index** the instant
it is DECLARED — through the token's own `project`, never a wrapper, so every
read (`getContributions`, `getContributionsIfCollected`, `from`) is the real
token's; the resolvers read `live ?? eager`.

For the eager index to be populated, every capability barrel must have been
evaluated. That is done by static side-effect imports (the `eager.generated`
manifest) — but a manifest that imports the barrels, imported by the token owner,
would form the exact `fields ⇄ fields/<type>/storage` cycle the
boundary checker rejects (the barrels import the tokens back).

So this plugin is a deliberate graph **SINK**: it defines the tokens/resolvers and
imports ONLY `framework/server-core/core`, `fields/core`, and drizzle types — it
NEVER imports a capability barrel. The side-effect manifest that forces the
barrels to evaluate lives in the sibling `server-capabilities-loader` plugin,
which every eval-time consumer imports for side-effect. Closure:
`loader → barrels → server-capabilities` — a clean DAG.

## Consumers

Import the tokens/resolvers directly from this barrel (never re-exported through
`fields/server`, which no longer exists):

- capability barrels — `Fields.Storage(...)` / `Fields.ValueTextCast(...)`,
- `infra/entities` (`defineEntity` → `resolveFieldStorage`),
- `primitives/data-view/custom-columns` (`resolveFieldValueTextCast`).

`infra/entities` ALSO imports `@plugins/fields/plugins/server-capabilities-loader/server`
for side-effect so the eager index is populated before its first
`resolveFieldStorage` call. (`ValueTextCast` is read at request time only, so
the live registry suffices.)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Server-owned field-capability library: the Fields.Storage / Fields.ValueTextCast tokens, their resolvers (resolveFieldStorage / resolveFieldValueTextCast — the latter answering a TEXT-stored value's cast AND the filter-language domain it reads in), and the storage eager self-registering index. A graph sink — never imports a capability barrel.
- Cross-plugin:
  - Imported by:
    - `fields/bool/storage`
    - `fields/bool/text-cast`
    - `fields/date/storage`
    - `fields/date/text-cast`
    - `fields/float/storage`
    - `fields/int/storage`
    - `fields/json/storage`
    - `fields/location/storage`
    - `fields/number/text-cast`
    - `fields/rank/storage`
    - `fields/tags/storage`
    - `fields/text/storage`
    - `fields/uuid/storage`
    - `infra/entities`
    - `primitives/data-view/custom-columns`
- Server:
  - Exports (types):
    - `FieldStorageContribution`
    - `FieldValueTextCastContribution`
    - `FieldValueTextRead`
    - `StorageColumnBuilder`
    - `StorageColumnFor`
    - `ValueTextCast`
  - Exports (values):
    - `Fields`
    - `resolveFieldStorage`
    - `resolveFieldValueTextCast`

<!-- AUTOGENERATED:END -->
