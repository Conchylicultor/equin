# Drizzle-result casts — the classification, and what each class actually wants

## Context

Two guardrails now cover the SQL boundary from opposite sides:

- `plugins/database/plugins/sql-rows/` — a **raw SQL row read** is parsed, not asserted.
- `plugins/database/plugins/sql-projection/` — a **raw `sql` projection** carries a
  decoder, so its declared type is derived from something that runs.
- `plugins/database/plugins/sql-column/` — landed since, and load-bearing here: a
  **column** whose declared type is narrower than its Postgres type carries a
  decoder too (`parsedText` / `parsedJson`).

All three are invisible to a fourth spelling: force-casting a **drizzle query
result** past whatever drizzle inferred. `research/2026-08-25-database-mapped-sql-projections.md`
("Scope") named it as a follow-up bucket of ~8 sites and asked for a
classification pass before any rule.

This is that pass. The inventory is 14 cast expressions across 9 files (the
original note listed 8; two more turned up — `page/editor`'s blocks resource, and
two spot casts inside the query-resource compilers that are the same seam).

Those 14 are the sites this pass fixes, and they are not the whole class. An
exhaustive sweep run alongside the fix work found roughly twice as many again
outside them, in three further populations with root causes of their own — a
dynamically-registered table that has no static row type at all, a `$dynamic()`
query path that erases one, and generic machinery whose table parameter is
widened by its own signature. They are why this pass ships no lint rule. See
"The rest of the class — what this pass does not fix".

**The headline finding: eleven of the fourteen are not representation gaps at
all.** They are the mechanical consequence of three *declarations* being less
precise than the values they describe — a column, a projection, and a seam
interface. Fix the declaration and the cast has nothing left to say. Only one
real gap survives, and it is the same gap five times: `rank`.

## The inventory

| # | site | cast | class |
|---|---|---|---|
| 1 | `page/editor/server/internal/reconcile.ts:20` | `row.rank as unknown as string` | **A** stale |
| 2 | `release/server/internal/handle-candidate.ts:66` | `row as unknown as ReleaseRun \| undefined` | **B** the column |
| 3 | `release/server/internal/release-run-resource.ts:22` | idem | **B** |
| 4 | `release/server/internal/handle-latest-run.ts:41` | idem | **B** |
| 5 | `page/editor/server/internal/resources.ts:130` | `… as unknown as Promise<Block[]>` | **B′** the projection (+ **D**) |
| 6 | `query-resource/server/internal/compile.ts:115` | `query as unknown as Promise<Row[]>` | **C** the seam |
| 7 | `query-resource/server/internal/compile.ts:128` | `(await q) as Record<string, unknown>[]` | **C** |
| 8 | `query-resource/server/internal/compile-window.ts:137` | `… as unknown as Promise<Row[]>` | **C** |
| 9 | `query-resource/server/internal/compile-window.ts:276` | idem | **C** |
| 10 | `query-resource/server/internal/compile-window.ts:284` | `(await q…) as Record<string, unknown>[]` | **C** |
| 11 | `query-resource/server/internal/rel.ts:61` | `(r as { v: unknown }).v` | **C** |
| 12 | `tasks-core/server/internal/queries/tasks.ts:20` | `… as unknown as Task[]` | **D** `rank` |
| 13 | `tasks-core/server/internal/queries/tasks.ts:28` | idem | **D** |
| 14 | `tasks-core/server/internal/resources.ts:338` | `row as unknown as Task \| undefined` | **D** |
| 15 | `agents/server/internal/resources.ts:33` | `… as unknown as Promise<Agent[]>` | **D** |

(#5 is counted once but belongs to two classes — its projection is wrong *and*
it carries `rank`.)

Deliberately **out of scope**, and not casts of a query result:
`compile.ts:61` / `compile-window.ts:93` (`realDb as unknown as QueryDb`) assert
that the real drizzle `db` conforms to the hand-rolled seam interface, and
`rel.ts:35` erases a `Resource`'s contravariant params. Different claims,
different arguments; both already carry them.

---

## Class A — stale. Removable now, no other change.

`reconcile.ts:20` reads:

```ts
// drizzle types rank as the branded rankText; the reducer/diff treat it as a
// plain string.
rank: row.rank as unknown as string,
```

The comment is wrong and so is the cast. `rankText` is
`customType<{ data: string; driverData: string }>` — `BlockRow["rank"]` is
`string`, and `BlockNode["rank"]` is `string`. The cast asserts `string` is
`string`.

**Fix:** delete the cast and the comment.

## Class B — the *column* lied. Removable by fixing the declaration.

`release_runs.kind` and `.status` are `text(...)`, so drizzle infers `string`.
`ReleaseRunSchema` declares them `z.enum(["staged","candidate"])` and
`z.enum(["running","succeeded","failed"])`. Every read of the table therefore
differs from `ReleaseRun` in exactly two fields, and all three read sites paper
over it with the *identical* cast — which is what a repeated cast usually means:
the declaration, not the site, is where the fix belongs.

This bucket was un-fixable when the original note was written. It is not any
more: `sql-column`'s `parsedText(name, schema)` derives the column's select type
from a schema that really decodes it, and its DDL is byte-identical to `text`
(no migration).

**Fix:** hoist the two enums out of `ReleaseRunSchema` into named schemas, use
them in **both** places, and delete all three casts. Verified against the live
DB: `release_runs` holds one row, `('candidate','failed')` — inside both sets, so
a strict schema is the right policy (a closed set private to the release engine;
an outsider is a bug). `handle-history-query.ts` exposes `status` as a
data-view filter dimension, which is safe: a user-authored filter operand is
handed to the builder as a plain expression and never reaches the encoder
(`research/2026-08-27-global-filter-operand-domain.md`).

### B′ — the *projection* lied.

`blocksLiveResource` does `db.select().from(_blocks)` — the whole row, including
`deletedAt` and `trashEntryId`, which `BlockSchema` does not declare. (Nothing
leaks today: `z.array(BlockSchema)` strips them at the runtime parse. The cost is
a wider row read and a type that has to be asserted.)

**Fix:** an explicit projection of exactly the `Block` columns. Same shape as the
`page/links` backlinks cast that the sql-projection work deleted outright.

## Class C — the *seam* erased the type. Removable by typing the seam.

`query-resource` drives a deliberately drizzle-free interface so a fake db can be
injected in unit tests:

```ts
export interface QueryStep extends PromiseLike<unknown[]> { … }
export interface QueryDb { select(fields?: SelectMap): QueryFrom; … }
```

`unknown[]` is honest about drizzle, and it is *why* the compiler has to re-state
the row type six times. Nothing about the row type is actually guessed here: the
public entry points are `queryResource(descriptor, spec)` and
`windowQueryResource(contract, spec)`, so `Row` is pinned to the contract's
`ZodParser<Row>`, and the runtime parses **every** loader output against
`contract.schema` before the value is broadcast or cached
(`resource-runtime/core/runtime.ts` — `entry.schema.parse(await entry.loader(…))`).
The guarantee is real; it is just three modules away from the cast.

**Fix:** parameterize the seam — `QueryStep<Row = unknown>`,
`QueryFrom<Row = unknown>`, `QueryDb.select<Row = unknown>(…)`. The row type is
then declared **once, at the call that opens the query**, and flows through
`where`/`orderBy`/`limit` to the `await`. All six casts disappear with no runtime
change and no loss of enforcement. Both test fakes already go in through
`as unknown as QueryDb`, so a generic method signature costs them nothing.

Rejected: parsing inside the compiler's loader. It would double-parse every row
on the hottest path in the app (every live-state recompute), to restate a check
the runtime already performs at one chokepoint.

## Class D — a genuine representation gap: `rank`.

The DB column is a raw fractional-indexing key; the wire type is a `Rank` value
object. This is **deliberate and recorded** — `fields/plugins/rank/core`:

> The value type is `string` (the raw rank key), keeping `table.$inferSelect`
> honest. The `Rank` value-object transform (sort/compare/between) is a
> wire-schema concern a consumer layers on with `RankSchema`, never baked into
> the column.

So `Task`, `Agent` and `Block` differ from their stored rows in exactly one
field, and five sites assert the difference away. Two of the five
(`taskDetailResource`, `agentsResource`, `blocksLiveResource`) are resource
loaders whose value the runtime converts a moment later via `RankSchema`; two
(`listTasks`, `getTask`) are plain server functions that hand the row straight to
callers, so their `Task[]` is simply false — the `rank` in it is a `string`
wearing a `Rank` type.

Nothing reads `.rank` off `listTasks()`/`getTask()` today (checked: all 18 call
sites), so this is a landmine rather than a live bug. `Rank.compare` reads a
private field, so on a raw string it returns `0` for every pair — a silently
unsorted list, not a crash.

**Fix:** name the conversion, in the plugin that owns both representations.

```ts
// plugins/primitives/plugins/rank/core
export type Ranked<R extends { rank: string }> = Omit<R, "rank"> & { rank: Rank };
export function withRank<R extends { rank: string }>(row: R): Ranked<R>;
```

`rows.map(withRank)` against a declared `Promise<Task[]>` is checked by `tsc`:
every other field must line up, so a future column that stops matching its wire
schema is a compile error instead of a laundered lie. `RankSchema` accepts an
already-wrapped `Rank`, so the loaders that also pass through the runtime parse
stay correct.

Rejected: giving `rankText` a `fromDriver`/`toDriver` so the column itself yields
`Rank` (proposed once in `research/2026-05-04-global-rank-class-refactor.md`,
step 2, never taken). It is the rung-1 answer and it would delete the gap
outright — but it contradicts the recorded field-type decision above, changes the
`fields` registry's `rank` value type from `string` to a class instance (which
`fieldsToZodObject`, the data-view filter/sort path and every `StorageColumnFor<string>`
consumer read), and touches seven tables' write paths. That is its own design,
not a line item in a cast-classification pass.

---

## Enforcement — deferred, and why

The plan for this pass was a fourth sibling guardrail,
`plugins/database/plugins/sql-result/lint/no-asserted-query-result`, reporting a
type assertion applied to a drizzle query chain. **It is not being written yet.**

The reason is the sweep. A rule is worth writing when the class it closes is one
population with one root cause, because then every site either gets fixed or is a
bug. This class is four populations, and only the first has been fixed. The other
three are not sloppiness at the call site — each is the visible end of a
different upstream design, and a rule shipped today would have to carry a
day-one exemption for each. An exemption list written before the designs exist is
a rule that documents the hole instead of closing it, which is exactly the
"premature" the original note warned about.

Concretely, a syntactic chain-matcher fires immediately on at least two sites it
has no business reporting: `events/server/internal/resources.ts:34`
(`(await db.select().from(table)) as Row[]`) and
`trigger-contributions.ts:59` (`.delete(table).where(…).returning({ jobName }) as
{ jobName: string }[]`). Both cast a query over a table assembled at runtime from
column builders, so there is no static row type for the cast to contradict —
these casts *widen* rather than assert, which is the opposite of the mistake the
rule exists to catch.

So the rule becomes writable once each population is either fixed or carries a
stated, reviewed exemption:

- population 2 needs the trigger registry to carry a row schema, which is its own
  design;
- population 3 needs one shared fix at the `$dynamic()` seam and in
  `keyValuesOf`'s signature — five handlers repeating two casts is one cause, not
  five;
- population 4 needs its widened table parameters narrowed, or an explicit
  "generic machinery is exempt, here is the boundary" decision.

When it is written, the shape is already known and does not change. It should be
syntactic, like `no-unparsed-sql-rows` and `no-asserted-sql-type`, and key on the
builder-chain **shape** rather than a bare method name — `select`, `insert`,
`update`, `delete` and `execute` are all ordinary method names elsewhere
(`cache.delete(k)`, `child.execute(argv)`), so an opener earns a report only when
it sits on something spelled like a db handle, or when the spine also carries a
builder link (`.from` / `.values` / `.set` / `.returning` / `.where` / `.orderBy`
/ a `*Join`). `as const` and a bare `as unknown` are not assertions of a row type
and must stay unreported. Its message should name the three fixes — the column
(`sql-column`), the projection (`sql-projection`), a named conversion
(`withRank`) — rather than just refusing.

Its honest limit is worth recording now, because it decides how much the rule can
ever be worth: it sees the *builder-chain* spelling (7 of the 14 sites here), not
`const [row] = await db.select(…); row as unknown as X`, where the assertion is
applied to a plain identifier and nothing syntactic connects the value back to
the query. Catching those needs a type-aware rule, which none of the three
existing guardrails is.

## The rest of the class — what this pass does not fix

Line numbers are as verified against the working tree while three agents were
editing classes A–D; none of the files below is one of theirs, so they should
still be exact.

### Population 2 — a table with no static row type (≈14 casts, 7 files)

`defineTriggerEvent` assembles its table at runtime from column builders the
caller supplies, so the `PgTable` it produces has no per-column type. Every read
and every write against it then has to reach for a column dynamically and name
what came back:

- `plugins/infra/plugins/events/server/internal/resources.ts:34`
- `plugins/infra/plugins/events/server/internal/event.ts:128, 137, 192, 211, 230, 232, 234, 237`
- `plugins/infra/plugins/events/server/internal/trigger.ts:91, 106, 123, 126`
- `plugins/infra/plugins/events/server/internal/trigger-contributions.ts:55, 59`
- `plugins/infra/plugins/events/server/internal/dispatch-job.ts:61, 104`
- `plugins/infra/plugins/events/server/internal/handle.ts:46, 49`
- `plugins/apps/plugins/workflows/plugins/engine/server/internal/mutations.ts:168`

These are the opposite of classes A–D. They **widen** — `Record<string, any>`,
`(table as any).id` — rather than narrowing a known row into a wire type, so
there is nothing here for `tsc` to have caught and no declaration to make more
precise. What they cost is that the trigger row's shape is stated nowhere: rename
a base column, or let a contributed filter column collide with one, and nothing
fails until a dispatch reads `undefined` and the subscribed job silently never
runs. That is the user-visible risk — an event that stops firing with no error
anywhere.

The fix it wants is upstream of all of them: `defineTriggerEvent` should carry a
row schema for the table it mints, so the registry hands back a typed table
instead of a bare `PgTable` and the dynamic column reads become ordinary ones.
That is its own design, not a line item here.

### Population 3 — the keyset handlers (8 casts, 5 handlers)

The same two casts, repeated in five places:

- `plugins/conversations/plugins/all-conversations/server/internal/handle-query.ts:129, 141`
- `plugins/apps/plugins/deploy/plugins/deployments/server/internal/handle-runs-query.ts:159, 171`
- `plugins/apps/plugins/events/plugins/event-list/server/internal/handle-query.ts:134`
- `plugins/apps/plugins/mail/plugins/threads/server/internal/handle-query.ts:61`
- `plugins/release/server/internal/handle-history-query.ts:140, 153`

They have two distinct causes, and both are one fix away rather than five.

The first cast is `keyValuesOf(row as unknown as Record<string, unknown>, keys)`.
`keyValuesOf` takes an untyped bag (`primitives/keyset/server/internal/seek.ts:146`),
so every caller launders its perfectly good row into one — the mail handler does
it over a plain typed `db.select().from(_mailThreads)`, with no `$dynamic()`
anywhere in sight. Making the parameter generic (`<R extends object>`) deletes
all five with no runtime change.

The second cast is `items as unknown as Conversation[]` and its three siblings,
and it is the `$dynamic()` path: the handler projects the base columns plus the
augmentors' sort-key columns, deletes the augmentor keys from each row afterwards
so the strict wire schema will accept it, and then re-declares the result. The
risk of leaving it is the one class B′ already demonstrated — the cast is what
lets the projection and the wire schema drift apart, so a column added to one and
not the other is found by a user, not by `tsc`. The fix is at the seam: the
`$dynamic()` query path should return the row type it projected, with the
augmentor-key strip expressed as a typed `Omit`, rather than every consumer
restating the answer.

### Population 4 — generic machinery (12 casts, 4 files)

- `plugins/infra/plugins/entities/server/internal/define-entity.ts:127, 183, 231`
- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts:86, 95, 152`
- `plugins/infra/plugins/retention/server/internal/define-retention.ts:119`
- `plugins/primitives/plugins/rank/server/internal/helpers.ts:23, 42, 78, 87, 105`

These sit inside the factories, not at call sites, and most of them are not casts
of a query result at all — they are casts of a *table* or a *column-builder
record* to satisfy drizzle's overloads inside a generic body, with the precise
type restored by the declared return type the caller sees. The row casts that do
appear are downstream of that widening rather than independent claims:
`define-extension.ts:95` names `rows[0]` because the query ran against the loose
`t` alias declared nine lines above it, and the five in `rank/server`'s helpers
exist because the parameter is `PgTable & { rank: AnyPgColumn }`, which makes
`.select({ rank: table.rank })` yield a column of unknown type — so
`(last as { rank: string } | undefined)?.rank` is the same claim five times over.

The risk here is the lowest of the three and the blast radius the largest: each
one is contained inside a factory whose external contract is precise, but a
factory is what every table in the repo is built through. The fix the rank
helpers want is a narrower parameter — the rank column's type is knowable, so
`PgTable & { rank: PgColumn<{ data: string; … }> }` removes all five. `entities`
and `entity-extensions` deserve a deliberate decision rather than a fix: either
narrow the generic bodies or state that generic machinery is exempt, and where
the boundary of that exemption is. Whichever it is has to be written down before
a rule can be, because these are the sites that would otherwise become its
`eslint-disable` comments.

## Implementation

1. **A** — `page/editor/reconcile.ts`: delete the cast + comment.
2. **B** — `release/core/resources.ts`: export `ReleaseRunKindSchema` /
   `ReleaseRunStatusSchema`; `release/server/internal/tables.ts`: `parsedText`
   for both columns; delete the three casts.
3. **B′ + D** — `page/editor/server/internal/resources.ts`: explicit `Block`
   projection + `withRank`.
4. **C** — `query-resource/server/internal/spec.ts`: parameterize
   `QueryStep`/`QueryFrom`/`QueryDb`; thread `Row` through `compile.ts`,
   `compile-window.ts`, `rel.ts`; delete six casts.
5. **D** — `primitives/rank/core`: `withRank` + `Ranked`; apply at `listTasks`,
   `getTask`, `taskDetailResource`, `agentsResource`.

## Verification

- `./equin check` — `type-check` is the real proof for classes A through D:
  every deleted cast leaves a *checked* assignment behind, so a residual mismatch
  is a compile error rather than a silent pass. There is no lint proof, because
  there is no rule (see "Enforcement — deferred, and why"); what stands in for it
  is the sweep recorded in "The rest of the class", which is the account of every
  site of this shape the repo holds and which population each belongs to.
- `./equin test plugins/infra/plugins/query-resource` — the compiler suites
  drive both fake dbs through the newly generic seam.
- `./equin build`, then spot-check: the task list and a task's detail
  (class D), the agents sidebar (D), a page and its sidebar tree (A, B′, D),
  Studio → Compositions → a composition's release history and run detail (B).
