# Stage 1 — the self-contained `zero` plugin (single-DB, opt-in)

> Status: **IMPLEMENTED & PROVEN (2026-06-24).** See [Outcome](#outcome-executed-2026-06-24) at the bottom.
> Stage 1 of the Zero adoption roadmap in
> [`2026-06-23-global-adopt-zero-sync-engine.md`](./2026-06-23-global-adopt-zero-sync-engine.md).
> Builds on the Stage 0 spike findings in
> [`2026-06-23-database-zero-spike-single-db.md`](./2026-06-23-database-zero-spike-single-db.md).

## Context

We hand-rolled a sync engine (`live-state` change-feed + IVM + delta-sync + optimistic
mutations) and keep fighting subtle correctness bugs in it. The roadmap replaces it with
Rocicorp Zero. Stage 0 proved the load-bearing mechanic: `zero-cache` + Postgres logical
replication runs against our embedded cluster end-to-end on the server side. It left exactly
one thing unproven — the browser `useQuery` never pushed its desired query, so rows never
rendered — and surfaced concrete surprises (rank_text unsupported, Node-only sidecar,
`ANYONE_CAN_DO_ANYTHING` permission grant, slot-blocks-fork-teardown).

Stage 1 stands up the **real plugin home** so the work has somewhere to live and call sites
have a migration seam, while changing nothing in the legacy stack. The deliverables:

1. the **Zero schema** (the shared contract),
2. the **zero-cache service registration** (a supervised process, opt-in, against the main DB only),
3. the **client provider** (a configured `<ZeroProvider>`),
4. a **`useResource`-shaped adapter** (`useZeroResource`) so call sites migrate with minimal churn.

Everything is single-DB, no worktree integration, fully opt-in (default off). The make-or-break
of Stage 1 is resolving the unproven last mile: **one table slice rendering live through the adapter.**

## Decisions (locked with the user)

- **Launch model:** a *gated supervised service* — build the real `zeroCacheService()` descriptor +
  `scripts/start.ts`, register it in `database.json` against the **main `singularity` DB only**,
  behind a default-off opt-in env switch. Not a manual sidecar.
- **Adapter shape:** `useZeroResource(query)` — embrace client-side ZQL; the hook takes a ZQL query
  and returns the existing `ResourceResult<T>` union. Not a `useResource(descriptor, params)` wrapper.
- **Schema:** hand-author the pilot slice now. Deriving it from Drizzle (`drizzle-zero`) is a filed
  follow-up (single source of truth), not Stage 1.
- **rank:** out of scope; the pilot avoids ordered lists. The exact cause / affected-types / clean
  solution is a filed follow-up.
- **Infra vs. consumer boundary:** `plugins/database/plugins/zero/` holds the **Zero infrastructure
  only** — generic, domain-agnostic, never a concrete schema or a consuming surface (exactly like the
  `live-state` primitive). The infra provider + adapter are **schema-parameterized**. The actual pilot
  schema (mapping `tasks`) and the render pane are a **consumer** of the infra and live in a
  **temporary `plugins/debug/plugins/zero-test/` plugin**, deleted once a real migration begins.
- **Pilot/visualization surface:** the polished side-by-side (Zero vs live-state) comparison is a
  filed follow-up. Stage 1 ships only the **temporary `zero-test` debug pane** as the verification
  harness (you cannot prove the adapter without rendering something).

### Follow-up tasks filed (sit between Stage 2 and Stage 3 in the roadmap chain)

- `task-1782244493333-yi8zk0` — Generate the Zero schema from Drizzle (single source of truth).
- `task-1782244515901-r5gjoe` — Zero silently drops rank_text and other unsupported column types
  (cause, full affected list, clean solution; may merge with the drizzle-zero task).
- `task-1782244520767-mv2jh7` — Side-by-side visualization: Zero vs live-state on the same data.

## Plugin home + sub-plugin split

The governing principle: `plugins/database/plugins/zero/` is the **Zero infrastructure primitive** —
generic and domain-agnostic, exactly like `live-state`. It never contains a concrete schema or a
consuming surface. The concrete pilot schema (mapping `tasks`) and the render pane are a **consumer**
and live in a **temporary `plugins/debug/plugins/zero-test/`** plugin. This mirrors the live-state
precedent precisely: the `live-state` primitive is generic; the concrete `tasks` resource lives in the
`tasks` plugin.

### Infrastructure — `plugins/database/plugins/zero/` (umbrella, thin container)

| Part | Runtime | Owns |
|---|---|---|
| `core` | `core` | Infra-wide constants — `ZERO_CACHE_PORT` (the umbrella core, like `database/core`), shared by `client` (cache URL) and `cache-service` (`ZERO_PORT`). |
| **`cache-service`** | `server` + `scripts/start.ts` | The `zeroCacheService()` descriptor, the start script that spawns `zero-cache` (Node) against the main DB, and the upstream-DB / replica-file constants. Schema-agnostic — zero-cache replicates the DB regardless of any client schema. |
| **`client`** | `web` | The generic schema-parameterized `<ZeroRoot schema={…}>` provider wrapper (wires the cache URL), the `useZeroResource(query)` adapter, and a raw `useZeroQuery` re-export. No concrete schema. |

`client → live-state/web` for the `ResourceResult` type + readiness helpers (consuming, not touching,
legacy). The infra never imports a consumer.

### Consumer — `plugins/debug/plugins/zero-test/` (temporary, deleted post-migration)

| Part | Runtime | Owns |
|---|---|---|
| `core/schema.ts` | `core` | The actual pilot Zero schema (`createSchema`/`createBuilder` over raw `tasks` columns, **no `rank`**), the `zql` builder, and `ANYONE_CAN_DO_ANYTHING` permissions. The domain content. |
| `web/` | `web` | The Debug pane: mounts `<ZeroRoot schema={schema}>` (from the infra `client`) and renders `useZeroResource(zql.task…)`. The verification harness. |

Dependency direction: `debug/zero-test → database/zero/{core,client}` (consumer → infra) — DAG-clean.

## Implementation

### A. Infra: `core` (`plugins/database/plugins/zero/core/`)

- `core/constants.ts` — `export const ZERO_CACHE_PORT = 4848;`
- `core/index.ts` — barrel re-exporting `ZERO_CACHE_PORT`. No `@rocicorp/zero` dependency here (pure constant).

### B. `cache-service` sub-plugin (`plugins/database/plugins/zero/plugins/cache-service/`)

Mirror `plugins/database/plugins/pgbouncer/scripts/start.ts` byte-for-byte in shape.

- `shared/internal/paths.ts` — `ZERO_REPLICA_FILE = join(SINGULARITY_DIR, "zero", "replica.db")`,
  and the upstream DSN `postgresql://singularity@127.0.0.1:5433/singularity` (direct TCP — **not**
  PgBouncer 6432, **not** the unix socket; `127.0.0.1` not `localhost`; no `?schema=public`).
- `scripts/start.ts` (`#!/usr/bin/env bun`) — resolves the `zero-cache` binary from
  `node_modules/@rocicorp/zero` and **spawns it under Node** (zero-cache cannot run under Bun;
  needs Node 22/24, not 25), passing env `ZERO_UPSTREAM_DB`, `ZERO_REPLICA_FILE`,
  `ZERO_PORT=ZERO_CACHE_PORT`. Idempotent reattach (ping the TCP port first, like pgbouncer pings
  its socket). **New ground:** there is no existing Node-spawn precedent in the repo — the start
  script must locate a Node 22/24 runtime (resolve `node` on PATH; fail loud with a clear message if
  absent or wrong major). This host-Node dependency is a Stage-1 risk (see Risks).
- `server/index.ts` — re-export the upstream DSN and replica-path constants for `boot.ts` / the start
  script (mirrors how `embedded`/`pgbouncer` export their constants); `ZERO_CACHE_PORT` comes from
  `@plugins/database/plugins/zero/core`.
- `package.json` — declares `@rocicorp/zero` (so its native binary lands in this plugin's `node_modules`).

**Registration into `database.json`** — in `plugins/infra/plugins/launcher/server/internal/boot.ts`,
add three helpers next to the pgbouncer trio (`pgbouncerService` / `pgbouncerConnection` /
`hasPgBouncerPackage`):

```ts
function zeroCacheEnabled(): boolean {
  return process.env.SINGULARITY_ZERO_CACHE === "1";   // explicit opt-in, default OFF
}
function zeroCacheService(repoRoot: string) {
  return {
    name: "zero-cache",
    start: ["bun", "run", join(repoRoot, "plugins/database/plugins/zero/plugins/cache-service/scripts/start.ts")],
    ready: { tcp: `127.0.0.1:${ZERO_CACHE_PORT}` },   // supervisor.go supports the tcp probe
    watchdog: { intervalSec: 2 },
  };
}
```

Wire it into BOTH branches of `ensureDatabaseConfig` (the upgrade path that appends to an existing
`services[]`, and the fresh-create path), gated on `zeroCacheEnabled()`:
```ts
...(zeroCacheEnabled() ? [zeroCacheService(repoRoot)] : [])
```

**Why an env switch, not package-presence:** we must commit `@rocicorp/zero` for the client bundle to
build, so the pgbouncer-style `hasPgBouncerPackage` gate would always be true → zero-cache would
auto-start for everyone on merge, violating "opt-in, nothing changes for others." `SINGULARITY_ZERO_CACHE`
defaults off ⇒ `ensureDatabaseConfig` writes the exact same `database.json` it does today; zero churn.

> Boundary note: `boot.ts` already names `embedded`/`pgbouncer` explicitly (not a generic collection
> API), so naming `zero-cache` here follows precedent. The growing "launcher hard-codes each DB
> service" pattern is a candidate for a generic service-contribution slot later — out of scope for
> Stage 1; flagged so it gets fixed structurally rather than memorized.

### C. Infra: `client` sub-plugin (`plugins/database/plugins/zero/plugins/client/`)

Generic and schema-parameterized — no concrete schema, no panes.

- `web/zero-root.tsx` — the configured provider wrapper, schema passed by the consumer:
  ```tsx
  import { ZeroProvider } from "@rocicorp/zero/react";
  import type { Schema } from "@rocicorp/zero";
  import { ZERO_CACHE_PORT } from "@plugins/database/plugins/zero/core";
  export function ZeroRoot({ schema, children }: { schema: Schema; children: ReactNode }) {
    return <ZeroProvider server={`http://localhost:${ZERO_CACHE_PORT}`} schema={schema} userID="anon">{children}</ZeroProvider>;
  }
  ```
  (Mounted locally by consumers — `Core.Root` renders siblings, not wrappers, so there is no global
  mount and it is opt-in by construction. Confirmed in `App.tsx`.)
- `web/use-zero-resource.ts` — the adapter (the core deliverable), fully generic over a ZQL query:
  ```ts
  import { useQuery } from "@rocicorp/zero/react";
  import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
  export function useZeroResource<T>(query: ZeroQuery<T>): ResourceResult<T[]> {
    const [rows, result] = useQuery(query);
    const refetch = () => Promise.resolve();          // Zero is always-live; no-op
    return result.type === "unknown"
      ? { pending: true, error: null, refetch }
      : { pending: false, data: rows, error: null, refetch };
  }
  ```
  Returning the exact `ResourceResult` union means it drops straight into the existing
  `ResourceView` / `matchResource` / `useCombinedResources` helpers (they accept any
  `ResourceResult`-shaped value). `useZeroQuery` is a thin re-export of Zero's `useQuery` for callers
  who want the raw `[rows, result]` tuple.
- `web/index.ts` — barrel exporting `ZeroRoot`, `useZeroResource`, `useZeroQuery`.
- `package.json` — declares `@rocicorp/zero`.

### D. Consumer: temporary `zero-test` plugin (`plugins/debug/plugins/zero-test/`)

The only place that knows about a concrete table. Deleted once a real migration begins.

- `core/schema.ts` — hand-authored Zero schema for the pilot slice (raw `tasks` columns, **no `rank`**):
  ```ts
  import { createSchema, createBuilder, table, string, number } from "@rocicorp/zero";
  const task = table("task").from("tasks").columns({
    id: string(),
    title: string(),
    updatedAt: number().from("updated_at"),
  }).primaryKey("id");
  export const schema = createSchema({ tables: [task], relationships: [] });
  export const zql = createBuilder(schema);
  export type Schema = typeof schema;
  ```
  Permissions: `ANYONE_CAN_DO_ANYTHING` on `task` (read-only Stage 1). **Not** `ANYONE_CAN` (Stage 0
  footgun #3: it silently compiles to deny). Deployed against the running zero-cache via
  `zero-deploy-permissions` if the sidecar demands it (a consumer step — see verification).
- `web/panes.tsx` + `web/index.ts` — the **Debug → Zero Test pane** (verification harness):
  `Pane.define` a body that renders `<ZeroRoot schema={schema}>` (from the infra `client`) around a
  list driven by `useZeroResource(zql.task.orderBy("updatedAt","desc").limit(50))`, contributed via
  `Pane.Register({ pane })` + `DebugApp.Sidebar({ id, ...sidebarNavItem({...}) })`
  (slot `"debug-app.sidebar"`, `DebugApp` from `@plugins/apps/plugins/debug/plugins/shell/web`).
- `package.json` — declares `@rocicorp/zero`; depends on the infra `client`.

### E. Resolve the unproven last mile (the make-or-break)

Stage 0's pane mounted but stayed `status: unknown · 0 rows` — the client never sent a
`changeDesiredQueries` frame. Most-likely causes (from the spike): a vite tree-shake of Zero's
binding side-effects (`import "@rocicorp/zero/.../bindings.js"`) or a 1.6.x provider/query-builder
wiring nuance. First implementation milestone, before any polish: get the single `task` slice
rendering live on the debug pane. Tactics: confirm the WS sends `changeDesiredQueries` (devtools),
add the explicit bindings import if tree-shaken, verify `ZeroProvider` props against the installed
version's types, and confirm permissions are `ANYONE_CAN_DO_ANYTHING`. **If this cannot be resolved,
Stage 1 stops here and reports** — the adapter is meaningless without it (per the "STOP on unexpected
failures" rule).

## Critical files

- New (infra): `plugins/database/plugins/zero/` umbrella — `core/` + `cache-service/` + `client/`.
- New (consumer, temporary): `plugins/debug/plugins/zero-test/` — `core/schema.ts` + `web/`.
- Modify: `plugins/infra/plugins/launcher/server/internal/boot.ts` — add `zeroCacheService()` +
  `zeroCacheEnabled()` and wire both `ensureDatabaseConfig` branches.
- Modify: root `package.json` (`trustedDependencies`) and `./equin` (the native-ABI pin) — see
  the Outcome section's supervised-boot fixes.
- Reference (do not modify): `plugins/database/plugins/pgbouncer/scripts/start.ts` (start-script
  template), `plugins/database/core/internal/config.ts` (`DatabaseConfig.services[]` shape +
  `DATABASE_CONFIG_PATH`), `gateway/supervisor.go` (`tcp` ready-probe), `plugins/debug/plugins/logs/web/`
  (debug-pane template), `plugins/primitives/plugins/live-state/web/use-resource.ts`
  (`ResourceResult<T>` definition), `plugins/framework/plugins/web-core/web/App.tsx` (provider tree).

## Risks / constraints carried from Stage 0

- **Host Node 22/24 required** for the sidecar (no Bun, not Node 25; `"type":"module"` workaround for
  the tsx tooling). New ground — no Node-spawn precedent in the repo. The start script must locate a
  compatible Node and fail loud otherwise.
- **`rank_text` silently dropped** ⇒ no client-side ordered lists. Pilot uses `tasks.updatedAt`, not
  `rank`. (Filed follow-up.)
- **Single-DB on `main` sidesteps the slot-blocks-fork-teardown footgun** (Stage 0 #6) — the slot lives
  on `singularity`, which is never dropped. Per-worktree slot lifecycle is Stage 2.
- **Permissions deprecated** — `ANYONE_CAN_DO_ANYTHING` is fine for read-only Stage 1; the
  mutator/permission/auth-JWT model is Stage 3.
- **Cross-origin client** to `http://localhost:4848` is acceptable for Stage 1 (Stage 0 proved the WS
  handshake). Routing through the per-subdomain gateway proxy is Stage 2.

## Verification (end-to-end)

1. Add `@rocicorp/zero` to the `cache-service`, `client`, and `zero-test` `package.json`s;
   `./equin build` (confirms bun builds the native `zero-sqlite3` and vite bundles
   `@rocicorp/zero/react`, both proven in Stage 0).
2. With `SINGULARITY_ZERO_CACHE` **unset**: confirm `database.json` is byte-identical to before (no
   `zero-cache` service) and the existing live-state app is unaffected — proves default-off opt-in.
3. Enable it (set `SINGULARITY_ZERO_CACHE=1`, relaunch the gateway so `ensureDatabaseConfig` re-runs
   and the supervisor starts the service): confirm zero-cache logs slot creation + initial COPY, and
   the supervisor reports the `zero-cache` service ready via the tcp probe.
4. Open Debug → Zero Test pane at `http://<worktree>.localhost:9000`. The `task` list must render rows.
5. Mutate `tasks` (via the app UI or `add_task`; `psql` is guarded for agents) and confirm the pane
   updates **live** — devtools shows the WS to `localhost:4848`, never `/ws/notifications`, and the
   client sends a `changeDesiredQueries` frame (the Stage-0 gap, now closed).
6. Grep the `zero-test` pane: only `useZeroResource` / `@rocicorp/zero/react`, never `useResource`.

## Out of scope (later stages / filed follow-ups)

Per-worktree fork × zero-cache topology and gateway-proxy routing (Stage 2); custom mutators / write
path / auth (Stage 3); drizzle-zero schema generation, the rank_text fix, and the side-by-side
comparison viz (filed follow-ups); touching or deleting any live-state code (Stage 5).

---

## Outcome (executed 2026-06-24)

**Verdict: PROVEN.** The Zero Test pane renders `tasks` rows live through `useZeroResource`, data
sourced from zero-cache (no live-state behind it); a write to the main DB reflects in the pane within
a frame (write → Postgres logical replication → zero-cache → WS poke → re-render). `@rocicorp/zero`
**1.6.2**, Node **24.17.0** (installed via `brew install node@24`, kept off the global symlink),
`./equin build` + `./equin check` green.

### The Stage-0 "0 rows" mystery, solved (the headline finding)
Zero 1.6.2 gates **builder/ZQL queries** (anything built via `createBuilder(schema)` — i.e. `zql.task…`)
behind `schema.enableLegacyQueries`, which **defaults to `false`**. With it off, the client connects,
receives empty pokes, and **never registers its desired query** → 0 rows, forever, with no error. This
was the entire unproven last mile. **Fix:** `enableLegacyQueries: true` in `createSchema({...})`. Also:
the desired query is folded into the v51 `initConnection` message, not a standalone
`changeDesiredQueries` frame — so grepping for that frame name (as Stage 0 did) is a false-negative trap.

### Supervised-boot fixes (the start.ts deliverable couldn't boot as first written)
1. **Native `@rocicorp/zero-sqlite3` wasn't built / built for the wrong ABI** — two layers:
   (a) bun skips untrusted lifecycle scripts, so the binary was absent ("Could not locate the
   bindings file") → **fix:** `"trustedDependencies": ["@rocicorp/zero-sqlite3"]` in the **root
   `package.json`**. (b) `trustedDependencies` alone still built the **wrong ABI**: bun runs
   lifecycle scripts with the host `node` (Node 25, `NODE_MODULE_VERSION` 141), but zero-cache runs
   under Node 24 (137) → `ERR_DLOPEN_FAILED` crashing every worker. → **fix:** pin the prebuild ABI
   at the single `bun install` call site (the `./equin` entrypoint):
   `export npm_config_runtime=node; export npm_config_target=24.17.0` (prebuild-install reads these;
   bun ignores `.npmrc` `target`/`runtime`). Any 24.x target yields ABI 137.
   **⚠️ Footgun (Stage-2 refinement):** this env-pin is *global* to the whole repo's `bun install`,
   so any future `NODE_MODULE_VERSION`-based native dep that bun itself loads at runtime would be
   mis-targeted to Node 24. N-API modules (e.g. `@parcel/watcher`) are ABI-stable and unaffected
   (verified: the app boots with its load-bearing watchers). Scope the pin to just the zero-sqlite3
   build rather than the whole install.
2. **zero-cache launched in production mode** → "missing --admin-password: required in production
   mode". **Fix:** `start.ts` sets `NODE_ENV: "development"` in the spawn env (Stage-0-proven
   single-DB dev path; production hardening / admin-password deferred to Stage 2).

### Open items for Stage 2 (carry forward)
- **Gateway-supervised end-to-end not exercised.** Verified at the config level (opt-in writes the
  service entry) and `start.ts` boots zero-cache standalone, but full gateway supervision needs a
  gateway restart (guarded) + per-subdomain WS/HTTP routing — Stage 2.
- **Permission deployment tooling friction.** `zero-deploy-permissions` hits the Stage-0 tsx
  `?namespace` `ERR_MODULE_NOT_FOUND` against the in-repo schema; deployed via a clean `"type":"module"`
  Node-24 harness. A first-class in-repo permission-deploy path is needed (and the declarative
  permission API is deprecated — see Stage 3 auth/mutator model).
- **Leftover state from verification:** a logical replication slot `zero_0_a` (+ publications
  `_zero_public_0`/`_zero_metadata_0`, schemas `zero`/`zero_0`) lives on the **main `singularity`** DB;
  drop it if zero-cache is stopped permanently (won't block fork teardown — slot is on `singularity`).
  Two marker tasks (`ZERO-LIVE-PROBE-9q`, `ZERO-LIVE-WATCH-7k`) on the main DB need UI deletion
  (`add_task` writes to main, not the worktree fork; no delete tool).
- **Host Node 22/24 is a hard runtime dependency** for the sidecar.
