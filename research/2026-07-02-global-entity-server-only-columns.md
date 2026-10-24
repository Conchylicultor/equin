# `defineEntity` server-only columns — a column in the table, off the wire

> Follow-up #2 of [`2026-07-01-global-stage-f-entity-loader-migration-guardrail.md`](./2026-07-01-global-stage-f-entity-loader-migration-guardrail.md).

## Context

`defineEntity(name, fields, meta)` derives a Drizzle `pgTable` **and** its zod wire
schema from one `FieldsRecord`, guaranteeing `entity.table.$inferSelect ≡
z.infer<entity.schema>` **by construction**. A migrated loader becomes
`db.select().from(entity.table)` with no hand-written row projection, and the
`entity-projection-safety` lint rule (`no-hand-rolled-entity-projection`) blocks
new hand-rolled projections from reappearing.

But the invariant is *total* — every table column appears on the wire. That blocks
any table with columns intentionally kept **off** the wire: a debug-only `prompt`,
or `created_at`/`updated_at` timestamps the client never reads. Two such loaders
still hand-write a `rows.map(r => ({subset}))` projection and are **allowlisted**
(ignored) in the lint rule rather than migrated:

- `plugins/apps/plugins/story/plugins/generation/server/internal/resource.ts` —
  table `story_generated_units` has **12** columns; wire exposes **9** (omits
  `prompt`, `createdAt`, `updatedAt`).
- `plugins/apps/plugins/sonata/plugins/track-mixer/server/internal/resource.ts` —
  table `sonata_track_view` has **8** columns; wire exposes **6** (omits
  `createdAt`, `updatedAt`).

This plan adds a **server-only column** concept to `defineEntity`: a column present
in the table DDL but absent from the derived wire schema. That lets both loaders
migrate onto `defineEntity` (deleting their projections) and lets the two allowlist
entries be removed — closing the class of "hidden column" loaders the guardrail
currently has to wave through.

**Outcome:** one `FieldsRecord` + one `serverOnly` key-list is still the single
source of truth; the table keeps its full DDL (no migration churn), the wire schema
omits the server-only keys, and the loader selects only the wire columns (server-only
data is never fetched, so it can never leak).

## Design

### The two dimensions today (unchanged)

A `FieldDef` (`plugins/fields/core/internal/field-spec.ts`) carries **both** a
wire half (`schema`, browser-safe, in `fields/plugins/<t>/config/core`) and a storage
half (`build`, server-only, in `fields/plugins/<t>/storage/server`, keyed by
`type.id`). `defineEntity` (`plugins/infra/plugins/entities/server/internal/define-entity.ts`)
stitches them per key: `resolveFieldStorage(field.type.id)` builds each column;
`fieldsToZodObject(fields)` (`plugins/fields/core/internal/schema-builder.ts`, a
**strict** `z.object`) derives the wire schema. `fieldsToZodObject` is in
`fields/core` — **browser-safe**; only the drizzle assembly is server-only.

### The change — a `serverOnly` key list

**Marker: top-level `meta.serverOnly: readonly (keyof F & string)[]`.** Chosen over a
per-column `columns.<k>.serverOnly: true` for one decisive reason: the **web** needs
the identical omit-list to build its own browser-safe wire schema (entities is
server-only, so the web can't import `entity.schema`). A top-level array is exported
as **one constant in the plugin's browser-safe `core/`** and consumed by both
`defineEntity` (server) and the browser-side wire schema — a single source of truth
across the runtime boundary. A per-column flag lives inside server-only `meta` and
would force the web to re-declare the list, reintroducing the exact drift this
feature eliminates. (`serverOnly` is a wire-projection concern; `name`/`default`/
`references` stay per-column because they're DDL concerns.)

Concretely, in `plugins/infra/plugins/entities/server/internal/`:

1. **`types.ts`**
   - `EntityMeta<F>` gains `serverOnly?: readonly (keyof F & string)[];`.
   - New `ServerOnlyKeys<F, M>` (mirrors `DefaultedKeys`, but simpler — reads the
     array element type):
     ```ts
     export type ServerOnlyKeys<F extends FieldsRecord, M extends EntityMeta<F>> =
       M["serverOnly"] extends readonly (infer K)[] ? (K & keyof F) : never;
     ```
   - `Entity` gains a third param `S extends keyof F = never`:
     ```ts
     export interface Entity<F extends FieldsRecord, D extends keyof F = never, S extends keyof F = never> {
       readonly name: string;
       readonly table: PgTableWithColumns<{ … columns: BuildColumns<string, EntityColumns<F, D>, "pg"> }>; // FULL DDL — unchanged
       readonly schema: z.ZodObject<{ [K in Exclude<keyof F, S>]: F[K]["schema"] }>;                        // wire — omits S
       readonly wireColumns: Pick<BuildColumns<string, EntityColumns<F, D>, "pg">, Exclude<keyof F, S>>;    // select-map for the loader
     }
     ```
   - `EntityRow<E>` simplified to infer from the entity's own (already-omitted)
     schema: `E extends { schema: z.ZodType<infer T> } ? T : never`.

2. **`define-entity.ts`** — return type becomes
   `Entity<F, DefaultedKeys<F, M>, ServerOnlyKeys<F, M>>`. The column-builder loop
   (lines 79–116) is **untouched** — server-only columns are still built into the
   table exactly as today, so the DDL is byte-identical (no new migration). After
   `pgTable(...)`:
   ```ts
   const serverOnly = new Set<string>(meta.serverOnly ?? []);
   // guard: every serverOnly key must exist and must not be the primary key
   for (const k of serverOnly) {
     if (!(k in fields)) throw new Error(`defineEntity("${name}"): serverOnly key "${k}" is not a field.`);
     if (meta.primaryKey === k || (Array.isArray(meta.primaryKey) && meta.primaryKey.includes(k)))
       throw new Error(`defineEntity("${name}"): primary-key column "${k}" cannot be serverOnly.`);
   }
   const wireKeys = Object.keys(fields).filter((k) => !serverOnly.has(k));
   const schema = wireSchema(fields, meta.serverOnly ?? []);                       // omits server-only keys
   const wireColumns = Object.fromEntries(wireKeys.map((k) => [k, (table as any)[k]]));
   return Object.freeze({ name, table, schema, wireColumns }) as Entity<…>;
   ```
   (Replaces the current `const schema = fieldsToZodObject(fields)` at line 142.)

3. **New browser-safe helper `entities/core/internal/wire-schema.ts`** (add a `core/`
   to the entities plugin, which is server-only today):
   ```ts
   export function wireSchema<F extends FieldsRecord, S extends keyof F & string>(
     fields: F, serverOnly: readonly S[],
   ): z.ZodObject<{ [K in Exclude<keyof F, S>]: F[K]["schema"] }> {
     return fieldsToZodObject(fields).omit(
       Object.fromEntries(serverOnly.map((k) => [k, true as const])),
     ) as any;
   }
   ```
   Exported from a new `entities/core/index.ts` barrel. `defineEntity` (server) and
   each plugin's web side both call `wireSchema(fields, SERVER_ONLY)` — so
   `entity.schema` (server) and the browser-side wire schema are **equal by
   construction** (same helper, same inputs).

### Why `wireColumns`, not `db.select().from(table)` verbatim

The migrated loader selects **only** the wire columns:
```ts
loader: async () => db.select(storyGeneratedUnits.wireColumns).from(storyGeneratedUnits.table)
```
This never fetches the server-only columns, so they cannot leak regardless of whether
live-state validates loader output before pushing. (A `db.select().from(table)` + rely
on the strict-object schema to strip extras would fetch `prompt` and depend on a
downstream strip — a leak risk if output isn't server-validated. `wireColumns` is
unconditionally safe and honest.) It has **no `.map`**, so the lint rule does not fire.

### Type invariant

The existing compile-time `Equal<z.infer<schema>, table.$inferSelect>` guard in
`define-entity.test.ts` still holds for entities **without** `serverOnly` (e.g.
`slow_ops`). Add a new test entity **with** a server-only column asserting:
- `Equal<z.infer<schema>, Omit<table.$inferSelect, ServerOnlyKey>>`, and
- `wireColumns` excludes the server-only key (its `Object.keys` and inferred select
  type omit it).

## Migration 1 — story/generation (`prompt`, `createdAt`, `updatedAt` server-only)

**Fields + constants** → `plugins/apps/plugins/story/plugins/generation/core/` (browser-safe;
currently the wire schema lives in `shared/resources.ts:7-17`):
```ts
export const storyGeneratedUnitFields = {
  id:        uuidField(),
  pageId:    textField(),
  kind:      textField(),
  unitId:    textField(),
  inputHash: textField(),
  status:    enumTextField(["generating", "ready", "error"]),  // replaces $type<GenStatus>() + z.enum cast
  output:    nullable(textField()),
  prompt:    nullable(textField()),
  instruction: nullable(textField()),
  error:     nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const STORY_GENERATED_UNIT_SERVER_ONLY = ["prompt", "createdAt", "updatedAt"] as const;

export const StoryGeneratedUnitRowSchema = wireSchema(storyGeneratedUnitFields, STORY_GENERATED_UNIT_SERVER_ONLY);
export type StoryGeneratedUnitRow = z.infer<typeof StoryGeneratedUnitRowSchema>;   // 9 fields, browser-safe
```

**Entity** → `.../generation/server/internal/tables.ts`:
```ts
export const storyGeneratedUnits = defineEntity("story_generated_units", storyGeneratedUnitFields, {
  primaryKey: "id",
  serverOnly: STORY_GENERATED_UNIT_SERVER_ONLY,
  columns: {
    id:        { default: defaultRandom() },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [uniqueIndex("story_generated_units_pk_idx").on(t.pageId, t.kind, t.unitId)],
});
export const _storyGeneratedUnits = storyGeneratedUnits.table;   // drizzle-kit discovery
```

**Loader** → `.../generation/server/internal/resource.ts`: delete the `.map` (lines
18–28); use `storyGeneratedUnits.schema` for the resource `schema` and
`db.select(storyGeneratedUnits.wireColumns).from(storyGeneratedUnits.table)`.
`shared/resources.ts` keeps the browser-safe client descriptor, now importing
`StoryGeneratedUnitRowSchema`/`StoryGeneratedUnitRow` from `core/`.

**Web:** `web/hooks.ts` consumers read `status`/`output`/`error`/`inputHash`/
`instruction` — all still on the wire. No server-only field is consumed and no
timestamp was ever exposed, so **no Date-string flip and no consumer breakage**.

## Migration 2 — sonata/track-mixer (`createdAt`, `updatedAt` server-only)

**Fields + constants** → `.../track-mixer/core/` (wire schema currently at
`shared/resources.ts:13-20`):
```ts
export const trackViewFields = {
  songId:     textField(),
  trackId:    textField(),
  color:      nullable(textField()),
  instrument: nullable(textField()),
  muted:      boolField(),
  hidden:     boolField(),
  createdAt:  dateField(),
  updatedAt:  dateField(),
} satisfies FieldsRecord;

export const TRACK_VIEW_SERVER_ONLY = ["createdAt", "updatedAt"] as const;
export const TrackViewRowSchema = wireSchema(trackViewFields, TRACK_VIEW_SERVER_ONLY);   // 6 fields
export type TrackViewRow = z.infer<typeof TrackViewRowSchema>;
```

**Entity** → `.../track-mixer/server/internal/tables.ts`:
```ts
export const trackView = defineEntity("sonata_track_view", trackViewFields, {
  primaryKey: ["songId", "trackId"],
  serverOnly: TRACK_VIEW_SERVER_ONLY,
  columns: {
    songId:    { references: { column: () => /* existing _songs.id reference */, onDelete: "cascade" } },
    muted:     { default: false },
    hidden:    { default: false },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
});
export const _trackView = trackView.table;
```
> **Verify the cross-plugin `_songs` FK reference resolves.** The current
> `tables.ts` already references `_songs` (owned by `sonata/library`, migrated to
> `defineEntity` in Stage F) for its `song_id` FK. Preserve exactly whatever import
> path is in use today, expressed as the `references.column` thunk. FK thunks that
> point at another plugin's table are an existing pattern (e.g. `mail_threads` →
> `mailAccounts.table.id`); confirm the boundary checker accepts it as-is.

**Loader** → `.../track-mixer/server/internal/resource.ts`: delete the `.map` (lines
18–25); `schema: z.array(trackView.schema)` (or the client descriptor's), loader
`db.select(trackView.wireColumns).from(trackView.table)`.

**Web:** `web/hooks.ts` + downstream (piano-roll, notation, audio-engine,
piano-keyboard, track-mixer-panel) read `instrument`/`color`/`muted`/`hidden` — all
on the wire. No timestamp consumed → **no breakage**.

## Remove the allowlist entries

In `plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/lint/index.ts`,
delete the two "column-excluding loaders" entries (lines 25–26) and the now-empty
comment block (lines 20–24). Keep the separate "entity-extension side-tables"
sub-list (lines 10–19) — that's the unrelated follow-up #1 deferral. The rule's
detection logic (`no-hand-rolled-entity-projection.ts`) and the `ignores`-consuming
`build-lint-config.ts` need **no** changes — removing the array entries is sufficient
(each removed glob was emitted as one `{ files, rules: {…: "off"} }` config; dropping
it re-subjects the file to the `"error"` rule, which now passes because the loader is
projection-free). Update the hand-maintained prose in the rule plugin's `CLAUDE.md` if
it still names the column-excluding deferral.

## Critical files

- **Primitive** — `plugins/infra/plugins/entities/server/internal/{types.ts,define-entity.ts}`;
  new `plugins/infra/plugins/entities/core/{index.ts,internal/wire-schema.ts}`; barrel
  `plugins/infra/plugins/entities/server/index.ts` (export `wireSchema` type/helper path if re-exported);
  test `plugins/infra/plugins/entities/server/internal/define-entity.test.ts`.
- **Field helpers reused** — `@plugins/fields/core` (`FieldsRecord`, `fieldsToZodObject`,
  `nullable`), `textField`/`enumTextField` (`@plugins/fields/plugins/text/plugins/config/core`),
  `uuidField`/`boolField`/`dateField` (respective `config/core`).
- **Migration 1** — `plugins/apps/plugins/story/plugins/generation/{core,shared/resources.ts,server/internal/tables.ts,server/internal/resource.ts}`.
- **Migration 2** — `plugins/apps/plugins/sonata/plugins/track-mixer/{core,shared/resources.ts,server/internal/tables.ts,server/internal/resource.ts}`.
- **Lint cleanup** — `plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/lint/index.ts` (+ its `CLAUDE.md`).

## Verification

1. **DDL unchanged:** `./equin build` generates **no new migration**
   (`./equin check migrations-in-sync` clean → byte-identical DDL for both
   tables). Confirm column counts via `mcp__singularity__query_db`
   (`story_generated_units` = 12 cols, `sonata_track_view` = 8 cols).
2. **Wire omits server-only:** the resource endpoints (`story-generated-units`,
   `sonata` track-view) serve rows **without** `prompt`/`createdAt`/`updatedAt`.
   Verify at `http://<worktree>.localhost:9000` — open a Story blog page (generated
   units render: status/output/error/instruction) and a Sonata song (track mixer:
   colors/instruments/mute/hide all work).
3. **No leak:** confirm the served payloads contain no `prompt` field (network
   inspection or `query_db` against the resource output shape).
4. **Type invariant:** `./equin check type-check` clean; the new
   server-only test entity's `Equal<>`/`wireColumns` assertions pass; removing
   `serverOnly` from a field that a `.select(wireColumns)` still references is a tsc
   error.
5. **Rule still enforces:** temporarily reintroduce a `rows.map(r => ({subset}))`
   pure projection in a `defineResource` loader → `type-check`/eslint errors; revert.
   Confirm the two migrated loaders (now projection-free) do **not** error with their
   allowlist entries removed, and a known transform (e.g. `tasks-core` attempts) is
   still not flagged.
6. **Full green:** `./equin check` passes (boundaries,
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`,
   `table-defs-in-schema-glob`, `migrations-in-sync`).

## Out of scope / follow-ups

- **build / release / shell-notifications** (explicit `db.select({cols})` loaders
  omitting an internal `pid`/`dedupKey`, plus worktree-namespace filtering) — not
  lint-flagged, extra concerns; could migrate onto `serverOnly` later (research
  follow-up #3), but no allowlist to clean up.
- **Broaden the rule to the `db.select({explicit cols})` form** now that a
  server-only concept exists (research follow-up #3) — separate change.
- **entity-extension side-tables** (follow-up #1) — needs `defineExtension` to derive
  a wire schema; unrelated, stays allowlisted.
