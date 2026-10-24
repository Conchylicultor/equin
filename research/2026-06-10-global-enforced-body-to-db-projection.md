# Enforced body→DB field projection (`project` primitive + lint)

## Context

A field added to an HTTP request body — validated by zod, present in the TS type
— can typecheck and still land as NULL in the DB, because an intermediate
hand-written field-by-field re-mapping silently omitted it. This already shipped
once: the crash-attribution fields `clientId`/`buildId` were dropped at the
`body → recordCrash(input)` hand-map in `plugins/crashes/server/internal/handle-report.ts`,
caught only by manual DB inspection.

This is a **class** of bug, not a one-off. A survey of all `implement(...)`
handlers found ~13 sites carrying the re-stated-field-list shape. The root cause:

- The **wire contract** (zod body schema, in `core/`, the public API) and the
  **storage schema** (drizzle table, in `server/internal/`) are deliberately
  separate concerns, separated by an enforced boundary (`core` may not import
  `server`). They legitimately differ (server-computed columns, renames,
  transforms, fields routed elsewhere). The duplication is **justified**.
- What is missing is an **enforced translation** between them. Today the hop is a
  hand-written object literal with no forcing function.

Why TypeScript can't catch it on its own: the dropped field is an
optional/nullable target, so omitting it is a legal object literal. **There is no
TS feature for "every field of a source type must be consumed"** — reads are
never exhaustiveness-checked.

## The fix in one sentence

Provide a mapper whose *spec is exhaustive over the source keys* (so omitting a
field is a **compile error**), and a **lint rule** that *requires handlers to use
it* (so the pattern can't reappear). Types make the mapping correct; lint makes
the mapper mandatory.

Two enforcement layers, because they answer two different questions:

| Question | Mechanism | Guarantee |
|---|---|---|
| Is a given mapping complete? | **Type system** (`-?` mapped-type spec) | Airtight, automatic |
| Did you use the mapper at all? | **Lint rule** (AST) | "use the safe construct" is *always* a lint concern — no type can compel a call |

Rejected alternatives (already evaluated): `createInsertSchema(table)` to derive
the body schema — blocked by the `core`↛`server` boundary, payoff collapses once
the mapper exists. A `defineEntity` that *fuses* wire+storage — only fits thin
CRUD, couples the public API to the DB, fights the boundary; wrong altitude.

---

## Part 1 — The `project` primitive

New **server-only** sub-plugin `plugins/infra/plugins/db-project/`, mirroring
`plugins/infra/plugins/entity-extensions/` (which already constrains a spread
payload with `InferInsertModel<T>`).

```
plugins/infra/plugins/db-project/
  server/
    index.ts                      # barrel: export { project, projectInsert, DROP }
    internal/project.ts           # impl + types
  lint/
    index.ts                      # default export { name, rules }
    no-manual-body-mapping.ts     # the rule (Part 2)
```

### Core mechanism — exhaustiveness via `-?`

```ts
// internal/project.ts
import type { InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

// Greppable, intentional "this source field does not map".
export const DROP = Symbol("db-project.DROP");
type Drop = typeof DROP;

// One directive per SOURCE key.
//   "same"          → copy verbatim to the output key of the SAME name
//   { to }          → rename to a different output key
//   { fn }          → transform in place (output key === source key)
//   { to, fn }      → rename + transform
//   DROP            → explicit non-mapping
type Directive<S, K extends keyof S, OutKey extends string> =
  | "same"
  | Drop
  | { to: OutKey; fn?: (value: S[K]) => unknown }
  | { fn: (value: S[K]) => unknown };

// THE forcing function: `-?` strips optionality so EVERY source key is required
// in the spec literal. Without `-?`, homomorphic mapped types preserve the `?`
// from zod `.optional()` fields and the spec key becomes omittable — silently
// reintroducing the bug. This is load-bearing; a compile-fail type-test guards it.
type ProjectSpec<S, OutKey extends string> = {
  [K in keyof S]-?: Directive<S, K, OutKey>;
};
```

### Two thin signatures over one impl

```ts
// Generic — for body → repo-DTO hops (the crashes-bug location). Output shape is
// derived from the spec; the CONSUMING call site (a typed DTO param) checks that
// required target fields are present and value types match.
export function project<S extends object>(
  source: S,
  spec: ProjectSpec<S, string>,
): Record<string, unknown>;

// Table-aware — for direct → db.insert(table).values() hops. Adds column-name
// validation: `to:` and same-name keys are constrained to real columns, so a
// typo'd column is a compile error AT THE SPEC.
export function projectInsert<T extends PgTable, S extends object>(
  table: T,
  source: S,
  spec: ProjectSpec<S, keyof InferInsertModel<T> & string>,
): Partial<InferInsertModel<T>>;
```

Runtime is a trivial data-driven loop shared by both (it cannot diverge from the
types):

```ts
function run(source: object, spec: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const d = (spec as Record<string, unknown>)[key];
    if (d === DROP) continue;
    const value = (source as Record<string, unknown>)[key];
    if (d === "same") { out[key] = value; continue; }
    const dir = d as { to?: string; fn?: (v: unknown) => unknown };
    out[dir.to ?? key] = dir.fn ? dir.fn(value) : value;
  }
  return out;
}
```

### Guarantees and honest limits

- **Exhaustiveness (headline):** every source field must be `"same"` / `{to}` /
  `{fn}` / `DROP` or it won't compile. No silent drops, ever.
- **Column-name validity** (`projectInsert` only): `to:` constrained to real
  columns.
- **Limits (document in CLAUDE.md):**
  - The `-?` is essential — covered by a `tsd`/`expect-type` compile-fail test.
  - A transform's *return-type* mismatch vs. its column is best-effort (caught
    when the result is passed directly to `.values()`, maskable when spread
    alongside server columns). Exhaustiveness + column names are the hard wins.
  - Only works on **closed** object types (zod infers, DTO interfaces), never
    `Record<string, …>` (`keyof` is `string` → exhaustiveness collapses). All 219
    endpoint bodies qualify; the lint rule skips `Record`-typed sources.

### Worked examples

**`crashes/record-crash.ts`** (transform + rename + verbatim — the showcase):

```ts
const projected = projectInsert(_crashes, input, {
  message:        { fn: (m) => clamp(m, MESSAGE_MAX) },
  stack:          { fn: (s) => (s != null ? clamp(s, STACK_MAX) : null) },
  componentStack: { fn: (s) => (s != null ? clamp(s, COMPONENT_STACK_MAX) : null) },
  clientId:       { to: "lastClientId" },
  buildId:        { to: "lastBuildId" },
  source: "same", errorType: "same", url: "same",
  userAgent: "same", slot: "same", label: "same",
});
await db.insert(_crashes).values({ ...projected, id, fingerprint: fp, worktree, crashLoop: loop, noise });
```

**`agents/handle-create.ts`** (pure pass-through + server `id`/`rank` — primary
live bug-class instance):

```ts
const projected = projectInsert(_agents, body, {
  parentId:     { fn: (p) => p ?? null },
  name:         { fn: (n) => n ?? "Untitled" },
  prompt:       { fn: (p) => p ?? null },
  model:        { fn: (m) => m ?? null },
  icon:         { fn: (i) => i ?? null },
  iconColor:    { fn: (c) => c ?? null },
  iconSvgNodes: { fn: (s) => s ?? null },
});
await db.insert(_agents).values({ ...projected, id, rank: rank.toJSON() });
```

Add `notes` to `CreateAgentBodySchema` + a `notes` column → the spec fails to
compile until you add `notes: "same"` (persists) or `notes: DROP` (intentional).

---

## Part 2 — Lint rule `no-manual-body-mapping` (the enforcement half)

Type-aware ESLint rule modeled on the working precedent
`plugins/primitives/plugins/data-table/lint/no-class-as-grid-width.ts`
(`ESLintUtils.getParserServices` + scope tracking). Contributed via
`plugins/infra/plugins/db-project/lint/index.ts` (`{ name, rules }`), applied
repo-wide by the root `eslint.config.ts`.

**What it flags:** inside an `implement(endpoint, async ({ body }) => …)` handler,
a *fresh object literal* whose property values read the `body` binding, passed as
a **call argument** (to `.values(...)`, or to a repo/record/create function).
This is exactly the seam where untrusted wire input crosses into internal shapes
— and where the original crashes drop happened (`body → recordCrash(input)`).

**Sanctioned shapes (not flagged):**
- `recordCrash(body)` / `updateTask(id, body)` — direct pass-through.
- `{ ...project(body, {…}) }` or `{ ...projectInsert(_t, body, {…}), id }` — the
  mapper output (optionally spread with server-computed columns).

**Why it's precise:** the fingerprint "fresh literal that reads the handler's
`body` param, passed to a call" is narrow. PATCH accumulators (`if (body.x !==
undefined) patch.x = …; db.update().set(patch)`) aren't fresh literals → not
flagged. Repo mutations read `input`, not `body` → not flagged (out of scope by
design; see below). Escape hatch: `// eslint-disable-next-line
db-project/no-manual-body-mapping -- <reason>` for genuine one-offs, matching the
repo's existing disable-with-reason convention.

**Explicitly out of scope (future hardening, not this plan):** the *internal*
repo-layer `db.insert(t).values({…input…})` hops in `tasks-core` mutations. These
read already-validated internal DTOs (lower risk) and use the intended
typed-`CreateXInput` pattern. A future "total" rule banning all fresh `.values()`
literals could route them through `projectInsert` too, but that's a much larger
mandate and is deferred.

---

## Part 3 — Migration (the dangerous handler sites)

Migrate handlers that build an object from `body` (the Lint-A targets). Each
becomes `projectInsert`/`project` or pass-through:

| Site | Shape | Action |
|---|---|---|
| `agents/server/internal/handle-create.ts` | body→values, restated | `projectInsert(_agents, body, …)` — **primary** |
| `page/plugins/editor/server/internal/handle-create-block.ts` | body→values | `projectInsert(_blocks, body, …)` + server id/pageId/rank |
| `apps/plugins/deploy/plugins/servers/server/internal/handle-create.ts` | body→values, `sshPrivateKey` excluded | `projectInsert(…)` with `sshPrivateKey: DROP` — **DROP showcase** |
| `apps/plugins/sonata/plugins/track-mixer/server/internal/routes.ts` (upsert view) | body→values | `projectInsert(…)` (insert arm; `set` accumulator stays) |
| `active-data/server/internal/routes.ts` (put binding) | body→values (1 field) | `projectInsert(…)`; trivial but consistent |
| `notifications/server/internal/handle-create.ts` | body→`RecordNotificationInput`, rename `dedupeKey→dedupKey` | `project(body, { dedupeKey: { to: "dedupKey" }, … })` |
| `conversations/server/internal/handle-create.ts` | body→`createConversation` arg, rename `runtime→runtimeId` | `project(body, { runtime: { to: "runtimeId" }, … })` |
| `apps/plugins/sonata/.../sources/{chord-grid,midi}/server/internal/routes.ts` | body split across 2 writes | one `project`/`projectInsert` per write; other half `DROP` (makes the split explicit) |
| `apps/plugins/workflows/plugins/engine/server/internal/routes.ts` | body→`createDefinition` arg | `project(body, …)` (confirm source is a closed type, not `Record`) |

**Leave as-is (do not churn):** `crashes/record-crash.ts` (already safe via
spread+rest; optional showcase only), `tasks-core` repo mutations (intended
typed-DTO pattern, out of Lint-A scope), `tasks/handle-create` &
`handle-create-chain` (genuine orchestration, not a field re-map), all PATCH
accumulators.

---

## Critical files

- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts` — reference for `InferInsertModel<T>` typing, server-only barrel, drizzle conventions.
- `plugins/primitives/plugins/data-table/lint/{no-class-as-grid-width.ts,index.ts}` — template for the type-aware rule + `lint/index.ts` barrel.
- `plugins/infra/plugins/endpoints/core/{define-endpoint,implement}.ts` — confirms `body` inside a handler is exactly `z.infer<typeof schema>`.
- Migration targets: the table in Part 3.

## Implementation order

1. Scaffold `db-project` plugin: `server/internal/project.ts` (+ types), `server/index.ts` barrel.
2. Add the compile-fail type-test asserting an incomplete spec errors (guards `-?`).
3. Migrate `agents/handle-create` + `crashes/record-crash` (showcase) → `./equin build`, confirm typecheck.
4. Add the `no-manual-body-mapping` lint rule + `lint/index.ts`; run `./equin check eslint` — it should now flag the *un-migrated* sites.
5. Migrate the remaining Part-3 sites until `eslint` is green.
6. Write `db-project/CLAUDE.md` (API, the three limits, when to use `project` vs `projectInsert`).

## Verification

1. **Exhaustiveness is real:** in a scratch edit, add a field to `CreateAgentBodySchema` without touching the `projectInsert` spec → `./equin build` must fail with `Property '<field>' is missing` pointing at the spec. Revert.
2. **`-?` type-test:** the committed compile-fail test fails to compile if `-?` is removed.
3. **Lint enforces use:** with the rule active, re-introduce a hand-mapped `db.insert(_agents).values({ name: body.name })` → `./equin check eslint` flags `db-project/no-manual-body-mapping`.
4. **Behavior unchanged end-to-end:** `POST /api/agents` with all fields, then
   `query_db: SELECT * FROM agents ORDER BY ... LIMIT 1` — every field persists
   (re-runs the original defect check, now for agents). Repeat the crashes
   `clientId`/`buildId` DB check from the prior fix to confirm no regression.
5. `./equin check` fully green (`migrations-in-sync` no-op — no schema
   change; `eslint`; `plugin-boundaries` — db-project is server-only, one barrel).
