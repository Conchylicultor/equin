# Stage D — migrate `slow_ops` onto `defineEntity` (v2, re-validated)

> Supersedes `2026-06-18-global-define-entity-stage-d-slow-ops.md`. Stage D of
> `research/2026-06-17-global-fields-unified-entities.md`, building on the Stage C
> `defineEntity` primitive (`plugins/infra/plugins/entities`).
>
> **Why v2:** the v1 plan put the new `uuidField`/`dateField` factories in each type's
> *top-level* `core/`, justified by "uuid/date have no renderer so can't be `config`
> sub-plugins." Re-validation against current main **disproves that premise** —
> core-only sub-plugins (no runtime barrel) are fully valid and used in 20+ places
> (`framework/plugins/plugin-id`, `packages/plugins/{semaphore,retry,inflight}`,
> `code-explorer/plugins/code-api`, …). So a renderer-less `config` sub-plugin *is*
> possible, and v2 **mirrors the existing factory precedent exactly**: every field
> factory stays importable from `@plugins/fields/plugins/<type>/plugins/config/core`.

## Context

`slow_ops` declares its columns in **three hand-synced places**:

1. the Drizzle table — `plugins/debug/plugins/slow-ops/server/internal/tables.ts`
2. the zod wire schema — `plugins/debug/plugins/slow-ops/core/resources.ts`
3. the loader — `plugins/debug/plugins/slow-ops/server/internal/resources.ts`

The Stage-0 interim fix already deleted the loader's row projection (`db.select()`
returns rows verbatim) and added a compile-time `Equal<$inferSelect, SlowOp>` guard so
drift between table and schema is a loud `tsc` error instead of a silently-dropped
column (`recentSamples` was lost this way once). But table and schema are still **two
hand-written artifacts** that the guard merely *compares* — it doesn't make them derive
from one source.

`defineEntity(name, fields, meta)` now exists (Stage C, `plugins/infra/plugins/entities`)
and its codegen blocker is fixed on main (commit `34c3e0919` — `resolveFieldStorage`
self-loads the storage builders via a generic glob, so it resolves `fields.storage`
during the `drizzle-kit generate` subprocess, not just at server boot). We re-express
`SlowOp` as a **single field record**; the Drizzle table, the zod wire schema, and the
row type all derive from that one record, making the silent-column-drop footgun
structurally **unrepresentable**. The interim `Equal` guard becomes vacuous and is
deleted.

**Hard requirement: zero schema drift.** `./equin build` must generate **no new
migration**. The Stage C unit test (`define-entity.test.ts`) already proves
`defineEntity` reproduces the exact `slow_ops` DDL (snake_case names, `notNull`,
defaults, `double precision`, `jsonb`, `timestamptz`, the unique index); we verify
empirically.

### Re-validation deltas vs v1 (current main)

- **Factory placement — CHANGED to mirror precedent (this v2's headline).** New
  factories go in **core-only `config` sub-plugins**, not the type's top-level core.
- **New core symbols since v1, all NON-column, all left untouched:**
  `SlowOpMarkerSchema`, `SlowOpMarker`, `loadSeverity`, `slowOpConfig`,
  `SlowOpReportPayloadSchema`, `SlowOpReportPayload` in
  `slow-ops/core/resources.ts` (+ `core/index.ts`). These are the health-monitor
  overlay / report-kind / config concerns — they are **not** `slow_ops` columns and the
  migration does not touch them.
- **health-monitor coupling is marker-only, schema-stable.**
  `health-monitor/shared/schema.ts` imports `SlowOpMarkerSchema`;
  `health-monitor/server/internal/read-health-files.ts` imports `readSlowOpMarkers`
  from `slow-ops/server`. Neither imports `SlowOp`/`SlowOpSchema`/the DB layer — both
  are unaffected.
- **`z.coerce.date()` confirmed still load-bearing.**
  `slow-ops/plugins/cluster/server/internal/handle-cluster.ts` runs a **raw
  node-postgres** query and calls `SlowOpSchema.parse(...)` on rows whose
  `first_seen_at`/`last_seen_at` arrive as `Date | string`; the wire schema must keep
  coercing, so `dateField()` must emit `z.coerce.date()`.
- **`jsonField` opts are mandatory** (`{ schema, default }`, no `?`) — matches usage.
- **`defineEntity` API confirmed:** `meta.primaryKey: "id"`, `meta.columns[k].default`
  (bare value = `.default(v)` sugar, or `defaultNow()`/`defaultRandom()` markers),
  `meta.indexes: (t) => [...]`; `defaultNow`/`defaultRandom` are exported from
  `@plugins/infra/plugins/entities/server`. The returned entity exposes `.table` and
  `.schema`.

## Approach

### 1. Add `uuidField` / `dateField` as core-only `config` sub-plugins (mirror precedent)

Create one new sub-plugin per type, copying the **byte-for-byte shape** of
`plugins/fields/plugins/text/plugins/config/` minus its `web/` (uuid/date have no
config renderer; the `config-v2.fields.renderer` dispatch slot keys on `field.type.id`
with a graceful `fallback`, so registering none is correct). The result is a core-only
sub-plugin — valid and common in this repo.

**`plugins/fields/plugins/uuid/plugins/config/`**
- `package.json`:
  ```json
  {
    "name": "@singularity/plugin-fields-uuid-config",
    "version": "0.0.1",
    "private": true,
    "description": "UUID field factory (uuidField) for building field records.",
    "singularity": { "collapsed": true }
  }
  ```
- `core/index.ts`:
  ```ts
  export { uuidField, type UuidFieldDef } from "./internal/uuid";
  ```
- `core/internal/uuid.ts` (mirrors `text.ts`; `z.string().uuid()` preserves the exact
  current wire contract for `id`):
  ```ts
  import { z } from "zod";
  import { type FieldDef, type FieldMeta, pickMeta } from "@plugins/fields/core";
  import { uuidFieldType } from "@plugins/fields/plugins/uuid/core";

  export interface UuidFieldDef extends FieldDef<string> {
    readonly type: typeof uuidFieldType;
  }

  export function uuidField(opts?: FieldMeta & { default?: string }): UuidFieldDef {
    return Object.freeze({
      type: uuidFieldType,
      schema: z.string().uuid(),
      defaultValue: opts?.default ?? "",
      meta: pickMeta(opts),
    });
  }
  ```

**`plugins/fields/plugins/date/plugins/config/`**
- `package.json`: same shape, `name: "@singularity/plugin-fields-date-config"`,
  `description: "Date field factory (dateField) for building field records."`.
- `core/index.ts`:
  ```ts
  export { dateField, type DateFieldDef } from "./internal/date";
  ```
- `core/internal/date.ts` (`z.coerce.date()` is **load-bearing** — see below):
  ```ts
  import { z } from "zod";
  import { type FieldDef, type FieldMeta, pickMeta } from "@plugins/fields/core";
  import { dateFieldType } from "@plugins/fields/plugins/date/core";

  export interface DateFieldDef extends FieldDef<Date> {
    readonly type: typeof dateFieldType;
  }

  export function dateField(opts?: FieldMeta & { default?: Date }): DateFieldDef {
    return Object.freeze({
      type: dateFieldType,
      schema: z.coerce.date(),
      defaultValue: opts?.default ?? new Date(0),
      meta: pickMeta(opts),
    });
  }
  ```

> `CLAUDE.md` for each new sub-plugin is **auto-generated by `./equin build`** (the
> `plugins-have-claudemd` check requires it; build produces it). Do not hand-write it.

Imports are legal sub-plugin→parent-core (`@plugins/fields/plugins/<type>/core`) and
core→core (`@plugins/fields/core`) — exactly what `text/plugins/config` already does.

### 2. Field record + derived wire schema in `slow-ops/core`

`defineEntity` is server-only (imports `drizzle-orm/pg-core`), so the **field record
lives in core** — the only layer both server (build the table) and web (read the schema)
reach. Core derives the wire schema; the server reads the *same* record to build the
table.

In **`plugins/debug/plugins/slow-ops/core/resources.ts`**:

- **Keep unchanged:** `CallerBreakdownSchema`, `SlowOpSampleSchema` (+ their types) —
  these are nested JSON *value* schemas, the `json` fields' value schemas, not columns.
- **Keep unchanged (non-column concerns):** `SlowOpMarkerSchema` / `SlowOpMarker`,
  `loadSeverity`, `slowOpConfig`, `SlowOpReportPayloadSchema` / `SlowOpReportPayload`,
  and `slowOpsResource`.
- **Replace** the hand-written `SlowOpSchema = z.object({...})` with a field record +
  derivation (column order/types reproduce the existing table exactly):
  ```ts
  export const slowOpFields = {
    id:            uuidField(),
    worktree:      textField(),
    operationKind: textField(),
    operation:     textField(),
    count:         intField(),
    totalMs:       floatField(),
    maxMs:         floatField(),
    lastMs:        floatField(),
    thresholdMs:   floatField(),
    callers:       jsonField<CallerBreakdown[]>({ schema: z.array(CallerBreakdownSchema), default: [] }),
    recentSamples: jsonField<SlowOpSample[]>({ schema: z.array(SlowOpSampleSchema), default: [] }),
    firstSeenAt:   dateField(),
    lastSeenAt:    dateField(),
  } satisfies FieldsRecord;

  export const SlowOpSchema = fieldsToZodObject(slowOpFields);
  export type SlowOp = z.infer<typeof SlowOpSchema>;
  ```
- Imports to add: `uuidField` from `@plugins/fields/plugins/uuid/plugins/config/core`,
  `dateField` from `@plugins/fields/plugins/date/plugins/config/core`, `textField`/
  `intField`/`floatField`/`jsonField` from their respective
  `@plugins/fields/plugins/<type>/plugins/config/core`, and `fieldsToZodObject` +
  `type FieldsRecord` from `@plugins/fields/core`.

In **`plugins/debug/plugins/slow-ops/core/index.ts`**: add `slowOpFields` to the value
exports (server needs it). All other exports stay.

### 3. Build the table via `defineEntity` in `server/internal/tables.ts`

The `defineEntity(` call **must stay in a drizzle schema-glob file** (`tables.ts`) —
enforced by `table-defs-in-schema-glob` (`defineEntity` is in its `TABLE_FACTORIES`).
Replace the raw `pgTable(...)`:

```ts
import { uniqueIndex } from "drizzle-orm/pg-core";
import { defineEntity, defaultNow, defaultRandom } from "@plugins/infra/plugins/entities/server";
import { slowOpFields } from "../../core";

const slowOps = defineEntity("slow_ops", slowOpFields, {
  primaryKey: "id",
  columns: {
    id:            { default: defaultRandom() },
    count:         { default: 0 },
    totalMs:       { default: 0 },
    maxMs:         { default: 0 },
    lastMs:        { default: 0 },
    thresholdMs:   { default: 0 },
    callers:       { default: [] },
    recentSamples: { default: [] },
    firstSeenAt:   { default: defaultNow() },
    lastSeenAt:    { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("slow_ops_kind_op_worktree_idx").on(t.operationKind, t.operation, t.worktree),
  ],
});

// drizzle-kit schema-glob discovery (matches entity-extensions / attachments).
// Name kept as `_slowOps` so resources.ts / record-slow-op.ts / the server barrel don't churn.
export const _slowOps = slowOps.table;
```

This reproduces the exact existing DDL: `notNull` derives from each field's
non-optional schema; DB defaults are opt-in via `meta.columns`;
`worktree`/`operationKind`/`operation` get `notNull` with **no** default (matching the
migration). `id` → `uuid ... primaryKey defaultRandom`; the four floats →
`double precision ... default 0`; `count` → `integer ... default 0`; `callers`/
`recentSamples` → `jsonb ... default '[]'`; the two dates → `timestamptz ... defaultNow`.

### 4. Delete the interim guard; loader unchanged

In **`plugins/debug/plugins/slow-ops/server/internal/resources.ts`**:

- **Delete** the `Equal` / `Expect` / `_SlowOpRowMatchesWire` block (lines ~16–25) —
  the row type and wire schema now derive from one record, so they're identical *by
  construction*; the comparison is vacuous.
- **Loader body unchanged:**
  `db.select().from(_slowOps).orderBy(desc(_slowOps.totalMs))`. `_slowOps.$inferSelect ≡
  SlowOp` by construction, so the `Promise<SlowOp[]>` return type still holds.

No changes to `record-slow-op.ts`, `read-markers.ts`, `slow-op-kind.ts`,
`handle-cluster.ts`, the cluster aggregate, or the pane — they import `SlowOp` /
`SlowOpSchema` / `CallerBreakdown` / `SlowOpSample` / `SlowOpMarkerSchema` /
`readSlowOpMarkers` from core/server barrels whose names and runtime shapes are
preserved.

## Why `z.coerce.date()` is load-bearing (not `z.date()`)

`handle-cluster.ts` runs a raw node-postgres query and calls `SlowOpSchema.parse(...)`
on rows where `first_seen_at`/`last_seen_at` are `Date | string`. `dateField()` must
emit `z.coerce.date()` so the wire schema keeps coercing. `z.coerce.date()` still infers
to `Date`, so `z.infer<schema>` and the `timestamptz` `$inferSelect` column both remain
`Date` — select-type alignment holds.

`fieldsToZodObject` wraps each field with `.default(field.defaultValue)`, which only
fires on `undefined`. Every real row (drizzle loader rows, raw cluster rows) carries all
keys, so defaults never fire — no behavior change. The `Entity["schema"]` *type* is keyed
by the raw `F[K]["schema"]` (pre-`.default()`), so inference is unaffected.

## Files

**New (factories, core-only `config` sub-plugins):**
- `plugins/fields/plugins/uuid/plugins/config/{package.json, core/index.ts, core/internal/uuid.ts}`
- `plugins/fields/plugins/date/plugins/config/{package.json, core/index.ts, core/internal/date.ts}`
- (CLAUDE.md for each is autogen via `./equin build`)

**Modify (migrate slow_ops):**
- `plugins/debug/plugins/slow-ops/core/resources.ts` — field record + derived schema
- `plugins/debug/plugins/slow-ops/core/index.ts` — export `slowOpFields`
- `plugins/debug/plugins/slow-ops/server/internal/tables.ts` — `defineEntity` call
- `plugins/debug/plugins/slow-ops/server/internal/resources.ts` — delete guard

**Reference (no change):**
- `plugins/infra/plugins/entities/server/internal/{define-entity.ts,types.ts}` — primitive
- `plugins/fields/plugins/text/plugins/config/` — factory + sub-plugin shape to mirror
- `plugins/fields/plugins/{uuid,date}/core/internal/*.ts` — `uuidFieldType`/`dateFieldType`
- `.../slow-ops/plugins/cluster/server/internal/handle-cluster.ts` — relies on coercion

## Verification

1. **No schema drift (headline):** `./equin build`, then
   `./equin check migrations-in-sync` — clean, **no new migration file**. If one
   appears, diff its DDL and adjust `meta` until byte-identical (per the Stage C test it
   should not appear).
2. `./equin check type-check` — passes (derived row type ≡ wire schema; deleted
   guard no longer needed).
3. `./equin check plugin-boundaries`, `table-defs-in-schema-glob`,
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `plugins-have-claudemd` — green
   (the `defineEntity` call is in `tables.ts`; the two new core-only sub-plugins are
   discovered, registered in no runtime registry, and get autogen CLAUDE.md from build).
4. **DB structure unchanged:** `mcp__singularity__query_db` —
   `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'slow_ops'`
   — matches current columns/types, incl. `recent_samples jsonb`, `first_seen_at`/
   `last_seen_at timestamptz`, `id uuid`. Confirm the unique index
   `slow_ops_kind_op_worktree_idx` still exists.
5. **Pane renders every field incl. `recentSamples`:** open
   `http://<worktree>.localhost:9000` → Debug → Slow Ops; confirm rows render with
   caller breakdown and recent samples. Use a scripted `bun e2e/screenshot.mjs` run if
   the table needs seeding/interaction to surface samples.
6. (Optional) a small unit asserting `uuidField()`/`dateField()` shape (frozen, schema,
   defaultValue, meta) — the existing `define-entity.test.ts` already covers entity DDL.

## Out of scope

Stage E (list-semantics into `defineEntity`) and Stage F (broaden adoption + a
projection-detector guardrail). This task migrates `slow_ops` only.
