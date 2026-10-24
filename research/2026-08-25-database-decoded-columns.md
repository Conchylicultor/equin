# Decoded columns — closing the `$type<Union>()` assertion hole

## Context

`sql-rows` closed `pool.query<Row>(sql)`. `sql-projection` closed ``sql<T>`…` ``
inside a drizzle projection. Both replaced a hand-written type with one *derived
from a decoder that really runs*.

The same assertion survives on a **column**. Five sites declare a string-literal
union over a plain `text` column with nothing verifying the stored value:

| site | asserted |
|---|---|
| `infra/jobs/server/internal/tables.ts:43` — `job_waits.status` | inline 4-value union |
| `tasks/auto-start/server/internal/tables.ts:8` | `ConversationModel` |
| `tasks/task-effort/server/internal/tables.ts:10` | `EffortLevel` |
| `apps/workflows/engine/server/internal/tables.ts:26` | `ExecutionStatus` |
| `apps/workflows/engine/server/internal/tables.ts:47` | `ExecutionStepStatus` |

`$type<T>()` changes **no runtime behaviour at all** — unlike `.mapWith`, which
is why the projection fix does not transfer. A row written by an older schema
version, by hand, or by a worktree on different code reads back as a well-typed
value that is not in the union, and every downstream `switch` falls through.

**It has already bitten, and the hedges are still in the tree.** Two of the five
unions carry a `tolerantEnum(…)` wrapper at the *live-state resource* boundary —
`StoredModelSchema`, `StoredEffortSchema` — created for exactly this reason, with
the rationale written into `model-provider/core/registry.ts`:

> THE schema for any *persisted* model id read back through a live-state
> resource. Tolerant by construction … Use this — never the raw strict
> `ConversationModelSchema` — for a stored model field.

That guard sits on the **wire**, not on the **column**, so it protects the browser
and nothing else. Two server-side readers go straight to the raw column and would
crash on a value the guard exists to absorb:

- `conversations/server/internal/auto-start-jobs.ts:89` — `ext.autoStartModel` →
  `createConversation({ model })` → `cliFlagFor(id)` → `MODEL_REGISTRY[id].cliFlag`
  → `TypeError` on a legacy `"opus"` row.
- `conversations/server/internal/lifecycle.ts:49` — `resolveTaskEffort` →
  `EFFORT_REGISTRY[level].effortFlag` → same.

**Intended outcome:** a column's declared type is derived from a decoder that runs
on every read *and* every write, so it is true by construction — and the spelling
that lets you name a column type without one no longer typechecks past lint.

### Measured facts (drizzle-orm 0.36.4 / drizzle-kit 0.28.1, read from source and probed)

1. `PgCustomColumn.mapFromDriverValue(v)` is `this.mapFrom(v)` and
   `mapToDriverValue(v)` is `this.mapTo(v)` (`pg-core/columns/custom.js:33-38`).
   Both are **method calls**, so a non-arrow `fromDriver`/`toDriver` receives the
   built column as `this` — probed live: `this.constructor.name === "PgCustomColumn"`,
   `this.name === "status"`, `getTableName(this.table) === "job_waits"`. That is
   what lets the error say `job_waits.status` from inside drizzle's result mapping.
2. `getSQLType()` returns `dataType(config)` verbatim (`custom.js:30`). drizzle-kit
   reads `column.getSQLType()` into the snapshot's `type` field with **no branch on
   the column class** (`bin.cjs:19262`), and `"text"` is in its `pgNativeTypes`
   whitelist (`bin.cjs:24661`), so it renders unquoted. A customType returning
   `"text"` is **byte-identical in DDL and snapshot** to `text("x")`. No migration.
   (Contrast: `rank_text` / `bytea` / `tsvector` — this repo's three existing
   customTypes — are not whitelisted and render double-quoted.)
3. `.default(v)` stores the raw JS value and drizzle-kit reads it raw
   (`column-builder.js:51`, `bin.cjs:19307-19325`). `toDriver` is never applied to
   a default, and a string default renders `'pending'` for both column kinds. So
   `.default("pending")` on sites D/E is unaffected.
4. **A decoder never sees `null`**, in either direction: `mapResultRow` guards
   `rawValue === null ? null : decode` (`utils.js:28`), and the `Param` encoder
   guards `chunk.value === null ? null : encode` (`sql/sql.js:131`). So the
   decoder states the **shape**; nullability stays drizzle's own, derived from
   whether the builder chain calls `.notNull()` — exactly as for `text()`.
5. `mapToDriverValue` runs on INSERT `.values()` (`insert.js:37`), UPDATE `.set()`
   (`utils.js:86`), and every bound comparison param — `eq` / `inArray` / `gt` / …
   via `bindIfParam` (`conditions.js:14-19`). One decoder covers both directions.
6. All five value sets are **closed** and hand-written in `core/`; four already
   have the zod enum that *defines* the type (`ConversationModel = z.infer<typeof
   ConversationModelSchema>`, and so on). Only `job_waits.status` has no schema.
7. Live data across all five columns is **in-set** (`job_waits`: pending/resolved/
   timed_out; `tasks_ext_auto_start`: opus-4-8/opus-5/fable-5/sonnet-4-6;
   `tasks_ext_effort`: ultracode; both workflow tables empty). Nothing to migrate.

## Design

### The end-user experience

```ts
import { parsedText } from "@plugins/database/plugins/sql-column/server";

export const _jobWaits = pgTable("job_waits", {
  status: parsedText("status", JobWaitStatusSchema).notNull(),
  //      ^? text column, select type "pending" | "resolved" | "timed_out" | "cancelled",
  //         and that type is z.infer of the schema that actually runs on it
});
```

and when a row disagrees:

```
SqlColumnError: a column value is not one of the values its type allows.
  column: job_waits.status
  direction: read (decoding a value out of Postgres)
  value: "running"
  Invalid enum value. Expected 'pending' | 'resolved' | 'timed_out' | 'cancelled', received 'running'
  why: the row holds a value the column's schema does not accept — written by an
       older schema version, by hand, or by a worktree on different code. Widen
       the schema and handle the new value downstream, migrate the rows, or — if
       the value set legitimately evolves — give the column a tolerant schema
       (`tolerantEnum`), which normalizes and reports instead of throwing.
```

### Why `customType` is the mechanism

`.mapWith` has no column-side twin, but `customType` does the same job one layer
lower: `customType<{ data: T; driverData: string }>` computes the column's select
type **from `data`**, and `data` is bound to `z.infer` of the schema by
`parsedText`'s own signature:

```ts
export function parsedText<T extends string>(name: string, schema: ZodParser<T>)
```

`T` is inferred *from the schema argument only*. There is no second place to write
a type, so the declared type cannot be chosen independently of what runs — rung 1.
`T extends string` is what makes it a *text* column's decoder: a schema producing
a `Date` or an object has no spelling here.

Nullability needs no helper (unlike `nullable` in `sql-projection`): drizzle
derives it from `.notNull()` on the builder chain, and fact 4 says the decoder is
never handed a `null` in either direction.

### One decoder, both directions

`fromDriver` and `toDriver` are the **same** schema. That is the whole claim the
column makes — *its values are exactly what this schema produces* — and stating it
once means the two directions cannot drift.

The write half is not redundant with `tsc`. A value that reaches an insert through
a cast, a wire body, or an MCP tool argument is checked at the writer, where the
stack names the caller — instead of hours later at a read, where it names
`mapResultRow`. It also means the only out-of-set rows a read can ever meet are
ones this code did not write.

### Strict or tolerant is the author's choice, and both already exist here

The design question this task names — *what happens to rows written before the
values were narrowed?* — has already been answered in this repo, twice, by
`tolerantEnum` (`primitives/live-state/core`). `parsedText` takes a `ZodParser<T>`,
so both answers are spellable with no new vocabulary:

| the value set | schema | on an unknown value |
|---|---|---|
| closed, engine-internal, nothing has ever renamed one | the strict `z.enum` | throw `SqlColumnError` |
| evolves — ids get renamed, old rows outlive them | `tolerantEnum(strict, normalize, report)` | normalize to a valid value + fire the deduped corruption report |

Per-site:

| column | schema | why |
|---|---|---|
| `job_waits.status` | new strict `JobWaitStatusSchema` | private to the durable-workflow engine; only this code writes it |
| `tasks_ext_auto_start.auto_start_model` | `StoredModelSchema` | has `LEGACY_ALIASES` (`"opus"` → `"opus-4-6"`); rows outlive renames |
| `tasks_ext_effort.level` | `StoredEffortSchema` | same policy, already declared |
| `workflow_executions.status` | `ExecutionStatusSchema` | closed, engine-internal, zero rows |
| `workflow_execution_steps.status` | `ExecutionStepStatusSchema` | same |

Choosing the tolerant schema for the two model/effort columns is what **fixes the
two latent crashes above**: the normalization moves from the wire down to the
column, so every reader — the launch job included — gets a value that is in the
set. The resource-level `StoredModelSchema` / `StoredEffortSchema` stay where they
are: a WS payload has crossed a process boundary and must validate on its own.

### Enforcement — where on the ladder

**Rung 1** is the `parsedText` signature (the type has one source: the decoder).

**Rung 3** closes the spellings that let you name a text column's type *without*
one. `sql-column/no-asserted-column-type` reports both:

```ts
text("x").$type<T>()          // the assertion, 5 sites today
text("x", { enum: [...] })    // 0 sites today, banned anyway
```

The second is banned for the reason `no-asserted-sql-type` also bans
`.as<T>()` with zero occurrences: closing one door only moves the next author to
the other. `{ enum }` is *better* than `$type` — the type comes from a runtime
list rather than an unrelated type — but drizzle emits no `CHECK` for it, so the
stored value is still unverified.

Syntactic, not type-aware (matching `no-unparsed-sql-rows`, `no-asserted-sql-type`):
it fires when a `.$type<…>()` / `text(…, {enum})` chain **roots in a literal
`text(` / `varchar(` / `char(` call**. That root check is what keeps `jsonb(…)
.$type<…>()` (a weaker tier — pg really decodes JSON, so only the shape is
asserted) and `defineEntity`'s generic `b.$type()` out of scope, as intended.

### Considered and rejected

- **`pgEnum` / a `CHECK` constraint.** Strictly stronger — Postgres itself refuses
  a non-member, so even a hand-written `INSERT` cannot land one. (`check()` does
  exist in 0.36.4 and drizzle-kit 0.28.1 does emit it: `bin.cjs:25318`.) Rejected
  as the *general* mechanism because it makes the value set a **schema migration**:
  adding a model id would need DDL, and `ALTER TABLE … ALTER COLUMN … TYPE` against
  live rows fails on any pre-existing out-of-set value across every worktree DB
  fork. It is also flatly incompatible with the tolerant policy the two evolving
  columns need. Left as a follow-up for genuinely frozen sets.
- **A `data-migration` of legacy values.** Not needed: fact 7 says every live value
  is in-set.

## Implementation

### 1. `plugins/database/plugins/sql-column/`

```
CLAUDE.md
package.json
server/index.ts                        barrel: parsedText, SqlColumnError, formatSqlColumnError, SqlColumnFailure
server/internal/parsed-text.ts
server/internal/errors.ts
server/internal/parsed-text.test.ts    bun:test, co-located
lint/index.ts
lint/no-asserted-column-type.ts
lint/no-asserted-column-type.test.ts   RuleTester
```

`server/` (needs `drizzle-orm/pg-core`), and **lean** — the barrel must stay
importable from a `tables.ts`, which drizzle-kit loads synchronously. Precedent:
`primitives/collab-doc/server`. Its only imports are `drizzle-orm/pg-core`, the
`ZodParser` type, and `renderSqlValue` / `runtimeTypeOf` from `sql-rows/core` —
the same reuse `sql-projection` makes, so how a value is named and rendered is
stated once for all three guardrails.

The qualified label is read off `this` (fact 1) and **degrades, never lies**: a
future drizzle that detaches the call yields the bare column name, and
`parsed-text.test.ts` pins the qualified form through a real `pgTable` so the
degrade is a failing test rather than a quieter message.

### 2. Migrate the five sites

Each becomes `parsedText("<col>", <Schema>)` with the same modifiers. Plus:

- **`infra/jobs/server/internal/tables.ts`** — add `JobWaitStatusSchema =
  z.enum([...])` beside the table and export `JobWaitStatus` for the internal
  readers (`resume-job.ts`, `step-ctx.ts`, `abort-run.ts`) that compare it.
- **`apps/workflows/engine/server/internal/mutations.ts`** — `updateExecution` /
  `updateExecutionStep` take `patch.status?: string` today. Narrow to
  `ExecutionStatus` / `ExecutionStepStatus`: a tsc error beats the runtime throw
  the new encoder would otherwise be the first to raise (rung 2 over rung 4).

### 3. Docs

- `sql-column/CLAUDE.md` — the strict-vs-tolerant table, the measured facts, and
  the explicit statement that nullability is drizzle's, not the decoder's.
- `plugins/database/CLAUDE.md` — a third row in the **Typed at the SQL boundary**
  table; the trio is now around the row, inside the row, and on the column.
- Back-pointers from `sql-rows/CLAUDE.md` and `sql-projection/CLAUDE.md`.

### 4. Follow-up tasks (filed, not silently dropped)

- `defineEntity` applies `$type()` generically from a field's `FieldDef`, so an
  entity column backed by an enum field has the same unverified union. The fix is
  for the `fields.storage` capability to hand back a decoder — a design of its own.
  The lint rule does not reach it (no type argument, non-literal root).
- `jsonb(…).$type<T>()` — 18 sites, weaker tier.
- A `CHECK`-constraint variant for value sets that are genuinely frozen.

## Verification

- `./equin test plugins/database/plugins/sql-column` — decoder/encoder unit
  tests (qualified label through a real `pgTable`, `getSQLType() === "text"`,
  tolerant-schema normalization, write-side throw) and the lint `RuleTester` suite.
- `./equin check` — `migrations-in-sync` must generate **no** migration
  (fact 2 is the claim being tested); `eslint` must report zero remaining
  `text().$type<>()`; `type-check` catches any consumer relying on the old types.
- `./equin build`, then exercise the surfaces that read these columns: a
  task's auto-start chip and thinking-mode picker (Tasks detail → Prompt card),
  launching a queued task, and Debug → Queue (the `job_waits` rows behind a
  durable workflow).
