# Eliminate the concurrent-import TDZ class from the central & web loaders

**Date:** 2026-07-17
**Category:** global (framework: server-core, central-core, web-sdk, new plugin-loader leaf)
**Status:** proposed

## Context

A latent boot bug was recently fixed in the **server** plugin loader. Class of bug:
when a barrel and a module that imports it are imported **concurrently** (a flat
`Promise.allSettled` over every plugin loader), under **Bun's** module loader the
dependent can begin evaluating while the barrel is suspended mid-re-export at an
async boundary, and observe the barrel's not-yet-initialized `const` exports as a
TDZ `ReferenceError`. Whether a given cross-plugin import survives depends purely
on the exported symbol's line position in the barrel; hoisted `function` exports
are immune, `const` exports are not. It is **not** a plugin cycle — the boundary
checker correctly sees none.

This was hit for real: 7 page block-type server plugins (all reading a late-declared
`const textDataSchema`) failed to import at boot, and the failure was **silently
swallowed**, leaving a green server whose Pages editor 400'd on every text-block write.

The server boot path (`plugins/framework/plugins/server-core/bin/index.ts`) was
fixed: it loads in **topological waves** over `dependsOn`, **warms each wave's
`core` barrels before its `server` barrels**, and treats plugin load failure as
**fatal**. The two remaining plugin loaders — **central** and **web** — were never
audited. This plan closes the class on both, at the source.

### Audit result (why each runtime is / isn't exposed)

- **Central (`central-core/bin/index.ts`) — EXPOSED.** Runs under Bun from source
  (the gateway eagerly spawns it via the same backend-spawn path as worktree
  servers; there is no `--compile`). It does a flat `Promise.allSettled` over all
  `centralEntries` — the *exact* pre-fix server pattern — and its plugin barrels
  import cross-plugin `@plugins/*/core` **barrel indexes** (e.g.
  `plugins/infra/plugins/secrets/central/index.ts` re-exports from
  `@plugins/infra/plugins/secrets/core`). It also **swallows** load failures
  (`if (r.status === "rejected") { console.error(...); continue; }`), unlike the
  now-fatal server. The `dependsOn` graph is real: `infra/secrets` →
  `{auth, fields.secret.config}` → `{auth.google, auth.notion}` (the two leaves
  share a `core` dep and sit in the same final wave — the precise concurrent
  first-eval the warming step closes).

- **Web (`web-sdk/core/loader.ts` + `web-core/web/App.tsx`) — NOT exposed.** The
  same flat `Promise.allSettled` is used, but the production web path runs in the
  **browser** (native ESM via the import map in artifact mode) or a **single
  Rollup bundle** (release/monolith mode) — never Bun's loader. Browsers implement
  the spec's module-evaluation ordering (single module map, depth-first, async-module
  evaluation-promise machinery) which guarantees a dependency finishes evaluating
  before a dependent's body runs, *even with top-level await*. No web barrel uses
  top-level await (grep-confirmed). The bug is a **Bun-loader-specific** deviation,
  structurally absent in the browser. The class scoped here is the *concurrent-load
  ordering* race — not a genuine import-cycle live-binding TDZ (a different class,
  which the boundary checker confirms does not exist).
  → **Web needs no loader reorder.** Adding wave-loading would be dead complexity
  fighting the deliberate deferred-batch boot-perf design, buying nothing. The
  deliverable is a comment documenting *why* flat concurrent import is safe there,
  so nobody "fixes" it or copies the pattern into a Bun context, plus the existing
  smoke test as a loud canary.

## Decisions (confirmed with the user)

1. **Fix central** — mirror the server fix (approved despite host-wide blast radius).
2. **Extract a shared leaf** — dedup the now-three `topoSortPlugins` copies (server
   bin, central bin, web-sdk core) and the second `computeLoadWaves` copy into one
   pure framework leaf that all three composition points import.
3. **Web: document + keep the smoke canary** — no loader reorder.

## Implementation

### 1. New shared leaf: `plugins/framework/plugins/plugin-loader/`

A pure, dependency-free `core`-only leaf (mirror `framework/plugins/plugin-id` — no
`tsconfig.json` needed; the framework/server/web tsconfig `include` globs pick up
`*/core`). Contains the two graph functions, verbatim from the server's current
`bin/topo.ts` (keep the full jsdoc, incl. the Bun 1.3.x rationale on `computeLoadWaves`).

- `package.json` — `{ name: "@singularity/plugin-framework-plugin-loader", version, private, description }`. Description e.g. *"Pure plugin-graph algorithms: topological load-wave partitioning and dependsOn topo-sort, shared by the server/central/web plugin loaders."*
- `core/waves.ts` — `computeLoadWaves` (moved verbatim from `server-core/bin/topo.ts`).
- `core/topo.ts` — `topoSortPlugins` (moved verbatim).
- `core/index.ts` — barrel: `export { computeLoadWaves } from "./waves"; export { topoSortPlugins } from "./topo";` (barrel-purity-legal: only re-exports of own internal files).
- `core/waves.test.ts` — `bun:test`, co-located (NOT under `__tests__/`). Move the existing cases from `server-core/bin/topo.test.ts`, **add** a `topoSortPlugins` test (currently untested) and a central-graph wave assertion (`infra/secrets` wave 0; `auth` + `fields.secret.config` wave 1; `auth.google` + `auth.notion` wave 2).
- `CLAUDE.md` — auto-generated by `./equin build`.

Boundary legality: the leaf imports nothing (pure), so it is a DAG sink every
consumer may import. `bin/` composition roots importing a `core` barrel and
`core`→`core` cross-plugin imports are both ordinary-legal.

### 2. Rewire the three consumers to the leaf

- **`server-core/bin/index.ts`** (line 25): import `computeLoadWaves, topoSortPlugins`
  from `@plugins/framework/plugins/plugin-loader/core` instead of `./topo`.
  **Delete** `server-core/bin/topo.ts` and `server-core/bin/topo.test.ts` (moved to the leaf).
- **`web-sdk/core/context.tsx`** (line 2): import `topoSortPlugins` from the leaf.
  **`web-sdk/core/index.ts`** (line 10): **remove** `export { topoSortPlugins } from "./topo";`
  (zero external consumers — confirmed by grep; it drops from web-sdk's public API,
  which docgen regenerates). **Delete** `web-sdk/core/topo.ts`. (Keeping the public
  re-export would become a forbidden cross-plugin re-export once the source moves.)

### 3. Fix `central-core/bin/index.ts` (mirror the server fix)

> **Blast-radius note for the PR:** central is a single host-wide process. Making
> load failure fatal changes it from "serve degraded across all worktrees" to
> "crash until restart" — intended (a module that throws at import is broken), and
> only safe because the wave fix first removes the race that caused the spurious
> silent drops. This edit is **inert in the worktree**: it takes effect only after
> merge to `main` and a central restart.

Replace the flat load loop (current lines 8–32) with the wave loop, mirroring
`server-core/bin/index.ts:60–133`:

- New imports: `computeLoadWaves, topoSortPlugins` from the leaf; `PLUGINS_DIR` from
  `@plugins/infra/plugins/paths/core`; `existsSync` (`node:fs`); `join` (`node:path`).
- `const waves = computeLoadWaves(centralEntries);`
- `const hasCoreBarrel = (p) => existsSync(join(PLUGINS_DIR, p, "core", "index.ts"));`
  (keep the guard — it also correctly skips plugins that expose no `core/`.)
- For each wave: `await Promise.allSettled(wave.filter(hasCoreBarrel).map(e => import(\`@plugins/${e.pluginPath}/core\`)))`
  **before** loading that wave's central barrels; then
  `await Promise.allSettled(wave.map(e => e.loader()))`.
- Preserve verbatim, inside the per-wave inner loop: the `seenIds` duplicate guard,
  `byPath.set`, and `plugin.id = asPluginId(e.id)`.
- Collect all rejections into a `loadFailures[]` and, after all waves,
  **throw one aggregated error** if non-empty (replaces the `continue`-swallow).
- Everything below the load loop is **unchanged**: `dependsOn` wiring (lines 33–39),
  `topoSortPlugins`, the register phase, `onReady`, route population, `Bun.serve`.
- **Delete** `central-core/bin/topo.ts`.

### 4. Document the web loader's browser-safety invariant

In `web-sdk/core/loader.ts`, above the `Promise.allSettled` in `loadPlugins`, add a
comment: the flat concurrent import is safe **in the browser** because native ESM
guarantees spec-ordered module evaluation (a dependency is fully evaluated before a
dependent's body runs, even with TLA); the concurrent-import TDZ that forced the
server/central wave loaders is **Bun-loader-specific**; release/monolith is a single
bundle with no cross-artifact dynamic-import edge. Do **not** reorder into waves.
Reference `plugin-render.test.tsx` as the load-only canary that would fail loudly if
this ever regressed. (Scope the safety claim to the concurrent-load ordering class —
not genuine import cycles.)

## Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/plugin-loader/package.json` | **new** leaf manifest |
| `plugins/framework/plugins/plugin-loader/core/{index,waves,topo}.ts` | **new** shared graph functions (moved verbatim) |
| `plugins/framework/plugins/plugin-loader/core/waves.test.ts` | **new** (moved + central-graph + topo cases) |
| `plugins/framework/plugins/server-core/bin/index.ts` | import from leaf |
| `plugins/framework/plugins/server-core/bin/topo.ts` + `topo.test.ts` | **delete** (moved) |
| `plugins/framework/plugins/central-core/bin/index.ts` | wave-load + core-warm + fatal failures |
| `plugins/framework/plugins/central-core/bin/topo.ts` | **delete** (moved) |
| `plugins/framework/plugins/web-sdk/core/index.ts` | drop public `topoSortPlugins` re-export |
| `plugins/framework/plugins/web-sdk/core/context.tsx` | import from leaf |
| `plugins/framework/plugins/web-sdk/core/topo.ts` | **delete** (moved) |
| `plugins/framework/plugins/web-sdk/core/loader.ts` | add browser-safety doc comment |

## Verification

- **Unit (the load-bearing check for central, which can't be run live):**
  `bun test plugins/framework/plugins/plugin-loader/core/waves.test.ts` — waves,
  cycles, web-only-dep-ignored, empty, `topoSortPlugins` ordering, and the central
  3-wave partition.
- **Type-check + checks:** `./equin build` then `./equin check`
  (`type-check`, `plugin-boundaries`, `plugins-doc-in-sync`,
  `plugins-registry-in-sync` — the new core-only leaf regenerates docs; central/web
  public-API drift regenerates). `build` runs `bun install` first, picking up the
  new workspace package.
- **Server (behavior-preserving — just an import move):** `./equin build`
  restarts the server; confirm it boots and the Pages editor writes text blocks
  (the original repro), at `http://<worktree>.localhost:9000`.
- **Web:** browser boot is unaffected; the load-only smoke stays green —
  `bun run test:dom plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx`.
- **Central (cannot be verified from the worktree):** the change is inert until
  merged to `main` and central is restarted. Post-merge, whoever restarts central
  confirms all 5 central plugins load (auth / secrets connect state works; no
  `[plugin.*] load failed` lines). Call this out in the PR — a reviewer with
  central-restart authority owns the final confirmation.

## Out of scope / follow-ups

- No web loader reorder (browser is spec-safe).
- The shared leaf is the *clean* home; if any future runtime adds a Bun-executed
  loader, it imports `computeLoadWaves` from the same leaf rather than re-deriving it.
