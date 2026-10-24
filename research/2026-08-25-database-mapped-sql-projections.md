# Mapped SQL projections — closing the `sql<T>` assertion hole

## Context

`plugins/database/plugins/sql-rows/` closed the `pool.query<Row>(sql)` hole: a raw
SQL **row** read is now parsed at the boundary instead of asserted, and
`sql-rows/no-unparsed-sql-rows` keeps the other doors shut. Its own research doc
named the remaining half as out of scope:

> `sql<T>\`…\`` inside a drizzle **select projection** is the same assertion one
> layer down, but the fix is different in kind: drizzle offers `.mapWith()` for
> exactly this.

This is that follow-up.

In drizzle, every **column** carries a decoder (`mapFromDriverValue`), so its
declared type and its runtime mapping come from the same object and cannot
disagree. A raw `sql<T>` projection is the one field kind in drizzle whose type
is written by hand and whose decoder is `noopDecoder` — the identity function.
`tsc` is satisfied, the code reads as typed, and whatever the driver produced is
handed to typed code as if it matched.

**Intended outcome:** a raw SQL projection's declared type is *derived from a
decoder that really runs*, so it is true by construction — and the spelling that
lets you write a type without one no longer typechecks past lint.

### Measured facts (verified against drizzle 0.36 in `node_modules`, and the live cluster)

1. `SQL.decoder = noopDecoder` (`sql/sql.js:44`). `mapResultRow` reads
   `field.sql.decoder.mapFromDriverValue` (`utils.js:14-18`) — so an unmapped
   projection hands through the raw driver value.
2. `mapWith<TDecoder>(decoder): SQL<GetDecoderResult<TDecoder>>`
   (`sql/sql.d.ts:84`). **The type is computed from the decoder.** You cannot
   choose it independently of the runtime behaviour. `GetDecoderResult` accepts a
   drizzle `Column` (→ that column's data type) or a plain
   `(value: any) => TData` (→ `TData`).
3. `pgView(name).as(qb => …)` stores the **same** `SQL.Aliased` objects
   (`pg-core/view.js:24-43`), and `SelectionProxyHandler` hands out
   `value.clone()`, which is `new Aliased(this.sql, alias)` — the *same* `sql`
   object. So a decoder attached in a view definition is the decoder every
   `db.select().from(view)` read uses. One place to fix; every read site fixed.
4. `mapResultRow` short-circuits `null` before the decoder
   (`utils.js:28`). **A decoder never sees `null`**, so it can make the shape
   true but can never police nullability — that stays the author's claim.
5. `drizzle-orm/node-postgres` overrides the pg type parsers so `TIMESTAMPTZ` /
   `TIMESTAMP` / `DATE` / `INTERVAL` arrive as their **raw string**
   (`node-postgres/session.js:57-75`), leaving the mapping to drizzle's column
   types. So `sql<Date | null>` in a drizzle projection actually delivers
   `string | null`. This is the trap `sql-rows/CLAUDE.md` documents under "The
   timestamp trap", and it is the only one the 23 sites actually stepped in.
6. `.mapWith()` changes no SQL text, so no view body and no migration changes.

### The audit: 23 sites, 3 lies

Every `sql<T>` in the repo was checked against the pg type its expression really
produces. Twenty are honest today (booleans from `bool`, `text` from `->>` and
`md5`, `text[]` from `array_agg` over `text`, `float8` from an explicit cast).
Three are lies, all the same one:

| site | declared | actually |
|---|---|---|
| `tasks-core/server/internal/views.ts:143` — `attempts_v.finishedAt` | `Date \| null` | `string \| null` |
| `tasks-core/server/internal/views.ts:287` — `task_completed_push.minCompletedPushAt` (CTE) | `Date \| null` | `string \| null` |
| `tasks-core/server/internal/views.ts:371` — `tasks_v.finishedAt` | `Date \| null` | `string \| null` |

Nothing crashes today, and the reason is itself the finding: the two server-side
consumers were written *defensively around the lie*.
`plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts:8` and
`handle-daily.ts:8` each open with

```ts
const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
```

and route **every** timestamp through it — including `createdAt` / `droppedAt` /
`heldAt`, which are real `Date`s. That helper exists for no other reason. On the
client the live-state schema's `z.coerce.date()` absorbs it. So the cost so far
is a permanent hedge in two files plus a landmine for the next author who trusts
the declared `Date`.

There is a second, quieter cost: `tasks_v.finishedAt` serialises to the wire as
`"2026-08-20 14:03:12.512+00"` while `createdAt` **in the same row** serialises
as `"2026-08-20T14:03:12.512Z"`, because one is a raw pg literal and the other a
real `Date`. Two formats for two timestamps in one payload.

## Design

### The end-user experience

```ts
import { nullable, parsed } from "@plugins/database/plugins/sql-projection/server";

qb.select({
  // an aggregate/CASE over ONE column — reuse that column's own decoder
  finishedAt: sql`CASE … END`.mapWith(nullable(pushes.createdAt)).as("finished_at"),

  // a composite shape — coercion has no answer, so parse it
  status:     sql`CASE … END`.mapWith(parsed(TaskStatusSchema)).as("status"),
  deps:       sql`array_agg(…)`.mapWith(parsed(z.array(z.string()))).as("dependencies"),

  // a plain scalar whose pg type is certain
  active:     sql`(${a} IS NULL OR ${b})`.mapWith(Boolean).as("active"),
})
```

and when a value disagrees:

```
SqlProjectionError: a SQL projection did not match its declared shape.
  projection: tasks_v.dependencies
  expected array, received string
  value: "{_private_jobs,migrations,graphile_worker}"
  hint: the value arrived as a string — pg has no type parser registered for its
        column type, so it is the raw Postgres literal. Cast the column
        (e.g. `::text[]`, `::int`, `::text`) or register a parser.
```

### Which decoder

The rule is one sentence: **pick the decoder that makes the declared type true
by construction.**

| the expression | decoder |
|---|---|
| *is* a column, or an aggregate / `CASE` over columns of one type | `.mapWith(thatColumn)` |
| …and can be `NULL` | `.mapWith(nullable(thatColumn))` |
| a composite shape — an array, a JSON object, a string-literal union | `.mapWith(parsed(schema))` |
| a plain scalar whose pg type is certain | `.mapWith(Boolean)` / `Number` / `String` |

`.mapWith(column)` is the strongest of the three: it reuses the exact decoder
drizzle applies to that column everywhere else, so the projection cannot drift
from the table it reads.

`parsed()` is for the shapes coercion cannot express — and it is the incident
class: `array_agg` over a `name` column produces `name[]` (OID 1003), for which
pg has no decoder, so the raw literal string arrives where `string[]` was
declared. That is precisely what `parsed(z.array(z.string()))` catches and
`.mapWith(String)` would not.

### The two helpers, and why each has to exist

```ts
/** A zod schema as a drizzle decoder. Throws SqlProjectionError, never returns a repaired value. */
export function parsed<T extends {}>(schema: ZodParser<T>, label?: string): (value: unknown) => T;

/** …and `NULL` is a legitimate value for this projection. */
export function nullable<D extends DecoderLike>(decoder: D): (value: unknown) => GetDecoderResult<D> | null;
```

- `nullable` exists because `GetDecoderResult<Column>` is the column's **data**
  type with no nullability, and (fact 4) a decoder is never called with `null` —
  so a column decoder alone cannot produce `SQL<Date | null>`. Its runtime
  null-guard is belt-and-braces; its real job is type-level.
- `parsed`'s `T extends {}` constraint **rejects a nullable schema**
  (`parsed(z.string().nullable())` is a tsc error), so nullability has exactly
  one spelling: `nullable(parsed(schema))`. One name per concept, enforced at
  rung 2.

All of this is verified — a probe compiled against the real drizzle types
confirmed `sql\`x\`` → `SQL<unknown>`, `.mapWith(Boolean|Number|String)` →
`boolean|number|string`, `.mapWith(col)` → `Date`, `.mapWith(nullable(col))` →
`Date | null`, `.mapWith(parsed(z.enum(["a","b"])))` → `"a" | "b"`,
`.mapWith(nullable(parsed(z.string())))` → `string | null`, and
`parsed(z.string().nullable())` → error.

### Enforcement — where on the ladder

The repo's ladder: 1 inexpressible → 2 type error → 3 check/lint → 4 loud
runtime → 5 docs.

**Rung 1 is already there, and is what makes this cheap.** Drop the type
argument and an unmapped projection is `SQL<unknown>` — honest, and unusable
downstream without handling it. There is no need for a rule demanding a decoder:
`tsc` demands one the moment you want a usable type. The only thing that has to
go is the one spelling that lets you name a type *without* a decoder.

**Rung 3 closes that spelling.** `sql-projection/no-asserted-sql-type` reports:

- a `sql\`…\`` tagged template carrying explicit type arguments — `sql<T>\`…\``;
- `.as<T>(…)` called on a `sql\`…\`` chain — drizzle's deprecated
  `SQL.as<TData>()`, the *identical* assertion. There are zero of these in the
  repo today, and it is banned for the same reason sql-rows keys on "rows were
  read" rather than "a generic was written": a rule that closed only `sql<T>`
  would push the next author onto a spelling that is exactly as unsafe.

Total and syntactic — no exemption by shape. Not type-aware, matching
`no-unparsed-sql-rows`, `no-raw-bun-spawn`, `no-narrow-zodtype`. `sql<string>`
gets no free pass: `sql<string>\`count(*)\`` is true only by luck, and
`.mapWith(String)` says the same thing while making it true.

### Scope

**In:** the 23 `sql<T>` sites; the new plugin; the lint rule; the two `toDate`
hedges the lie forced into the stats handlers.

**Out, checked and named** (each a follow-up, not an omission):

- `text("x").$type<SomeUnion>()` — 5 sites (jobs, auto-start, task-effort, two in
  workflows/engine). The same unchecked string→union, but on a *column*, where
  the fix is `customType`'s `fromDriver` rather than `.mapWith`. The repo has
  three `customType` definitions and **none** of them use `fromDriver`/`toDriver`
  today, so that is a design of its own.
- `jsonb(…).$type<T>()` — ~10 sites. A materially weaker risk tier: pg really
  decodes JSON, so only the *shape* is asserted.
- `db.select(…) as unknown as Promise<Row[]>` — 8 drizzle-result casts
  (`query-resource/compile.ts` + `compile-window.ts`, the `release` trio,
  `tasks-core/queries/tasks.ts`, …). A third class, invisible to both rules.
  One of them is deleted by this work (see below) as a demonstration.
- `pgView("task_blocking_v", { … })` — the one manual column list in the repo.
  Checked: it declares `text` + `boolean` over a `text` and a `bool_or(…)`
  column, and drizzle column decoders are real, so it is honest.

## Implementation

### 1. `plugins/database/plugins/sql-projection/`

```
CLAUDE.md
package.json
server/index.ts                    barrel: parsed, nullable, SqlProjectionError, SqlDecoder
server/internal/decoders.ts
server/internal/errors.ts
server/internal/decoders.test.ts   bun:test, co-located
lint/index.ts
lint/no-asserted-sql-type.ts
lint/no-asserted-sql-type.test.ts  RuleTester, mirrors no-unparsed-sql-rows.test.ts
```

`server/` rather than `core/`: it needs drizzle's `Column` / `GetDecoderResult`
types and every consumer is a server plugin — unlike sql-rows, whose callers
spanned `check/` and `cli/`. Precedent for a drizzle-only server barrel:
`plugins/primitives/plugins/collab-doc/server/index.ts`.

The diagnostic reuses sql-rows rather than restating it: export `runtimeTypeOf`
and a `castHintFor(expected, receivedType)` from
`@plugins/database/plugins/sql-rows/core` (both exist there as internals today)
and have both formatters call them. The "a string arrived where an array was
expected ⇒ no decoder for this OID" rule is one measured fact and belongs in one
place.

The lint rule mirrors `no-unparsed-sql-rows.ts` byte-for-byte in shape: a
`@typescript-eslint/utils`-only import (rule files are dual-loaded under jiti,
which cannot resolve `@plugins/*`), `ESLintUtils.RuleCreator`, a narrative
`meta.messages` entry, an in-rule owner-directory skip, `schema: []`. Its barrel
needs no registration — `./equin build` regenerates `lint.generated.ts`
from the filesystem.

### 2. Migrate the 23 sites

| shape | count | becomes |
|---|---|---|
| `sql<boolean>` over a `bool` expression | 12 | `.mapWith(Boolean)` |
| `sql<Date \| null>` over a `timestamptz` column | 3 | `.mapWith(nullable(<that column>))` |
| `sql<string[]>` over `array_agg` | 3 | `.mapWith(parsed(z.array(z.string())))` |
| `sql<union>` over a literal `CASE` | 2 | `.mapWith(parsed(AttemptStatusSchema \| TaskStatusSchema))` |
| `sql<string>` over `text` | 2 | `.mapWith(String)` |
| `sql<number>` over `float8` | 1 | `.mapWith(Number)` |
| `sql<unknown>` over `jsonb ->` | 1 | drop the type argument |

Files: `plugins/tasks/plugins/tasks-core/server/internal/views.ts` (15),
`plugins/debug/plugins/trace/plugins/engine/server/internal/handlers.ts` (2),
`plugins/page/plugins/links/server/internal/resources.ts` (2), and one each in
`conversations/plugins/session-chain/server/internal/record.ts`,
`conversations/plugins/agents/server/internal/views.ts`,
`apps/plugins/events/plugins/events-core/server/internal/{resources,events-repo}.ts`.

Two sites do more than swap a decoder:

- **`page/links/resources.ts`** — typing `iconSvgNodes` as
  `nullable(parsed(z.array(SvgNodeSchema)))` makes the select's row type
  structurally equal to `BacklinkRow`, so the
  `as unknown as Promise<BacklinkRow[]>` cast on line 36 is **deleted**. A real
  parse replaces a cast; the guardrail removes ceremony rather than adding it.
- **`tasks-core/views.ts`** — `finishedAt` becomes a real `Date`. That is a
  deliberate behaviour change, chosen over the inert alternative of retyping to
  `string | null`: `finishedAt` then matches its declared `TaskSchema` /
  `AttemptSchema` contract, matches its own sibling `droppedAt` in the same row,
  and serialises in the same ISO form as every other timestamp in the payload.
  `z.coerce.date()` on the client accepts both formats, so nothing on the wire
  breaks.

### 3. Delete the hedges the lie forced

`plugins/stats/plugins/tasks/server/internal/handle-cumulative.ts` and
`handle-daily.ts`: drop `toDate` and call `.getTime()` directly. Their
disappearance is the evidence the lie is gone.

### 4. Docs

- `plugins/database/plugins/sql-projection/CLAUDE.md` — the "which decoder"
  table, the four measured facts, and the explicit statement that **a decoder
  never sees `null`**, so nullability is declared (`nullable`), never checked.
- A new hand-written **"Typed at the SQL boundary"** section in
  `plugins/database/CLAUDE.md` naming both sibling guardrails (rows and
  projections) and which one owns which spelling. Today the only mention of
  sql-rows in that file is the autogenerated sub-plugin bullet.
- A back-pointer from `sql-rows/CLAUDE.md`'s "The timestamp trap" — the trap it
  documents is exactly the one all three lies stepped in.

### 5. Follow-up tasks

One task for `text().$type<Union>()` (the column twin, needing a `customType`
`fromDriver` design), one for the `as unknown as` drizzle-result cast bucket.

## Verification

- `./equin test plugins/database/plugins/sql-projection` — the decoder unit
  tests (including a `name[]`-as-raw-literal reproduction through `parsed`, and
  the null short-circuit) and the lint `RuleTester` suite.
- `./equin test plugins/tasks/plugins/tasks-core` — `views.test.ts` gains a
  case that reads `finished_at` and `status` **through the view object**
  (`t.db.select().from(tasks)`, not `db.execute(sql\`SELECT …\`)`, which bypasses
  the decoder by construction) and asserts `instanceof Date` and enum membership.
  That is the end-to-end proof that a decoder attached in a view definition
  survives to every read.
- `./equin check` — `eslint` must report **zero** remaining `sql<T>`, which
  is the proof the 23-site inventory was exhaustive; `type-check` catches any
  consumer that was relying on the old type.
- `./equin build`, then spot-check the surfaces that read these
  projections: the task list and a task's detail (`tasks_v.status` /
  `finishedAt` / `dependencies`), an attempt pane (`attempts_v`), Debug → Slow
  Events (the two trace projections), a page's backlinks (`page/links`), Events →
  Sources (the digest), and Stats → Tasks (the two handlers that lost `toDate`).
