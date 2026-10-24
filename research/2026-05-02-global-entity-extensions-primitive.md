# entity-extensions primitive + migrate auto_launch off _agents

## Context

Sub-plugins frequently want to attach typed DB state to a parent plugin's entity (e.g. `auto_launch` on agents, future toggles, settings, soft-deletion flags). Today the only path is to add the column directly to the parent's table — `auto_launch` lives on `_agents` (`plugins/agents/server/internal/tables.ts:32`), surfaces in `AgentSchema` (`plugins/agents/shared/schemas.ts:18`), and is wired through the parent's generic PATCH handler (`plugins/agents/server/internal/handle-update.ts:24,46`). That backwards-couples the parent to the feature: the parent's table and shared schema must change every time a sub-plugin wants a field.

The plugin model claims every feature should be self-contained; this is the one place it's not. The fix: a small infra primitive that lets a sub-plugin own its own side-table keyed by the parent's PK, with no parent-side change.

The migration of `auto_launch` is the proof-of-concept. It's the cleanest possible test case — column was added today (commit `8f586a22`), defaults to `false`, has no server consumers, and only one UI consumer (the toggle component).

## Design

### Primitive: `plugins/infra/plugins/entity-extensions/`

Mirrors the shape of `plugins/infra/plugins/attachments/`: server-only infra plugin, module-load registry, side-table factory.

**Public API (server):**

```ts
// plugins/infra/plugins/entity-extensions/server/index.ts
export const EntityExtensions = { defineExtension };

export function defineExtension<C extends Record<string, AnyPgColumn>>(
  parentTable: PgTable & { id: AnyPgColumn },
  name: string,
  columns: C,
): {
  table: PgTable;                                  // Drizzle table for queries
  get(parentId: string): Promise<Row | undefined>; // typed read by parent id
  upsert(parentId: string, patch: Partial<UserCols>): Promise<Row>; // ON CONFLICT DO UPDATE
};
```

**Behaviour:**

- Creates `<parent>_ext_<name>` (e.g. `agents_ext_auto_launch`) with:
  - `parent_id text PRIMARY KEY REFERENCES <parent>(id) ON DELETE CASCADE`
  - …user columns…
  - `created_at`, `updated_at` timestamps (auto)
- Pushes a `{ parentTable, name, table }` record onto a module-level `registrations[]` array (mirrors `linkSources` in `plugins/infra/plugins/attachments/server/internal/define-link.ts:18`). Exposed via `getRegisteredExtensions()` for future debug/introspection.
- `get` / `upsert` are typed closures over the specific table; `upsert`'s `patch` is narrowed to the user columns (excludes `parentId`/timestamps). This is the single ergonomic reason for bundling helpers vs. mirroring `defineLink` exactly.
- v1 hardcodes `text` PK type — every entity table in this repo uses `text("id")`. Generalize when a numeric-PK consumer appears.

**No HTTP endpoint and no read-side join helper in the primitive.** Each consumer plugin owns its own route and its own live-state resource. Consumer UI subscribes to two resources (parent + extension) and composes client-side. TanStack Query dedups across components; the WebSocket is shared. Fine through ~10 extensions per parent.

**Migration discovery is automatic.** `server/drizzle.config.ts:18-23` globs `plugins/**/server/**/internal/{tables,tables-*,schema,schema-*}.ts`. The new plugin's `server/internal/tables.ts` and the consumer's new `tables.ts` are picked up without any central registration.

**Files for the new primitive:**

```
plugins/infra/plugins/entity-extensions/
├── CLAUDE.md                                    # short reference doc
├── package.json                                 # @singularity/plugin-infra-entity-extensions
└── server/
    ├── index.ts                                 # named exports + default ServerPluginDefinition
    └── internal/
        └── define-extension.ts                  # the primitive
```

The plugin has no DB tables of its own. `tables.ts` is intentionally absent — the side-tables are owned by consumers.

### Consumer: `plugins/agents/plugins/auto-launch/plugins/toggle/`

Currently web-only. Gains a server side that owns the side-table end-to-end.

**New files:**

```
plugins/agents/plugins/auto-launch/plugins/toggle/server/
├── index.ts                                     # ServerPluginDefinition + route
└── internal/
    ├── tables.ts                                # defineExtension(_agents, "auto_launch", {...})
    └── resource.ts                              # agentAutoLaunchResource (mode: push)
```

**Side table** (`server/internal/tables.ts`):

```ts
import { boolean } from "drizzle-orm/pg-core";
import { _agents } from "@plugins/agents/server";
import { EntityExtensions } from "@plugins/infra/plugins/entity-extensions/server";

export const agentAutoLaunchExt = EntityExtensions.defineExtension(_agents, "auto_launch", {
  enabled: boolean("enabled").notNull().default(false),
});
```

→ creates `agents_ext_auto_launch(parent_id text PK FK CASCADE, enabled bool NOT NULL DEFAULT false, created_at, updated_at)`.

**Resource** (`server/internal/resource.ts`):

`mode: "push"` returning `Array<{ parentId: string; enabled: boolean }>`. The full list (cardinality matches `_agents`) is fine to push — same shape as `agentsResource`.

**Route** (in `server/index.ts`):

`POST /api/agent-auto-launch/:agentId` with body `{ enabled: boolean }` → calls `agentAutoLaunchExt.upsert(agentId, { enabled })` → calls `agentAutoLaunchResource.notify()`. No GET — clients read via the resource.

**Web changes** (`web/components/auto-launch-toggle.tsx`):

- Read from a new `agentAutoLaunchResource` exposed in the toggle plugin's web barrel, not from `agentsResource`. The component receives `agentId`, looks up its own row, falls back to `enabled = false`.
- Write to `/api/agent-auto-launch/${agentId}` with `{ enabled }`.

The component no longer imports `agentsResource` — its only dependency is on its own sub-plugin's resource.

### Parent (`plugins/agents/`) — what's removed

| File | Change |
|---|---|
| `plugins/agents/server/internal/tables.ts:32` | Remove `autoLaunch: boolean(...)` line |
| `plugins/agents/shared/schemas.ts:18` | Remove `autoLaunch: z.boolean()` line |
| `plugins/agents/server/internal/handle-update.ts:24,46` | Remove `autoLaunch?` body type field and the patch mapping |

`plugins/agents/server/internal/schema.ts:20-27` (the `agents_v` view) doesn't need editing — it's built from `getTableColumns(_agents)` and rebuilds automatically when the column is dropped.

`agentsResource` and the read handlers (`handle-list.ts`, `handle-get.ts`, `handle-create.ts`) don't change — they `select().from(agents)` and the view auto-omits the dropped column.

## Migration (DB)

Decision: **drop the column, accept loss of any existing `auto_launch=true` rows in this worktree DB.** Column was added today, defaults to `false`, no production. Documented as a known consequence.

`./equin build` will emit a single migration containing:

1. `DROP VIEW agents_v` (must come before the column drop)
2. `ALTER TABLE agents DROP COLUMN auto_launch`
3. `CREATE TABLE agents_ext_auto_launch (...)` with FK to `agents(id) ON DELETE CASCADE`
4. `CREATE VIEW agents_v` (rebuilt without `auto_launch`)

No hand-editing required. (For future migrations that *do* need backfill: hand-edit the generated SQL to reorder as `CREATE TABLE → INSERT … SELECT → DROP COLUMN`. Documenting the pattern in the new plugin's `CLAUDE.md` for reference.)

## File-by-file change list

**New (primitive plugin):**
- `plugins/infra/plugins/entity-extensions/CLAUDE.md`
- `plugins/infra/plugins/entity-extensions/package.json`
- `plugins/infra/plugins/entity-extensions/server/index.ts`
- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`

**New (consumer server side):**
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/index.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts`
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/resource.ts`

**Edit (consumer):**
- `plugins/agents/plugins/auto-launch/plugins/toggle/package.json` — add `server` entrypoint
- `plugins/agents/plugins/auto-launch/plugins/toggle/web/index.ts` — export `agentAutoLaunchResource` (re-export from the new web barrel)
- `plugins/agents/plugins/auto-launch/plugins/toggle/web/components/auto-launch-toggle.tsx` — read from new resource, POST to new route
- `plugins/agents/plugins/auto-launch/plugins/toggle/CLAUDE.md` — drop "Placeholder — wiring TBD" line

(If the toggle plugin doesn't already have a `web/index.ts` re-export pattern for resources, the new web file lives at `web/resource.ts` and is exported from `web/index.ts`.)

**Edit (parent plugin):**
- `plugins/agents/server/internal/tables.ts:32` — remove `autoLaunch` column
- `plugins/agents/shared/schemas.ts:18` — remove `autoLaunch` field from zod schema
- `plugins/agents/server/internal/handle-update.ts:24,46` — remove body field + patch mapping

**Edit (registry):**
- `server/src/plugins.ts` — register both new plugins (entity-extensions infra, toggle server)
- `web/src/plugins.generated.ts` is auto-generated by build; no manual edit

**Generated (DB):**
- `server/src/db/migrations/2026MMDD_HHMMSS_<hash>__<name>.sql` — emitted by `./equin build`
- `server/src/db/migrations/meta/_journal.json` — appended
- `server/src/db/migrations/meta/<id>_snapshot.json` — emitted

## Critical files referenced

- `plugins/infra/plugins/attachments/server/internal/define-link.ts` — the pattern being mirrored
- `plugins/infra/plugins/attachments/server/index.ts` — barrel shape to copy
- `server/drizzle.config.ts:18-23` — table-discovery globs (no edit needed, but central to the design)
- `plugins/agents/server/internal/tables.ts:32` — current home of `auto_launch`
- `plugins/agents/shared/schemas.ts:18` — current zod field
- `plugins/agents/server/internal/handle-update.ts:24,46` — generic patch wiring
- `plugins/agents/server/internal/schema.ts:20-27` — `agents_v` view (auto-rebuilds)
- `plugins/agents/plugins/auto-launch/plugins/toggle/web/components/auto-launch-toggle.tsx` — UI to switch over
- `server/src/plugins.ts` — sub-plugin registration site

## Verification

End-to-end, after `./equin build`:

1. Build emits a single migration; server restart applies it; `agents_ext_auto_launch` table exists, `auto_launch` column on `agents` is gone.
2. Open `http://<worktree>.localhost:9000/agents`. Toggle the rocket icon on at least one agent → it should turn blue.
3. Refresh the page → the toggle persists.
4. Inspect DB: `SELECT * FROM agents_ext_auto_launch` shows the row(s).
5. Toggle off → row updated (or removed; current design upserts so the row stays with `enabled=false`). Refresh → state persists.
6. Delete an agent that has an extension row → the row is gone (FK CASCADE).
7. `./equin check --plugin-boundaries` passes — confirms cross-plugin imports stay legal (`@plugins/infra/plugins/entity-extensions/server` from the toggle, `@plugins/agents/server` from the toggle for `_agents`).
8. `./equin check` passes the migrations-in-sync check (no uncommitted schema diffs).
9. Check no other consumers were missed: `rg -n 'autoLaunch|auto_launch'` should return only the new toggle plugin's files plus the new migration SQL.

If steps 2–5 all succeed and the checks pass, the primitive is proven and the auto-launch migration is complete.
