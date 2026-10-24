# A filter operand is not a stored value

*(2026-08-27 — closes the follow-up named in
`research/2026-08-25-global-decoded-entity-columns.md`, "New failure modes this
introduces")*

## Context

A server-delegated DataView posts the user's `FilterGroup` in the request body.
`compileWhere`
(`plugins/primitives/plugins/data-view/plugins/server-query/server/internal/compile.ts`)
walks it, resolves each rule's `(fieldType, operator)` to a SQL builder, and hands
the builder **the field's physical column** plus the rule's raw operand. The
operand is `z.unknown()` on the wire and nothing anywhere checks that it is a
value the field can actually hold.

That was invisible until columns started decoding. `parsedText(name, schema)`
runs its schema as the column's **encoder** as well as its decoder, and drizzle
routes every bound comparison param through the encoder
(`bindIfParam(value, column)` → `new Param(value, column)`). Handing a builder a
real column is therefore handing it a *write-side encoder*, and three things
follow — all of them from the same root, which is that the column arrived at all:

1. **The query dies.** `enum`'s `is-any-of` / `is-none-of` are the only builders
   in the repo that use a drizzle helper (`inArray` / `notInArray`) rather than a
   raw `sql` template, so they are the only ones that bind through the column. A
   saved view holding an option the enum no longer has now raises
   `SqlColumnError` and the whole list 500s. Reachable on `conversations.status`,
   `conversations.kind` and `events.category`.
2. **Worse, one column silently answers the wrong question.**
   `conversations.model` decodes through `tolerantEnum(…)`, which *accepts every
   string and normalizes it*. `model is-any-of ["typo"]` does not throw — it is
   rewritten to the default model and the surface returns **every Opus-5
   conversation as if the user had asked for them**, while the server logs a
   false "corrupt DB row" alert from the tolerant schema's `onFallback`. A
   crash is at least visible; this is not.
3. **Nothing tells the user their filter is stale.** Even before decoding, a rule
   naming an option that no longer exists just quietly matched nothing. And the
   option picker lists `field.options` only — so the stale value counts toward
   "1 selected" but has no chip: the user can neither see it nor click it off.

## The rule

**A comparison operand is not a stored value.** A column's encoder exists to
protect what the column *holds*. Comparing a column against a value it can never
hold is meaningful SQL — it is how you say "nothing matches" — not a write to
reject, and certainly not a value to normalize.

So a filter builder stops receiving a column at all. `compileWhere` hands it a
**comparison target**: the same column as a plain `SQL` expression.

```ts
// compile.ts, the rule branch
return builder(comparisonTarget(binding), node.value);
//               ^ sql`${binding.col}`
```

An `SQL` is not a `DriverValueEncoder`, so `bindIfParam` leaves every operand as
an ordinary param. And it is *only* the encoder that changes: `SQL` chunks flatten
inside a `sql` template before the parenthesising `isSQLWrapper` branch is
reached, so the rendered statement is **textually identical** — same qualified
`"table"."column"`, same `$n` placeholders, same params, same `typings`. No
expression node, no cast, no plan change, no index lost. Verified by rendering
both forms through `PgDialect` for every position the six builders use (raw
template, `inArray`/`notInArray`, `ilike`, `lower()`, `jsonb @>`, `IS NULL`).

The result is the exact pre-decoder truth table, with no knowledge of any field
type and no per-operator declaration:

| rule | before decoding | today | after |
|---|---|---|---|
| `status is-any-of ['gone']` | matches nothing | **500** | matches nothing |
| `status is-none-of ['gone']` | matches everything | **500** | matches everything |
| `model is-any-of ['typo']` | matches nothing | **every default-model row** | matches nothing |
| `status is 'gone'` | matches nothing | matches nothing | unchanged |

This is rung 1 rather than a check: the wrong thing loses its spelling. A builder
cannot reach a write-side encoder because it is never given one, and `tsc`
enforces it — `inArray(target, …)` does not type-check against an `SQL`.

### Two designs that were rejected

**Probe the operand, and only bypass the encoder when it is rejected.** It keeps
the encoder for "good" operands, which sounds conservative and is not: the
tolerant `model` column *accepts* `"typo"`, so the probe preserves bug (2)
verbatim. It also reintroduces bug (1) elsewhere — `PgTimestamp.mapToDriverValue`
calls `.toISOString()`, and date operands are epoch-ms numbers and `{from,to}`
objects, so probing a timestamp column throws a `TypeError`. And it makes the
compiled path data-dependent: two structurally identical rules take different
branches based on what the operand happens to be.

**Parse each operand against the field's domain and drop what fails.** Exact only
while something survives: `is-any-of ['gone']` empties out, and an empty operand
is the *incomplete-rule* signal every builder already uses for "no constraint", so
the surface would show **every** row where it used to show none. Telling the two
apart needs to know whether an operator is positive or negative — knowledge
`FilterOperator` does not declare and the generic compiler cannot have. It also
has no correct domain to parse against: the column's schema is wrong for a
tolerant column (it admits everything), and the field's declared `options` is
wrong too (`modelOptions` deliberately omits `printOnly` models that are
legitimately persisted, so a correct filter would be dropped).

## Implementation

### 1. The builder contract takes a target, not a column

`plugins/fields/plugins/server-capabilities/server/internal/filter-sql.ts` —
`FilterSqlBuilder` becomes `(target: SQL, operand: unknown) => SQL | undefined`,
with the doc stating the rule: the target is the field's column as an expression,
a builder binds its own operands, and it may not read column metadata (no builder
does).

`server-query`'s structural twin `OperatorSqlBuilder` changes identically.

### 2. `compileWhere` hands over the target

One named helper next to the rule branch, one call site, no field type named:

```ts
/** The field's column as a plain expression — see the rule above. */
function comparisonTarget(binding: ColumnBinding): SQL {
  return sql`${binding.col}`;
}
```

### 3. The six operator maps

Each map is `satisfies Record<string, FilterSqlBuilder>`, and `satisfies`
contextually types the method parameters — so the redundant per-method
`col: AnyColumn` annotations are simply **deleted** (`text` 6, `bool` 2,
`number` 3, `date` 10, `tags` 6, `enum` 6), along with the now-unused `AnyColumn`
imports. Four free-standing helpers (`number`'s `binary`, `date`'s `within`,
`tags`' `tagArray` / `containsAll`) take `SQL` instead.

`enum` is the only real edit: `inArray(col, list)` / `notInArray(col, list)`
become `` sql`${target} in ${list}` `` / `` sql`${target} not in ${list}` ``.
Drizzle's own `inArray` renders exactly that (`Array.isArray` chunk → `($1, $2)`,
same `" in "` spelling), and both operators already short-circuit an empty list to
`undefined`, so drizzle's `[] → sql\`false\`` branch was never reachable. The
existing tests pin the rendered SQL byte-for-byte.

### 4. `ColumnBinding.col` stops lying

`custom-columns`' query augmentor puts a `::type` cast **SQL** into a
`FieldColumnMap` behind `as unknown as AnyColumn`
(`data-view/plugins/custom-columns/server/internal/query-augmentor.ts`), with a
comment explaining why it is runtime-safe. It is — but the type has been false
since. `plugins/primitives/plugins/keyset/server` gains

```ts
/** A physical column, or a SQL expression standing in for one. */
export type ColumnExpr = AnyColumn | SQL;
```

used by `KeysetColumnBinding.col`, `SortKey.col` and `Tiebreaker.col` (the seek
and `orderByClauses` only interpolate `${col}`, so nothing there needs a real
column), inherited by `server-query`'s `ColumnBinding`, and both
`as unknown as AnyColumn` / `as unknown as PgColumn` casts in the augmentor are
deleted. If this ripples further than expected it is a separable cleanup and can
be dropped without affecting §1–§3.

### 5. The stale option becomes visible

`data-view/web/components/filter/chip-select-filter-input.tsx` renders chips for
`field.options` only, so a selected value that is not among them is counted in the
summary but has no chip — invisible and unremovable. It now also renders those
values (label = the raw value, with a `title` saying it is not one of the field's
listed options), so the user can see the stale operand and click it off.

Deliberately worded as "not listed" rather than "invalid": a value absent from
`options` is not necessarily wrong (`modelOptions` hides `printOnly` models that
rows legitimately hold), so the UI makes it visible without making a claim.

### 6. Docs

`sql-column/CLAUDE.md` and `fields/text/plugins/storage/CLAUDE.md` both carry the
"a stale saved view throws instead of silently matching nothing" note — it becomes
the resolved rule, pointing here. `server-query/CLAUDE.md` gains the prose (it has
none today).

**Named non-goal:** this closes the FilterGroup boundary, not the class. Nothing
stops a consumer calling `eq(decodedColumn, userValue)` elsewhere; today none do.
A lint rule for that is a possible follow-on, not part of this.

## Verification

- `./equin test plugins/fields` — the six operator maps still render
  byte-identical SQL; new enum cases for an out-of-domain operand against a real
  `parsedText` column (renders, does not throw) and for a tolerant column (binds
  the literal, is not normalized).
- `./equin test plugins/primitives/plugins/data-view` — `compile.test.ts`
  updated for the target signature, plus a decoded-column case end to end.
- `./equin check` — boundaries, types, lint.
- `./equin build`, then a stale saved view: set a conversations view's
  filter to `status is-any-of ["nope"]` and confirm the list renders empty
  instead of erroring, with the stale chip visible and removable in the picker.
