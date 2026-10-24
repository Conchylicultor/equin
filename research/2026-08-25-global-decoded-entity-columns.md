# Decoded entity columns — the storage capability hands back a decoder

## Context

`sql-rows` closed `pool.query<Row>(sql)`. `sql-projection` closed ``sql<T>`…` ``
inside a projection. `sql-column` closed `text("x").$type<Union>()` at five
hand-written call sites. The same assertion survives one layer up, at the place
that mints *most* of this repo's columns.

`defineEntity` derives a Drizzle column from a `FieldDef` and applies `$type()`
to carry the field's type onto it
(`plugins/infra/plugins/entities/server/internal/define-entity.ts:97`). `$type`
changes no runtime behaviour, so an entity column whose field schema is narrower
than the underlying Postgres type reads back as a well-typed value the field's
own schema would have rejected.

The gap is wider here than at a single call site. It is inherited by every entity
— **30 `defineEntity` calls across 17 `tables.ts` files** — and the new
`sql-column/no-asserted-column-type` rule cannot see it: the `$type()` call has
no type argument and its chain roots in a variable, not a literal `text(` call.
The field's zod schema is already in scope at the point the column is built. It
just isn't used.

**Intended outcome:** a field type's storage contribution states, in its own
type, whether its column holds exactly what the type declares or is narrowed by
the field's own schema — and in the second case the schema is what runs, on every
read and every write. The information that makes an entity column's type true
comes from the decoder, not from a cast.

### What is actually at stake

**17 columns across 9 tables** declare a closed string union over a plain `text`
column. Every one is built by `enumTextField(...)`
(`plugins/fields/plugins/text/plugins/config/core/internal/enum-text.ts`), the
field-record analogue of `text("x").$type<Union>()`:

| table | columns |
|---|---|
| `conversations` | `status`, `model`, `kind` |
| `event_sources` | `refresh`, `status`, `last_outcome` |
| `mail_outbox` | `op_type`, `status` |
| `mail_sync_state` | `status`, `error_code` |
| `events` | `category` |
| `event_source_runs` | `outcome` |
| `event_source_run_events` | `action` |
| `mail_labels` | `type` |
| `conversation_summaries` | `phase` |
| `claude_cli_calls` | `model` |
| `story_generated_units` | `status` |

**It has already bitten.** A live-data survey of the main `singularity` DB found
every one of these columns in-set except one:

```
conversations.model → "opus"   (1 row)
```

`"opus"` is not in `ConversationModelSchema.options`. It is a `LEGACY_ALIASES`
key from before model ids were versioned
(`plugins/conversations/plugins/model-provider/core/registry.ts:57`). Today that
row is handed to typed code as a `ConversationModel`; `MODEL_REGISTRY["opus"]` is
`undefined`, and `cliFlagFor` reads `.cliFlag` off it. The repo already knows
this — `StoredModelSchema` (a `tolerantEnum`) exists for exactly this value — but
it sits on the **live-state resource**, so it guards the browser and nothing
else.

That single row also decides the API: a factory that only takes a value tuple
cannot express the tolerant policy, so the tolerant column would have no
spelling. See *The two policies* below.

---

## Measured facts

Everything below was measured in this worktree, not assumed.

### 1. Cost — a decoder is only expensive where it is wasted

Isolated, zod 3.23 under bun (2 M iterations, warmed):

| decoder | ns/value | per 10 k rows |
|---|---|---|
| `z.enum([…]).parse` | 322 | 3.2 ms |
| `Set.has` | 28 | 0.28 ms |
| **`z.string().parse` (identity — pure waste)** | **345** | **3.5 ms** |
| `tolerantEnum` shape (`preprocess` + `enum`) | 620 | 6.2 ms |
| `z.array(z.object ×3).parse` (small jsonb) | 3 262 | 33 ms |
| `z.array(z.object ×40).parse` (big jsonb) | 51 115 | 511 ms |
| `JSON.parse` of that same big jsonb (already paid) | 46 042 | 460 ms |
| shallow clone of a 12-column row (ambient) | 29 | 0.29 ms |

Two readings decide the design:

- **Decoding a column that is *not* narrowed costs the same as decoding one that
  is** (345 ns vs 322 ns), for zero guarantee. A design that decodes every column
  of every row would spend roughly 10× more than one that decodes only the
  narrowed ones — which is the "wholesale adoption" the task warns about.
- **Zod-parsing a jsonb payload roughly doubles that column's decode cost**
  (51 µs on top of the 46 µs `JSON.parse` already pays) for a *weaker* guarantee
  — Postgres really decodes JSON, so only the shape was ever asserted. That tier
  stays out of scope and stays a follow-up.

### 2. Cost — end to end, on the largest read in the system

The full `conversations` table (**4 222 rows, 16 columns, 3 of them decoded**),
read through real drizzle over the live socket, arms interleaved A/B ×25 to hold
host load equal:

```
plain   median 84.8 ms   p10 52.4 ms
decoded median 88.8 ms   p10 54.0 ms
overhead  +1.6 ms (p10, least-noise)  …  +4.0 ms (median)   =  3–5 %
per decoded value: ~123 ns end-to-end
```

`conversations` is the worst case that exists: the only unbounded, still-growing
table carrying enum columns whose loader reads it whole. Every other enum-bearing
read is bounded — `claude_cli_calls` ≤ 1 000 rows, `event_emissions` ≤ 200,
`events` / `mail_threads` keyset-paginated by page size, and the rest
(`mail_labels`, `mail_sync_state`, `event_sources`, `conversation_summaries`)
small by construction. **3–5 % on the worst read, sub-millisecond everywhere
else.** Adopted.

### 3. The type-level contract compiles, and its negative cases are load-bearing

Prototyped against the repo's own `tsconfig.base.json` with real drizzle
builders. All six existing fixed contributions typecheck with their bodies
unchanged, `parsedText` satisfies the decoding shape, and both failure modes are
`tsc` errors — verified by flipping each body and confirming the
`@ts-expect-error` became *unused*:

- a `date` token handing back a `boolean()` column → error
- a decoding builder handing back a plain `text(n)` column → error

### 4. Live data is in-set everywhere but one column

Surveyed on `singularity` (see the table above). 16 of 17 columns hold only
in-set values; `conversations.model` holds one `"opus"` row. **Nothing to
migrate** — the one legacy value is what the tolerant policy is for.

---

## Design

### The shape of the fix

`resolveFieldStorage(typeId)` returns a builder typed
`(name: string) => PgColumnBuilderBase` — the field's value type erased on both
ends. It never sees the schema, so it *cannot* decode; and its return type says
nothing, so a `date` token returning a `boolean` column typechecks today.

Both halves are fixed by one contract, and the contract says the thing that is
actually true: **a field type either has a fixed column, or its column is
narrowed by the field's own schema and must therefore decode it.**

```ts
/** A column builder whose drizzle `data` type is exactly `V`. */
export type StorageColumnFor<V> = PgColumnBuilderBase<
  ColumnBuilderBaseConfig<ColumnDataType, string> & { data: V }
>;

export type FieldStorageContribution<B = unknown> = { type: FieldType<B> } & (
  | {
      /** This type's column holds exactly `B`; no field can narrow it. */
      build: (name: string) => StorageColumnFor<B>;
      decode?: never;
    }
  | {
      /** This type's column is narrowed by the FIELD's own schema, so that
       *  schema is what must run for the narrowing to be true. */
      decode: <V extends B>(
        name: string,
        valueSchema: ZodParser<V>,
      ) => StorageColumnFor<V>;
      build?: never;
    }
);
```

This is not ceremony over one flag — the two arms are two different promises, and
which one a type makes is exactly the fact the current signature loses.

**Enforcement, by rung:**

1. *Inexpressible* — a `decode` builder cannot return a plain `text(name)`: its
   declared return type is `StorageColumnFor<V>` for a caller-chosen `V`, and the
   only text builder that produces one is `parsedText`, whose `V` is inferred
   from the schema argument and from nowhere else.
2. *Type error* — every builder's return type is now pinned to its token's
   declared value type. A `date` token returning a `boolean()` column stops
   compiling (fact 3).
3. *Check/lint* — the escape hatch is `text(name).$type<V>()`, and a storage
   contribution writes `text(` **literally**, which is precisely the root
   `sql-column/no-asserted-column-type` already scopes on. No new rule.

### Six contributions keep their bodies; one changes

| token | arm | body |
|---|---|---|
| `bool` `int` `float` `date` `uuid` `rank` | `build` | **unchanged** — only the return type tightens |
| `json` `tags` | `build` | **unchanged** — `jsonb(name)` honestly holds `unknown` |
| `text` | `decode` | `parsedText(name, valueSchema)` when the schema narrows |

The `json` row is the point where the weaker tier stops being invisible. A jsonb
contribution now *says* its column holds `unknown`; the `T` on a `jsonField<T>`
column comes from `defineEntity`'s cast and is an assertion, stated as one in the
code rather than implied. That is the honest description of today's behaviour and
the anchor for the follow-up.

### The text builder's one discrimination

```ts
export const decode = <V extends string>(name: string, valueSchema: ZodParser<V>) =>
  valueSchema instanceof ZodString
    ? // `z.string()` — the column already holds exactly this. A decoder here
      // verifies nothing at 345 ns/value (fact 1). `V` IS `string` on this
      // branch; TS cannot narrow a type parameter from an instanceof, so this
      // is the one cast, and it is about a compiler limitation rather than
      // about what a row holds.
      (text(name) as StorageColumnFor<V>)
    : parsedText(name, valueSchema);
```

Every plain `textField()` keeps a plain `text` column and pays nothing. Every
`enumTextField(...)` gets a real decoder. The branch is on the schema the author
actually wrote — not a heuristic about intent.

### Nullability stays drizzle's, and cannot drift from the decoder

A decoder never sees `null` in either direction (`sql-column/CLAUDE.md`, fact 3),
so `nullable(enumTextField(RUN_OUTCOMES))` must hand `parsedText` the **inner**
`z.enum([…])`, not the `.nullable()` wrapper. `defineEntity` already derives
nullability from the raw schema via `isNullableSchema`. That helper becomes one
function returning both answers, so they cannot disagree:

```ts
/** Split a raw field schema into (is the column nullable, the schema for its
 *  VALUES). One result because the two answers must agree — a column declared
 *  nullable while its decoder still holds the `.nullable()` wrapper is the
 *  drift this exists to prevent. */
function splitNullability(schema: z.ZodTypeAny): { nullable: boolean; value: z.ZodTypeAny }
```

It unwraps `ZodOptional` / `ZodNullable` repeatedly (a `.optional().nullable()`
nest), exactly the set `isNullableSchema` recognises today.

### The two policies — and why the factory must take a schema

`parsedText` takes any `ZodParser<T>`, so both policies this repo already has
stay spellable. But `enumTextField(values)` builds `z.enum(values)` internally,
so a tolerant column has no spelling — and `conversations.model` needs one
*today* (fact 4).

So the general factory is the one that takes the schema, and the tuple form
becomes sugar over it:

```ts
/** A text column whose values are exactly what `schema` produces. */
export function parsedTextField<T extends string>(schema: ZodParser<T>, opts?): FieldDef<T>

/** Sugar: the closed-set case. */
export const enumTextField = (values, opts?) => parsedTextField(z.enum(values), opts)
```

`enumTextField`'s existing `textFieldType as FieldType<T[number]>` cast **stays,
and becomes true** — the text token's storage really does produce `T[number]`
now. Its `type.id` is still `"text"`, so every DataView field renderer, filter
operator set, table cell and config surface behaves identically. Zero UI blast
radius.

Per column:

| columns | schema | why |
|---|---|---|
| `conversations.model`, `claude_cli_calls.model` | `StoredModelSchema` (tolerant) | ids get renamed; a live `"opus"` row proves rows outlive renames |
| `mail_labels.type` | tolerant, unknown → `"user"` | the value arrives from the Gmail REST response through an **unchecked cast** (`gmail-api/…/request.ts:84` is `(await res.json()) as T`), and `sync/…/store.ts:51` already writes `label.type ?? "user"`. Evolving upstream we do not control |
| the other 14 | the strict `z.enum` they already build | closed, engine-internal sets; every live value is in-set |

Moving these guards from the wire down to the column is what makes them reach
the server-side readers, which is the point.

### The read paths this actually reaches — verified

Every read of the 17 columns goes through the table's **own column objects**, so a
column-level decoder reaches all of them. Audited, none re-declare:

- `conversations_v` is `...getTableColumns(_conversations)`
  (`tasks-core/server/internal/views.ts:404`) — the highest-traffic path, and the
  one serving the `"opus"` row.
- the generic entity loader behind every `queryResource` / `windowQueryResource`
  is `getTableColumns(from.table)` (`query-resource/server/internal/identity.ts:171`).
- `all-conversations`' `handleQuery` reads the view's columns off drizzle's
  `ViewBaseConfig` symbol — the same objects again.
- the hand-written loaders (`labels-resource`, `list-calls`, the summary and
  claude-cli resources) are bare `db.select()`.

### New failure modes this introduces, and what happens to them

The encoder runs on INSERT `.values()`, UPDATE `.set()` **and every bound
comparison param** — `inArray`/`eq`/… route through `bindIfParam` →
`Param(value, column)`. Raw ``sql`…` `` templates do **not** (verified against
`drizzle-orm/sql/sql.js`), so the views' `sql`${_conversations.status} = 'waiting'``
and `ilike(conversations.model, needle)` are unaffected.

That leaves one behaviour change worth naming: the DataView enum filter builds
`inArray(col, list)` from operands `asList` only checks are strings
(`fields/enum/plugins/filter-sql/…/enum-filter-sql.ts:35-46`), so a **stale saved
view holding a removed enum value now throws instead of silently matching
nothing.** Deliberately not fixed here: it is a pre-existing hole (nothing
validates filter operands against the field's domain), its fix belongs at the
FilterGroup boundary rather than in this contract, and the one column with real
legacy values is tolerant so it normalizes. Filed as a follow-up.

Two writers reach these columns through a `Record<string, unknown>` patch bag —
`mutations/conversations.ts:118` and `sources-repo.ts:110`. Every current caller
passes a narrow value, but the static type has been widened before it reaches
`.set()`, so the encoder would be the first to notice. Both are narrowed to a
typed patch here: rung 2 beating rung 4, the same move `sql-column` made for
`updateExecution`.

---

## Implementation

### 1. `plugins/fields/plugins/server-capabilities/server/internal/storage.ts`

- Add `StorageColumnFor<V>`; make `FieldStorageContribution<B>` the two-arm union
  above; keep `StorageColumnBuilder` as the `build` arm's alias.
- `Fields.Storage` becomes generic (`<B>(props: FieldStorageContribution<B>)`) so
  `B` is inferred from `type`. The eager-index wrapper is unchanged in behaviour.
- `resolveFieldStorage(typeId)` returns the **contribution** (not just `build`),
  since the caller must now pick an arm.
- **Delete `fieldsToColumns`** (`internal/fields-to-columns.ts`, its test, its
  barrel export, its `CLAUDE.md` lines). It was built in Stage B "for Stage C to
  consume"; Stage C deliberately did not (`entities/CLAUDE.md:57`), and it has
  had **zero consumers** ever since — only its own test. It is a second
  `FieldsRecord → columns` derivation that does not decode, which is exactly how
  this hole would reopen. Removing it is rung 1: the wrong spelling stops
  existing rather than being kept in sync.

### 2. The nine storage contributions

`bool` `int` `float` `date` `uuid` `rank` `json` `tags`: annotate the return type
`StorageColumnFor<B>` instead of `PgColumnBuilderBase`. Bodies unchanged.

`plugins/fields/plugins/text/plugins/storage/server/internal/storage.ts`: switch
to the `decode` arm with the discrimination above. This plugin gains a dependency
on `@plugins/database/plugins/sql-column/server` — a lean, `tables.ts`-safe barrel
(`sql-column/CLAUDE.md`), which is what this needs since storage barrels are
evaluated by the drizzle-kit codegen subprocess. **Verify no import cycle**
(`./equin check plugin-boundaries`).

### 3. `plugins/infra/plugins/entities/server/internal/define-entity.ts`

- Replace `isNullableSchema` with `splitNullability`.
- Build via the chosen arm; **delete `b = b.$type()`** — the type now comes from
  the builder, and the call was a runtime no-op.
- Keep the `builders as unknown as EntityColumns<F, D>` cast: it is what gives
  `$inferSelect ≡ z.infer<schema>`. Update its comment to say plainly which
  columns it *derives* (decoded) and which it *asserts* (jsonb).

### 4. `plugins/fields/plugins/text/plugins/config/core/internal/enum-text.ts`

Add `parsedTextField(schema, opts)`; reimplement `enumTextField` as sugar. Export
both from `.../config/core/index.ts`.

### 5. The two tolerant columns

`plugins/tasks/plugins/tasks-core/core/internal/fields.ts:80` and
`plugins/infra/plugins/claude-cli/core/resources.ts:32` switch from
`enumTextField(ConversationModelSchema.options)` to
`parsedTextField(StoredModelSchema)`. Check the wire schema of `claude_cli_calls`
(it currently re-widens `model` via `StoredModelSchema.extend`) — that widening
may now be redundant.

### 6. Docs

- `entities/CLAUDE.md` — a section on the two storage arms and which columns are
  derived vs asserted.
- `server-capabilities/CLAUDE.md` — the contract, and why `resolveFieldStorage`
  returns a contribution.
- `sql-column/CLAUDE.md` — its "`defineEntity`'s generic `b.$type()`" follow-up
  bullet is now done; point at this doc. Add the measured 3–5 % number.
- `plugins/database/CLAUDE.md` — extend the *Typed at the SQL boundary* table.

### 7. Follow-ups to file (not silently dropped)

- **jsonb entity columns stay asserted.** ~25 columns across the entity set
  (`mail_messages.from/to/cc/bcc/replyTo/headers`, `slow_ops.callers/…`,
  `traces.snapshot`, `events.date`, …). Measured cost is a ~2× multiplier on that
  column's decode for a weaker guarantee, so it needs its own design — most
  likely opt-in per field rather than per type.
- **`jsonField<string[]>` is standing in for a `string-list` field type** that has
  no `Fields.Storage` contribution (`events-core/core/internal/fields.ts:175`).
  Giving it one would be narrower *and* cheaper than the generic jsonb tier.
- **DataView filter operands are never validated against the field's domain.**
  `asList` accepts any string (`fields/enum/plugins/filter-sql/…`), so a stale
  saved view can carry a value the column's domain no longer has. The fix belongs
  at the FilterGroup boundary — parse each operand against the field's own schema
  and drop what cannot match — not in the storage contract.
- **The Gmail REST client asserts its responses instead of parsing them.**
  `gmail-api/server/internal/request.ts:84` is `return (await res.json()) as T` —
  the same class of hole as this task, one layer out, at an external boundary.
  `mail_labels.type` is tolerant here as a stopgap; the real fix is a `ZodParser`
  on the client.
- **`pushes` is an unbounded full-table push resource with no LIMIT**
  (`tasks-core/server/internal/resources.ts:146`), unlike every sibling. Unrelated
  to this change, found while measuring.

---

## Verification

- **`./equin check`** — `migrations-in-sync` must generate **no** migration.
  This is the load-bearing claim: `parsedText`'s `getSQLType()` is `"text"` and
  drizzle-kit reads it with no branch on the column class, so 17 columns swapping
  from `text` to a customType must be byte-identical in the snapshot. Also
  `plugin-boundaries` (the new `fields/text/storage → sql-column` edge) and
  `type-check`.
- **`./equin test`** on `plugins/infra/plugins/entities`,
  `plugins/fields/plugins/*/plugins/storage`, and
  `plugins/database/plugins/sql-column`. New cases: a narrowed field builds a
  column that really throws on an out-of-set read; a plain `textField` builds a
  plain `text` column (no decoder — the cost claim, as a test); a nullable
  narrowed field's decoder gets the unwrapped schema and its column stays
  nullable.
- **`query_db`** re-run of the live-value survey after deploy, plus a deliberate
  out-of-set write through an insert to confirm the encoder throws naming
  `table.column`.
- **`./equin build`**, then exercise the surfaces the 17 columns feed:
  the task tree and a conversation (`conversations.status/model/kind` — including
  the attempt whose `"opus"` row must now normalize rather than crash), Debug →
  Claude CLI calls, the Events sources pane and a refresh run, and the Mail
  mailbox tabs.
