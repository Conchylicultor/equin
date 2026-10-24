# Plugin DAG Migration: Top-Level Directories → Regular Plugins

## Context

The plugin system currently has an artificial boundary: `plugin-core/`, `server/`, `web/`, `cli/`, `tooling/`, and `central/` are special top-level directories that sit outside the plugin DAG. Plugins can import from `server/` via `@server/*`, but `server/` cannot import from plugins. This prevents natural patterns like a `logs` plugin whose foundational API the server bootstrap uses.

The fix: make every top-level directory a regular plugin under `plugins/`. The dependency graph becomes a true DAG enforced by the boundary checker's zone system. This plan covers phases 3–7 (phases 1–2 — rename `shared/` → `core/`, add `internal/` zone — are scoped separately).

## Status

| Phase | Target | Status |
|-------|--------|--------|
| 1–2 | `shared/` → `core/` + `internal/` zone | **Done** (2026-05-12, `cae45a43`) |
| 3 | `plugin-core/` → `plugins/` | **Done** (2026-05-14, `715930f7`) — landed in `plugins/framework/plugins/web-sdk/` rather than standalone `plugins/plugin-core/` |
| 3+ | Remove `@core`/`@web-sdk` aliases | **Done** (2026-05-14, `12c07e5f`) — all consumer imports migrated to canonical `@plugins/framework/plugins/web-sdk/core` paths |
| 4 | `server/` → `plugins/framework/plugins/server/` | **Done** (2026-05-18) — split into `core/` (framework API) + `bin/` (boot harness); `central/src/` → `central/bin/` for gateway parity |
| 4b | `central/` → `plugins/framework/plugins/central-core/` | **Done** (2026-05-19) — split into `core/` + `bin/`; `@central/*` alias fully removed, all 8 imports migrated to canonical `@plugins/.../core` paths |
| 5 | `web/` → `plugins/framework/plugins/web/` | Not started |
| 7 | `tooling/` → `plugins/framework/plugins/tooling/` | Not started |
| 6 | `cli/` → `plugins/framework/plugins/cli/` | Not started |

## Alias Transition Strategy (applies to remaining phases)

Each top-level directory has a path alias (`@server/*`, `@tooling/*`). On move, the alias is **retargeted** in tsconfig/vite config to point to the new location. Zero consumer files change their import text. A follow-on cleanup can later migrate imports to `@plugins/*/core` form, but it's not required for correctness.

> **Precedent from Phase 3:** The `@core` alias was fully removed and all ~150 consumer imports migrated to canonical `@plugins/...` paths in the same PR (`12c07e5f`). This went beyond the retarget-only strategy and proved that full migration is feasible in a single step. Remaining phases can choose either approach.

Concretely, three files absorb each alias retarget:
- Root `tsconfig.json` (paths)
- `web/vite.config.ts` (Vite resolve.alias) — until web itself moves
- Consumer tsconfig files (`server/tsconfig.json`, etc.)

After each phase, the moved directory's explicit entry in root `package.json` workspaces is deleted — `plugins/**` already covers the new location.

## Phase 3: `plugin-core/` → `plugins/framework/plugins/web-sdk/` ✅

**Completed 2026-05-14** in two steps:

1. **Move** (`715930f7`): `plugin-core/` → `plugins/framework/plugins/web-sdk/`. Landed as a sub-plugin of `framework` rather than a standalone `plugins/plugin-core/` — the web-sdk is the natural home since these are web-only runtime primitives (defineSlot, defineCommand, PluginProvider, etc.).
2. **Alias cleanup** (`12c07e5f`): Removed `@core` and `@web-sdk` hardcoded aliases across all consumer files, replacing with canonical `@plugins/framework/plugins/web-sdk/core` paths. This went beyond the original plan's "retarget alias" strategy — imports were fully migrated rather than just retargeted.

The `plugin-core/` directory at root is now empty (stale `node_modules/` only, not tracked in git).

---

## Phase 4: `server/` → `plugins/framework/plugins/server/`

**Why second:** This is the most valuable phase — it unlocks the original pain point (plugins depending on server infra). Also the most complex structurally because `server/` plays two roles: a framework library and a Bun process entry point.

Detailed implementation plan: [`research/2026-05-18-phase4-server-to-plugin.md`](./2026-05-18-phase4-server-to-plugin.md)

### Summary

Split `server/src/` into `core/` (framework API: types, resources, contributions — 196 imports across 163 files) and `bin/` (boot harness: Bun.serve, topo-sort, lifecycle — zero external consumers). Rename entry point to `bin/index.ts` (one-line gateway change, applies to central too). Retarget `@server/*` alias from `server/src/*` to `plugins/framework/plugins/server/core/*` — zero consumer file changes. Update gateway (1 line), `cli/build.ts` (2 lines), `plugin-registry-gen.ts` (3 fields), `boundary.config.ts` (remove server zone + 2 edges), `resolve.ts` (zone → `plugin.framework.server`), and 7 tooling check files.

### Done when

- `./equin build` succeeds, server boots, `/api/health` returns 200
- `./equin check` passes
- `server/` deleted from repo root
- All `@server/*` imports resolve to `plugins/framework/plugins/server/core/*`

---

## Phase 4b: `central/` → `plugins/framework/plugins/central-core/`

**Structurally identical to Phase 4** but much smaller — 8 consumer imports across 4 files vs 196 across 163.

Detailed implementation plan: [`research/2026-05-18-phase4b-central-to-plugin.md`](./2026-05-18-phase4b-central-to-plugin.md)

### Summary

Split `central/bin/` into `core/` (framework API: types, resources — 8 imports across 8 files) and `bin/` (boot harness: Bun.serve, topo-sort, lifecycle — zero external consumers). Landed directly as `central-core/` to avoid the server→server-core follow-on rename. Fully removed `@central/*` alias and migrated all 8 consumer imports to canonical `@plugins/framework/plugins/central-core/core` paths. Zero gateway code changes.

### Done when

- `./equin build` succeeds, server + central boot, `/api/health` returns 200
- `./equin check` passes
- `central/` deleted from repo root
- All 8 `@central/*` imports migrated to canonical `@plugins/...` paths

---

## Phase 5: `web/` → `plugins/framework/plugins/web/`

**Simplest phase.** No cross-boundary consumers. Pure Vite SPA entry point.

### What moves

```
plugins/framework/plugins/web/
  web/               ← web barrel (zone: web) — the SPA entry
    main.tsx
    App.tsx
    plugins.ts, plugins.generated.ts
    components/, hooks/, lib/, theme/
  vite.config.ts
  tsconfig.app.json, tsconfig.json, tsconfig.node.json
```

### Import paths

No external consumers. Internal `@/*` alias retargeted from `./src/*` to `./web/*`. All vite.config.ts alias targets shift by a deeper directory level (`../plugins/...` → `../../../../plugins/...`).

### Boundary checker

- `boundary.config.ts`: remove `zone("web", { match: "web" })` and its edges. Becomes `plugin.framework.web`.
- `exclude` list: update `web/src/...` → `plugins/framework/plugins/web/web/...`.
- `plugin-registry-gen.ts`: update `RUNTIMES.web.registryFile` and `generatedFile`.

### Build system

- `cli/src/commands/build.ts`: `resolve(root, "web")` → `resolve(root, "plugins/framework/plugins/web")`.
- Gateway: static files served from `web/dist` → `plugins/framework/plugins/web/dist`. Verify the spec JSON `web` field.
- `tsc` invocation: update path.

### Key risks

- shadcn `components.json` likely has a `tsConfigFilePath` pointing to the old location. Must update.
- Vite `build.outDir` resolves to `plugins/framework/plugins/web/dist` — gateway spec must match.
- **Deep nesting.** Relative paths in vite.config.ts (alias targets like `../../plugins/...`) become significantly deeper (`../../../../plugins/...`). Must verify all resolve correctly.

### Done when

- `./equin build` succeeds, SPA loads in browser.
- `./equin check` passes.
- `web/` deleted from repo root.

---

## Phase 7: `tooling/` → `plugins/framework/plugins/tooling/`

**Before CLI** because CLI imports `@tooling/*`. Moving tooling first means CLI's alias just gets retargeted.

### What moves

```
plugins/framework/plugins/tooling/
  src/               ← no zone structure (pure tool, no cross-plugin API)
    boundaries/
    checks/
    guards/
    lint/
    docgen.ts, guard.ts, plugin-registry-gen.ts
```

Tooling is a leaf package with no web/server runtime. Keeps `src/` layout.

### Import paths

`@tooling/*` → retarget from `tooling/src/*` to `plugins/framework/plugins/tooling/src/*`. Consumers: CLI and root config files.

Root config file updates:
- `boundary.config.ts`: `import ... from "./tooling/src/boundaries/config"` → `"./plugins/framework/plugins/tooling/src/boundaries/config"`
- `eslint.config.ts`: `import ... from "./tooling/src/lint/..."` → `"./plugins/framework/plugins/tooling/src/lint/..."`
- `.claude/settings.json` hooks: `bun tooling/src/guard.ts` → `bun plugins/framework/plugins/tooling/src/guard.ts`

### Boundary checker

- `boundary.config.ts`: remove `zone("tooling", { match: "tooling" })`. Becomes `plugin.framework.tooling`.
- Self-validation: after this move, `plugin-boundaries` scans `plugins/framework/plugins/tooling/` as a regular plugin. The `no-plugin-imports-in-core` check no longer needs to protect `tooling/` (it's now a plugin that can import other plugins).

### Key risks

- **Self-referential bootstrap.** `boundary.config.ts` imports from `plugins/framework/plugins/tooling/...`. If this import fails, `./equin check` can't run. The module has zero external deps so this is safe as long as the path is correct.
- `checks/index.ts` imports `boundary.config.ts` via relative path — depth increases significantly. Verify.
- **Deep nesting.** Path from `plugins/framework/plugins/tooling/src/checks/index.ts` back to root `boundary.config.ts` is `../../../../../../boundary.config`. Fragile — consider using an absolute path resolution pattern instead.

### Done when

- `./equin check` passes (including boundary checker scanning itself as a plugin).
- `tooling/` deleted from repo root.

---

## Phase 6: `cli/` → `plugins/framework/plugins/cli/`

**Last** because it depends on tooling's final location (Phase 7, done).

Detailed implementation plan: [`research/2026-05-20-phase6-cli-to-plugin.md`](./2026-05-20-phase6-cli-to-plugin.md)

### Summary

Pure leaf — nothing imports from CLI. Move `cli/` → `plugins/framework/plugins/cli/`, renaming `src/` → `bin/` and `git-merge-drivers/` → `scripts/` to match existing framework plugin conventions (`server-core/bin/`, `server-core/scripts/`). No `core/` — CLI has no public API. Update the `singularity` shell script entry point first (critical path), then 3 self-invocation paths in `push.ts`, 3 merge-driver script paths in `register-merge-drivers.ts`, 1 `git show` path in `broadcasts.ts`. Remove the `cli` zone and its edge from `boundary-config.ts` (subsumed by `plugin.framework.cli` via `plugin.** -> plugin.**`). Retarget `@plugins/*` alias in `cli/tsconfig.json` from `../plugins/*` to `../../../../plugins/*`. Remove `"cli"` from root `package.json` workspaces (`plugins/**` glob covers the new location).

### Done when

- `./equin build`, `./equin check`, and `./equin push` (dry-run) all work.
- `cli/` deleted from repo root.
- Root `package.json` workspaces is `["plugins/**"]` only.

---

## Phase Order

```
3 (plugin-core) ✅  →  4 (server)  →  5 (web)  →  7 (tooling)  →  6 (cli)
```

- **3 done**: landed in `plugins/framework/plugins/web-sdk/`
- **4 done**: landed in `plugins/framework/plugins/server-core/`
- **4b done**: landed in `plugins/framework/plugins/central-core/`
- **5 next**: simple, no dependents
- **7 before 6**: CLI imports `@tooling/*`
- **6 last**: pure leaf consumer

## End State

After all phases, the repo root simplifies to:

```
├── plugins/
│   ├── framework/
│   │   └── plugins/
│   │       ├── web-sdk/      ← Phase 3, done
│   │       ├── server-core/  ← Phase 4, done
│   │       ├── central-core/ ← Phase 4b, done
│   │       ├── web/          ← Phase 5
│   │       ├── tooling/   ← Phase 7
│   │       └── cli/       ← Phase 6
│   ├── shell/
│   ├── tasks/
│   └── ...                ← feature plugins
├── gateway/               ← Go binary, stays at root
├── boundary.config.ts     ← references plugins/framework/plugins/tooling/
├── eslint.config.ts       ← references plugins/framework/plugins/tooling/
├── singularity            ← shell script, references plugins/framework/plugins/cli/
└── package.json           ← workspaces: ["plugins/**"]
```

`boundary.config.ts` zones simplify to one zone with `discover: "plugin-tree"`:

```typescript
zones: [
  zone("plugin", { match: "plugins", discover: "plugin-tree" }),
  // web, cli, tooling zones remain until Phases 5/6/7
],
```

The zone DAG (`core/internal/server/web/cli`) is enforced within each plugin by the zone model from phases 1–2, not by top-level directory zones.

## Verification

After each phase:
1. `./equin build` — full build succeeds
2. `./equin check` — all checks pass (boundary-rules, plugin-boundaries, typescript, eslint, etc.)
3. Navigate to `http://<worktree>.localhost:9000` — app loads and functions
4. The moved directory is fully deleted from repo root
