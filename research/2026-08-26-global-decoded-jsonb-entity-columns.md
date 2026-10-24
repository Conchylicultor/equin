# Decoded jsonb entity columns — the schema is the dial

## Context

`sql-rows` closed `pool.query<Row>(sql)`. `sql-projection` closed ``sql<T>`…` ``.
`sql-column` closed `text("x").$type<Union>()`, and then
`research/2026-08-25-global-decoded-entity-columns.md` closed it one layer up, at
`defineEntity`: a field type's storage contribution now either has a **fixed**
column or a column **narrowed by the field's own schema**, and in the second case
that schema is what really decodes it.

One arm of that contract still asserts. `jsonb(name)` honestly hands back
`unknown`; the `T` on a `jsonField<T>` column comes from `defineEntity`'s
`EntityColumns` cast and from nothing that runs. **25 columns across 8 tables**
are typed that way today — `mail_messages.from/to/cc/bcc/replyTo/headers`,
`slow_ops.callers/waits/recentSamples`, `traces.snapshot`, `boot_traces.snapshot`,
`events.date/tags`, `event_sources.config/lastFlags`, `mail_outbox.payload` and
the rest (full table below). A row written by older code, by hand, or by a
worktree on different code is handed to typed code as if it matched.

The predecessor deferred this deliberately, on a measured worry: zod-parsing a
40-element array payload cost ~51 µs against the ~46 µs `JSON.parse` that jsonb
already pays — roughly **double** that column's decode cost, for a *weaker*
guarantee, since Postgres genuinely decodes the JSON and only the shape was ever
asserted. It concluded that blanket adoption was not obviously right and that
per-field opt-in might be.

**That worry does not survive measurement of the actual columns.** The cost of a
zod parse tracks the **schema's** depth, not the payload's size — and the schemas
on the big payloads are shallow, because their authors already declined to
describe them. So the opt-in dial the predecessor was looking for already exists,
and it is the schema itself. Adding a second dial would be a knob that can
disagree with the first.

**Intended outcome:** every storage arm derives its column's type from something
that runs. After this change `FieldStorageContribution` has no arm that can
assert, and `defineEntity`'s `EntityColumns` cast is a pure re-statement for every
column in every entity.

---

## Measured facts

All measured in this worktree (zod 3.25.76, bun 1.3.13, drizzle-orm 0.36.4,
drizzle-kit 0.28.1) against the live `singularity` DB.

### 1. Cost tracks the schema's depth, not the payload's size

`traces.snapshot` is the largest jsonb value in the system — sampled over 300
rows: **avg 123 KB, max 536 KB** (the `traces` table is 1 064 MB over 6 752
rows). Its schema, `TraceSnapshotSchema`, is eight scalars plus
`events: z.record(z.unknown())` — the engine deliberately never names a key.

| decode of one ~96 KB trace snapshot | cost |
|---|---|
| `JSON.parse` (what pg already pays) | 561 µs |
| `TraceSnapshotSchema.parse` (the real, shallow schema) | **1.7 µs** |
| a *deep* schema fully describing the same bytes, for contrast | 481 µs |

The predecessor's "~2× multiplier" is real — and it is what a schema costs when
it actually describes all of the payload. A schema that declines to describe a
payload declines to pay for it, at a **0.3 %** ratio on the largest blob in the
repo. `z.unknown()` is 113 ns and does not even clone.

### 2. The per-column cost, end to end

| column set | per row | on its real read |
|---|---|---|
| `slow_ops.callers` + `waits` + `recentSamples` (avg row: 7 callers, 6 samples) | 4.96 µs | **+25 ms** on the whole-table load (5 130 rows) |
| the same, worst row in the table (334 callers) | 40 µs | — |
| `mail_messages` ×6 jsonb columns | 3.97 µs | +0.12 ms on a 30-message thread |
| `traces.snapshot` | 1.7 µs | one row, on the detail pane only |

`slowOpsResource` is the worst case that exists, and it is worst for reasons that
predate this change: it is one of the legacy **unbounded** push resources
(`db.select().from(_slowOps)` with no `LIMIT`), so it already loads ~19 MB and
already parses every one of those bytes — `resource-runtime` parses the loader's
output against `z.array(SlowOpSchema)`, which *is* the field schemas. The
decoder adds a second pass over the same values. Filed as a follow-up (the
resource wants bounding, not a cheaper decoder). Every other read is
sub-millisecond.

### 3. Where the read paths are, and which of them check anything today

The jsonb blob is read whole on far fewer paths than the column list suggests.
`traces` list never materializes `snapshot` (two `->>` scalar extractions only);
`boot_traces` list hand-projects `{id, worktree, createdAt}`; `mail_drafts` /
`mail_outbox` have no reader at all yet. Everything else is a keyset page, a
per-thread scope, or a single row by id.

Of those, only the ones behind `defineResource` are checked today —
`resource-runtime/core/runtime.ts:1427` parses every loader output against the
resource schema. Nothing checks:

- a raw `db.select()` in a job, a handler, or a repo function,
- an endpoint response (`implement()` never parses the response server-side;
  `endpoints/core/codec.ts:61` is a bare `Response.json(value)` — the response
  schema runs only in the browser),
- **any write, ever.**

So the decoder is redundant on exactly one family of paths and is the only guard
on all the others, in both directions.

### 4. Adopting it generates no migration

`customType`'s `getSQLType()` returns `dataType()` verbatim, drizzle-kit reads
`column.getSQLType()` into the snapshot with **no branch on the column class**,
and `"jsonb"` is on its `pgNativeTypes` whitelist (drizzle-kit `bin.cjs:24669`),
so it renders unquoted — byte-identical to `jsonb("x")`. Column defaults are
keyed on the same lowered SQL type name (`bin.cjs:19316`), so a jsonb default
renders `'…'::jsonb` either way. Same argument that made `parsedText` free, and
the reason `rank_text` / `bytea` / `tsvector` are not.

### 5. `pg` decodes jsonb itself

`pg-types.getTypeParser(3802)` is `JSON.parse`. `fromDriver` therefore receives
an already-decoded JS value, never a string.

---

## Design

### The contract needs nothing new

The two-arm `FieldStorageContribution` built by the predecessor already has the
slot:

```ts
decode: <V extends B>(name: string, valueSchema: ZodParser<V>) => StorageColumnFor<V>
```

`jsonFieldType` is `defineFieldType<unknown>("json")`, so `B` is `unknown` and
`V` is unconstrained — a json contribution can hand back a column of exactly what
its field's schema produces. `tagsFieldType` is `defineFieldType<string[]>`, so
`V extends string[]`. Both fit the existing arm with no new vocabulary. The
predecessor wrote "it needs its own design"; what it needed was a decoder and a
measurement.

### `parsedJson`, beside `parsedText`

```ts
/** A `jsonb` column whose values are exactly what `schema` produces. */
export function parsedJson<T>(name: string, schema: ZodParser<T>)
```

Same shape as `parsedText`, same `crossBoundary` / `SqlColumnError` diagnostics
(so a failure names `table.column`, the direction, and the value), same
non-arrow `fromDriver`/`toDriver` so drizzle's method call supplies the table
qualifier. Two differences, both forced by jsonb:

- `toDriver` returns `JSON.stringify(parsed)`, which is what drizzle's own
  `PgJsonb.mapToDriverValue` does.
- **No string-branch on read.** Drizzle's `PgJsonb.mapFromDriverValue` tries
  `JSON.parse` on a string and *silently returns the raw string on failure* — an
  absorbed failure, and ambiguous besides, since a jsonb column may legitimately
  hold a JSON string. pg decodes jsonb itself (fact 5), so the driver value goes
  straight to the schema: if it is ever a string where an object is expected, the
  schema says so, loudly, naming the column.

`parsedJson` is a **normalizer**, not only a checker: a `z.object` strips keys it
does not declare, on read and on write alike. That is what makes the declared
type true rather than merely asserted, and it is stated in the docs rather than
discovered.

### The json arm's one discrimination

```ts
export const decode = <V>(name: string, valueSchema: ZodParser<V>) =>
  valueSchema instanceof ZodUnknown
    ? widestJsonColumn<V>(name)   // `z.unknown()` — nothing to verify
    : parsedJson(name, valueSchema);
```

Exactly the `text` arm's shape, and sound for the same reason: `ZodUnknown`'s
output is `unknown`, and `unknown` is assignable to no proper subtype of itself,
so a `ZodParser<V>` for a narrower `V` can never *be* a `ZodUnknown`. Passing the
`instanceof` proves `V` is `unknown`; TypeScript cannot narrow a type parameter
from an `instanceof`, so the equality is stated once with its proof.

**`ZodAny` is deliberately not in the branch.** `z.any()` is
`ZodType<any, …, any>`, and `any` is assignable to every `V`, so the `instanceof`
would prove nothing — a `jsonField<Foo>({ schema: z.any() })` would skip the
decoder while declaring `Foo`. It falls through to `parsedJson`, where
`z.any().parse` is a pass-through that costs nothing and claims nothing.

No column in the repo uses `z.unknown()` today, so this branch is the limit case
of the design's central claim rather than an optimization anyone is waiting on —
but `jsonField({ schema: z.unknown() })` is a live spelling in config surfaces,
and the rule to learn should be one rule: **the schema is the dial.**

### `z.record(…)` narrows, and keeps decoding

Four columns use `z.record(z.unknown())` / `z.record(z.string(), z.unknown())` —
`event_emissions.payload`, `claude_cli_calls.sourceContext`,
`event_sources.config`, `mail_outbox.payload`. These are weak but *real*: they
verify the value is a non-null object, which is exactly what
`Record<string, unknown>` claims, and they keep every key. 588 ns. They decode.

### The `tags` arm's cast dies

`fields/tags/plugins/storage` is documented in its own file as *"the one storage
contribution in the repo that ASSERTS rather than derives"*. It switches to
`decode` with the same body shape, and the cast — and the paragraph explaining
it — are deleted. That is the point of the change: after it, the sentence has no
subject.

### `defineEntity` changes only its comment

The `builders as unknown as EntityColumns<F, D>` cast stays — it is what gives
`$inferSelect ≡ z.infer<schema>`. Its per-column ledger of *derived vs asserted*
loses its "asserted" row.

---

## The 25 columns

| table.column | schema | arm after |
|---|---|---|
| `traces.snapshot` | `TraceSnapshotSchema` | decoded |
| `boot_traces.snapshot` | `BootTraceSchema` | decoded |
| `slow_ops.callers` / `.waits` / `.recentSamples` | `z.array(CallerBreakdownSchema)` / `z.record(z.string(), z.number())` / `z.array(SlowOpSampleSchema)` | decoded |
| `event_emissions.payload` / `.matchedTriggerIds` | `z.record(z.unknown())` / `z.array(z.string())` | decoded |
| `claude_cli_calls.sourceContext` | `nullable`, `z.record(z.unknown())` | decoded |
| `event_sources.config` / `.lastFlags` | `z.record(z.string(), z.unknown())` / `z.array(z.string())` | decoded |
| `events.date` / `.tags` | `EventDateSchema` (discriminated union) / `z.array(z.string())` | decoded |
| `event_source_runs.flags` | `z.array(z.string())` | decoded |
| `mail_threads.participants` / `.labelIds` | `z.array(MailAddressSchema)` / `z.array(z.string())` | decoded |
| `mail_messages.from/to/cc/bcc/replyTo` | `MailAddressSchema` / `z.array(MailAddressSchema)` (`replyTo` nullable) | decoded |
| `mail_messages.headers` | `z.record(z.string(), z.string())` | decoded |
| `mail_drafts.to/cc/bcc` | `z.array(MailAddressSchema)` | decoded |
| `mail_outbox.payload` | `z.record(z.string(), z.unknown())` | decoded |

Nullability is already handled: `defineEntity`'s `splitNullability` hands the
`decode` arm the **inner** schema, so `nullable(jsonField<T>(…))` decodes `T` and
leaves the column nullable. A decoder never sees `null` in either direction.

---

## Implementation

1. **`plugins/database/plugins/sql-column/server/internal/parsed-json.ts`** —
   new. `parsedJson`, reusing `crossBoundary` / `SqlColumnError` from the
   existing `parsed-text.ts` + `errors.ts`; the shared boundary helper moves to
   its own internal module so both decoders state it once. Export from the
   barrel; broaden the plugin description from "a text column" to "a column".
2. **`plugins/fields/plugins/json/plugins/storage`** — `build` → `decode` with
   the `ZodUnknown` branch. Gains the `@plugins/database/plugins/sql-column/server`
   edge (lean, `tables.ts`-safe — the same edge `fields/text/storage` already
   has, so no new cycle risk).
3. **`plugins/fields/plugins/tags/plugins/storage`** — `build` → `decode`; delete
   the cast and its explanation.
4. **`plugins/infra/plugins/entities/server/internal/define-entity.ts`** — update
   the `EntityColumns` cast comment; no behaviour change.
5. **`plugins/fields/plugins/json/plugins/config/core/internal/json.ts`** — the
   `jsonFieldType as FieldType<T>` cast stays and becomes *true*; say so.
6. **Docs** — `sql-column/CLAUDE.md` (the jsonb tier, the normalizer note, the
   measured numbers, and its "`jsonb(…).$type<T>()` is a weaker tier" exclusion
   note, whose justification is now stale), `server-capabilities/CLAUDE.md`,
   `entities/CLAUDE.md`, `plugins/database/CLAUDE.md`.
7. **Tests** — `parsed-json.test.ts` mirroring `parsed-text.test.ts` (qualified
   `table.column` label through a real `pgTable`, both directions, the
   normalizing strip); `define-entity.test.ts` cases: a narrowed jsonb field
   builds a column that throws on an out-of-shape read, a `z.unknown()` jsonField
   builds a plain `jsonb` (no decoder — the cost claim, as a test), a nullable
   narrowed jsonb field's decoder gets the unwrapped schema and its column stays
   nullable.

### Out of scope, filed as follow-ups

- **The ~16 hand-written `jsonb(x).$type<T>()` columns** (`reports.data`,
  `page_blocks.data`, `notifications.metadata`, `job_steps.result_json`,
  `backup_runs.manifest`, the workflow-engine and sonata-rhythm columns, …).
  `parsedJson` is now their replacement and the lint rule should grow a `jsonb(`
  root — but several declare TS types with no zod schema in existence, over
  load-bearing tables, so each needs its own schema and its own live-data survey.
  The rule extension is gated on that migration, not on this change.
- **`slowOpsResource` is an unbounded full-table push resource** — the one read
  where this costs anything measurable, and it wants a bounded membership under
  `research/2026-07-18-global-bounded-working-set-resource-contract.md`.
- **`resource-runtime`'s per-load schema parse is now redundant for
  entity-derived loaders** whose every column decodes. Not removable today (it
  also guards hand-written loaders), but it is the second half of the `slow_ops`
  number.
- **`{} as TraceSnapshot` / `{} as BootTrace` field defaults** are values their
  own schema would reject; they survive only because nothing parses a default.

---

## Verification — what was actually run

**The live-data survey was the load-bearing one**, and it is clean. Every schema
was *imported* from the repo rather than transcribed, and every non-null value of
every row of all 25 columns was parsed against it on the live `singularity` DB:

```
478,569 rows checked   0 parse failures   0 stripped keys
```

Row counts had grown since the estimates above (`traces` 17,959 rather than
6,752). `mail_messages.reply_to` carries 25,222 nulls, correctly skipped — a
decoder never sees `null` — and its 33,722 real values all parse. **Zero stripped
keys anywhere** means the normalizer changed no live value; the schemas already
describe what is stored. Three tables are empty (`boot_traces`, `mail_drafts`,
`mail_outbox`), so four columns are unproven rather than proven — worth a second
look once they hold data.

**`./equin build` — BUILD OK, deployed, all checks green.** The claim under
test was fact 4, and it held: **no migration was generated.** 25 columns swapped
from `jsonb` to a decoding `customType` with byte-identical DDL and snapshot.
`plugin-boundaries` accepted the new `fields/{json,tags}/storage → sql-column`
edges; `type-check` clean.

**`./equin test`** — 82 pass / 0 fail across the eight touched suites.

**Both directions exercised live on the deployed backend.** Every `traces` and
`slow_ops` row in this worktree was written *after* the restart, so it went out
through the new encoder and came back through the decoder:

| surface | what it proves |
|---|---|
| `GET /api/traces/:id` | a 69 KB snapshot decoded whole; `events` kept all three class keys (`z.record` strips nothing) |
| `/api/resources/slow-ops` | `callers`, `waits`, and `recentSamples` with its nested contention snapshot, all keys intact |
| `POST /api/events/query` | `date` resolved through the discriminated union in both arms (`once`, `recurring`); `tags` incl. non-ASCII |
| `GET /api/events/sources` | `config` through `z.record(z.string(), z.unknown())`, every key kept |
| `/api/resources/event-emissions` | 200 rows of `payload` + `matchedTriggerIds` |

No `SqlColumnError` on any log channel. Mail could not be exercised here — the
worktree DB fork carries no mail rows — but the survey validated all 58,944
`mail_messages` and 44,210 `mail_threads` rows against the same schemas on main,
which is the stronger evidence.
