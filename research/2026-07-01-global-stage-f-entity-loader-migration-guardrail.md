# Stage F — broaden `defineEntity` adoption + add the projection guardrail

> Stage F of [`2026-06-17-global-fields-unified-entities.md`](./2026-06-17-global-fields-unified-entities.md).
> Stages 0/1/A/B/C/D are landed; `defineEntity` and the `fields.storage` matrix are in
> production (`slow_ops`, `mail-core`, `tasks-core`, `boot-profile`).

## Context

`defineEntity(name, fields, meta)` derives a Drizzle `pgTable` **and** its zod wire schema from
one `FieldsRecord`, so `entity.table.$inferSelect ≡ z.infer<entity.schema>` **by construction** — a
live-state loader becomes `db.select().from(entity.table)` with **no row projection**, and a
dropped/renamed column is a `tsc` error instead of a silent wire drop.

But most 1:1 table-backed loaders were never migrated. They still hand-write a
`rows.map(r => ({ ... }))` identity projection — the exact footgun that silently dropped
`recentSamples` from `slow_ops` on first pass. Nothing stops a new one from being introduced. This
stage (a) migrates the remaining **pure 1:1** plain-`pgTable` loaders onto `defineEntity`, and (b)
adds a **blocking ESLint rule** so a hand-rolled identity projection in a resource loader can never
reappear.

## What already exists (no new field/primitive work needed)

- **`defineEntity`** — `plugins/infra/plugins/entities/server` (server-only). `meta` = `primaryKey`
  (single/composite), `columns.<k>.{name,default,references}`, `indexes`. Markers `defaultNow()`,
  `defaultRandom()`, `sqlDefault()`. Returns `{ name, table, schema }`; `EntityRow<typeof e>` sugar.
- **All storage capabilities needed already ship**: `text`, `uuid`, `int`, `float`, `bool`, `date`,
  `json`, `rank` (`plugins/fields/plugins/<type>/plugins/storage/server`).
- **`enumTextField(values, opts)`** (`plugins/fields/plugins/text/plugins/config/core/internal/enum-text.ts`)
  — a `text` column branded with a closed union: text storage (DDL-identical to a raw text column)
  **+** enum wire schema. This eliminates every `phase as Phase` / enum cast in the loaders below with
  **zero** new field-type work.
- **`dateField()`** — timestamptz column; wire value is a `Date` (coerced), as in `slow_ops`. See the
  Date hazard below.
- **Reference rule** to model the guardrail on: `no-reactive-server-io`
  (`plugins/framework/plugins/tooling/plugins/lint/plugins/reactive-server-io/lint/`).

## Scope (decided)

**In — migrate these 8 plain-`pgTable`, pure-1:1 loaders onto `defineEntity`:**

| # | Loader (`server/internal/…`) | Table | Notes on the projection to delete |
|---|---|---|---|
| 1 | `conversations/summary/…/resources.ts` | `_conversationSummaries` | `generatedAt` Date→ISO + `phase as Phase`. Use `dateField()` + `enumTextField(PHASES)`. Keep the group-by-conversationId `for` loop. Also switch the flat `defineResource({...})` to the 2-arg descriptor form (a same-key client descriptor already exists in `shared/resources.ts`). |
| 2 | `infra/claude-cli/…/resources.ts` | `_claudeCliCalls` | straight copy + one enum cast → `enumTextField`. |
| 3 | `plugin-meta/plugin-health/…/resource.ts` | `_pluginHealthReviews` | copy + `createdAt.toISOString()` → `dateField()`. |
| 4 | ~~`apps/story/generation`~~ | ~~`_storyGeneratedUnits`~~ | **DROPPED during impl** — not pure 1:1. The table has 12 columns; the wire has 9 (omits server-only `prompt` + `created_at`/`updated_at`). It's a column-excluding loader → deferred (allowlisted), see below. |
| 5 | `apps/sonata/library/…/resources.ts` (`toSong`) | `_songs` | copy + `createdAt.toISOString()` → `dateField()`. (Confirmed pure 1:1 despite the roadmap naming it a "transform" — the transform lives in web hooks, not this loader.) |
| 6 | `config_v2/staging/…/resource.ts` | `_stagedConfigDefault` | copy + one `as unknown` cast; re-express the cast column as a typed `jsonField<T>()`/`enumTextField`. |
| 7 | `infra/events/…/resources.ts` (`loadEmissions` only) | `_event_emissions` | copy + Date→ISO guard → `dateField()`. **Leave `loadTriggers` in the same file untouched** (dynamic per-table shape — a genuine transform). |
| 8 | `apps/browser/bookmarks/…/resource.ts` | `_browserBookmarks` | Currently drops `created_at` from the wire. Add `createdAt: dateField()` to the wire schema (benign additive change) so the entity's `table ≡ wire` holds, then drop the `.map`. |

**Deferred (separate follow-up) — entity-extension side-tables:** `pages/starred` and
`tasks/auto-start` hand-project, but their table is owned by `defineExtension`
(`plugins/infra/plugins/entity-extensions`), which does **not** derive a wire schema. Migrating them
means enhancing `defineExtension` to expose `.schema` — a load-bearing-primitive change out of scope
here. `tasks/auto-start` is a pure projection → **allowlist** it in the new rule with a TODO.
(`pages/starred` uses `Rank.from(r.rank)`, a call, so the strict rule won't flag it anyway.)

**Out of scope (guardrail must not target them):**
- Column-excluding `db.select({explicit cols})` loaders (`build`, `release`, `shell/notifications`) —
  intentionally omit an internal column (`pid`/`dedupKey`); incompatible with `table ≡ wire`. They use
  the `select({...})` form, **not** `.map`, so the `.map`-projection rule never matches them. Left as-is.
- Genuine transforms (joins/aggregation/fan-out): `tasks-core` attempts/tasks, `agents`,
  `all-conversations` rev, `workflows/engine`, `commits-graph`, `plugin-changes`, `jobs/loadTriggers`.
  These have computed properties, so the strict rule (below) never flags them.

## Part 1 — migration recipe (per table)

For each of the 8:

1. **Define the field record** in the plugin's `core/` (or `shared/`) next to the wire schema, e.g.
   ```ts
   export const conversationSummaryFields = {
     id:                  textField(),
     conversationId:      textField(),
     generatedAt:         dateField(),
     phase:               enumTextField(PHASES),
     phaseDetail:         nullable(textField()),           // nullable column + wire
     // …
   } satisfies FieldsRecord;
   ```
   Nullability comes from the **field schema**, expressed with the `nullable(...)` wrapper from
   `@plugins/fields/core` (`nullable(textField())`). There is **no** `textField({ nullable: true })` —
   `FieldMeta` has no `nullable` key. `defineEntity` reads the wrapped schema (`ZodNullable`) and drops
   `.notNull()`. Match each column's current `.notNull()` exactly or DDL drifts.
2. **Build the entity** in `server/internal/tables.ts`:
   ```ts
   export const conversationSummaries = defineEntity("conversation_summaries", conversationSummaryFields, {
     primaryKey: "id",
     columns: { generatedAt: { default: defaultNow() } },
     indexes: (t) => [index("…").on(t.conversationId, t.generatedAt)],
   });
   export const _conversationSummaries = conversationSummaries.table;   // drizzle-kit discovery
   ```
   Reproduce column-name overrides (`snakeCase` is automatic; add `columns.<k>.name` only for
   mismatches), defaults (`defaultNow()`/`defaultRandom()`/bare value), and every index **exactly**.
3. **Derive the wire schema** from the same record: `export const XSchema = conversationSummaries.schema`
   (replaces the hand-written `z.object`). Keep the exported type via `EntityRow<typeof …>`.
4. **Delete the projection**: loader returns `db.select().from(_table).orderBy(...)` verbatim (keep any
   post-map grouping/`orderBy`). Remove the `rowTo…` helper and any `as` casts.
5. **Verify zero drift**: `./equin build` must generate **no new migration** (`migrations-in-sync`
   clean). If it does, adjust `meta`/field nullability until the DDL is byte-identical.

### Migration hazards to watch

- **Date wire representation.** `dateField()` yields a **`Date`** on the wire (coerced), whereas some
  current schemas type the field as `z.string()` (ISO). Migrating flips the consumer-facing type from
  `string` → `Date`. Grep each field's web consumers (e.g. `generatedAt`, `createdAt`) and update any
  code that assumed a string (`new Date(x)` → `x`, formatting helpers). This is the `slow_ops` precedent.
- **Enum casts** → `enumTextField(VALUES)`; the union is preserved on the wire, DDL stays plain `text`.
- **`as unknown`/typed-json columns** (`config_v2/staging`) → `jsonField<T>()` with the real value schema.
- **`_event_emissions`** is a partial-file migration: migrate `loadEmissions`, leave `loadTriggers`.

## Part 2 — the guardrail (blocking ESLint rule)

New lint plugin, modeled on `reactive-server-io`:

```
plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/
  lint/index.ts                              // default { name, rules, ignores }
  lint/no-hand-rolled-entity-projection.ts   // the rule (ESLintUtils.RuleCreator)
```

Auto-registration is automatic: `build-lint-config.ts` walks every `lint/index.ts`, enables each rule
at `"error"` repo-wide, and the `type-check` check runs it. `./equin build` regenerates
`lint.generated.ts` (drift caught by `plugins-registry-in-sync`).

### Detection (deliberately conservative — favor false negatives, like `no-reactive-server-io`)

Visit `CallExpression`; fire **only** when ALL of these hold:

1. **It's a `.map(cb)`** — callee is a `MemberExpression` with `property.name === "map"`.
2. **Its receiver is a drizzle select** — unwrap `AwaitExpression`/parens on `callee.object`, then
   confirm the expression is a call chain containing a `.from(` member call rooted at a `db.select(…)`
   (name-based, like `no-reactive-server-io`'s sink match — no import resolution).
3. **The callback returns an object-literal pure field-copy** — arg 0 is an arrow/function with a
   single param `p`, returning (directly or via `return`) an `ObjectExpression` in which **every**
   property value is a *pure access of `p`*: `p.x`, `p.x.toISOString()`, or `p.x as T`
   (`TSAsExpression` over `p.x`). If **any** property is a call to something else, a join result, a
   reference to a non-`p` identifier, a ternary, etc. → **do not fire** (it's a genuine transform).
4. **It sits inside a `defineResource` loader** — walk `node.parent` up to the nearest object
   `Property` named `loader` whose enclosing `CallExpression` callee is `defineResource`. Scopes the
   rule to live-state loaders (won't flag endpoints/scripts).

Report on the `.map` node: *"Hand-rolled row projection over a db.select() — define the table with
`defineEntity` (`@plugins/infra/plugins/entities/server`) so the wire schema derives from the same
field record and return `db.select()` rows verbatim. See research/2026-06-17-global-fields-unified-entities.md."*

Because condition 3 requires an all-pure projection, the genuine transforms are structurally excluded
with **no allowlist**. `ignores` (per-rule, off for specific globs) is needed only for the deferred
extension-backed loader:

```ts
export default {
  name: "entity-projection-safety",
  rules: { "no-hand-rolled-entity-projection": rule },
  ignores: {
    // Deferred: entity-extension side-table; needs defineExtension to derive a wire schema.
    "no-hand-rolled-entity-projection": ["plugins/tasks/plugins/auto-start/server/internal/resource.ts"],
  },
};
```

> The `db.select({explicit cols})` column-list form is **intentionally not** targeted (subset selects
> are often legitimate). This rule covers only the `.map(row => ({...}))` footgun named in the roadmap.

## Critical files

- **New rule**: `plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/lint/{index.ts,no-hand-rolled-entity-projection.ts}`
- **Rule reference**: `plugins/framework/plugins/tooling/plugins/lint/plugins/reactive-server-io/lint/no-reactive-server-io.ts`; auto-reg in `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`
- **Field helpers**: `@plugins/fields/core` (`FieldsRecord`, `fieldsToZodObject`), `textField`/`enumTextField` (`@plugins/fields/plugins/text/plugins/config/core`), `uuidField`/`intField`/`floatField`/`boolField`/`dateField`/`jsonField` (respective `fields/plugins/<type>/plugins/config/core`)
- **Entity factory**: `@plugins/infra/plugins/entities/server` (`defineEntity`, `defaultNow`, `defaultRandom`, `sqlDefault`, `EntityRow`)
- **Per-migration** (`tables.ts`, `server/internal/resource(s).ts`, `shared/…resources.ts`): the 8 loaders listed in the Scope table.

## Verification

- **Each migration**: `./equin build` → **no new migration file**; `./equin check migrations-in-sync` and `type-check` clean; `mcp__singularity__query_db` confirms the table DDL is unchanged; open the relevant surface at `http://<worktree>.localhost:9000` and confirm every field (esp. the date/enum ones) still renders — e.g. conversation summaries in the conversation view, Debug → Claude CLI Calls, Debug → Reports (plugin-health), the Sonata library, bookmarks bar.
- **The rule fires correctly**: temporarily reintroduce a `rows.map(r => ({...}))` pure projection in a `defineResource` loader → `./equin check type-check` (or `bunx eslint`) errors; revert. Confirm the 7–8 migrated loaders (now projection-free) do **not** error, and that a known transform (`tasks-core` `attemptsResource`, which builds `conversations: [...]`) is **not** flagged.
- **Allowlist works**: `tasks/auto-start` (still projecting) does not error.
- **Full green**: `./equin check` passes (boundaries, `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`, `table-defs-in-schema-glob`).

## Implementation outcome (landed)

- **7 loaders migrated** onto `defineEntity`: conversations/summary, sonata/library, claude-cli,
  config_v2/staging, plugin-health, events (emissions), bookmarks. `./equin build` generated
  **no new migration** (`migrations-in-sync` clean → DDL byte-identical); DB column counts and the
  live resource endpoints (`claude-cli-calls`, `conversation-summaries`, `sonata-songs`,
  `event-emissions`) all serve HTTP 200 with correctly-shaped data (enum via `enumTextField`, nullable
  fields, coerced `Date` timestamps).
- **story/generation was NOT migrated** — during impl it proved to be a column-excluding loader
  (12-col table, 9-field wire, omits server-only `prompt`/timestamps), so migrating would either emit a
  destructive migration or leak `prompt` to all clients. Correctly deferred to follow-up #2.
- **Guardrail is live** and, on first enable, surfaced **5 pre-existing offenders** the manual sweep
  missed — proving it works. All are legitimate deferred exceptions, now allowlisted:
  - entity-extension side-tables (follow-up #1): `tasks/auto-start`, `conversations…/queue`,
    `sonata/transpose`, `sonata/rich/key-mode`, `sonata/sources/midi`.
  - column-excluding loaders (follow-up #2): `apps/story/generation`, `sonata/track-mixer`.
- **API correction**: nullable fields use `nullable(textField())` from `@plugins/fields/core`, not a
  `textField({ nullable: true })` option (the latter does not exist).

## Out of scope / follow-ups

1. **Enhance `defineExtension` to derive a wire schema**, then migrate `pages/starred` + `tasks/auto-start`
   and remove the `ignores` entry.
2. **Server-only columns** for `defineEntity` (a column present in the table but absent from the wire),
   which would let the column-excluding loaders (`build`, `release`, `shell/notifications`) migrate too.
3. Optionally broaden the rule to the `db.select({explicit cols})` form once a "server-only column"
   concept exists.
