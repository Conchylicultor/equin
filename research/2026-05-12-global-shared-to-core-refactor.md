# Refactor: Kill `shared/`, replace with `core/` + `internal/`

## Context

Every plugin's `shared/` directory conflates two roles under one import path:

1. **Public contract** — types/helpers other plugins import (`@plugins/rank/shared` → `Rank`, used by 32+ plugins)
2. **Internal DRY** — code a plugin's own `web/` and `server/` both need (`@plugins/health/shared` → `HealthResponse`, never imported externally)

This blocks a key architectural need: **core server code (`server/src/`) cannot import plugin types**. The zone DAG forbids `server → plugin.**`, and `no-plugin-imports-in-core` blocks all `@plugins/` imports. There's no way to distinguish "I need your public types" from "I'm reaching into your internals."

## Design

**Kill `shared/` entirely.** Replace with two distinct runtimes:

- **`core/`** — Public API barrel. Importable cross-plugin and from `server/src/`, `web/src/`, `central/src/`, `cli/src/`, `tooling/src/`.
- **`internal/`** — Private DRY. Same-plugin imports only. Same barrel + zone semantics as `shared/` had, just restricted to intra-plugin.

After this refactor, the runtime set is `[web, server, central, core, internal]`. No plugin has `shared/` anymore.

### Runtime isolation

```
web:      [web, core, internal]
server:   [server, core, internal]
central:  [central, core, internal]
core:     [core]
internal: [internal, core]
```

Cross-plugin `internal/` imports are blocked by a new boundary rule (R10), not by runtime isolation (which is zone-level, not plugin-level).

### Zone DAG

Add `allow("server -> plugin.**")` so `server/src/` can import `@plugins/foo/core`. Runtime isolation ensures only `core` (and `internal`, blocked by R10) are reachable from server code.

### Scale

- 62 `shared/` directories total
- **16 → `core/`** (have cross-plugin importers). ALL imports rewritten (`shared` → `core`), including intra-plugin:

| Plugin | Cross-plugin importers |
|--------|------------------------|
| `primitives/plugins/rank` | 32 |
| `primitives/plugins/live-state` | 30 |
| `config` | 15 |
| `primitives/plugins/paste-images` | 10 |
| `tasks-core` | 8 |
| `conversations/plugins/model-provider` | 8 |
| `conversations/plugins/transcript-watcher` | 5 |
| `packages/plugins/retry` | 5 |
| `conversations/plugins/conversation-view/plugins/code` | 3+1 child |
| `ui/plugins/theme-engine` | 3 |
| `conversations` | 2+1 child |
| `tasks` | 1 |
| `tasks/plugins/task-draft-form` | 1 |
| `plugin-meta/plugins/plugin-tree` | 1 (tooling) |
| `infra/plugins/secrets` | 1 |
| `auth` | 0 external + 2 child |

- **46 → `internal/`** (no cross-plugin importers). Pure rename, all imports rewritten (`shared` → `internal`).
- 4 child→parent `shared/` imports (auth×2, conversations×1, code×1) — parents are all in the `core/` list.

## Implementation

### Phase 1: Infrastructure — teach tooling about `core/` and `internal/`

Replace `shared` with `core` + `internal` in every place the runtime system is aware of runtimes. At this stage both old (`shared`) and new (`core`, `internal`) work — no plugins change yet.

**Files to modify:**

| File | Change |
|------|--------|
| `boundary.config.ts` | Replace `shared` with `core` + `internal` in runtimes map; add `allow("server -> plugin.**")` edge |
| `tooling/src/boundaries/resolve.ts:5` | `RUNTIMES = new Set(["web", "server", "central", "shared", "core", "internal"])` (keep `shared` temporarily for transition) |
| `tooling/src/checks/plugin-boundaries.ts:29` | `VALID_RUNTIMES = new Set(["web", "server", "central", "shared", "core", "internal"])` |
| `tooling/src/checks/plugin-boundaries.ts:93` | Barrel purity loop: add `"core"`, `"internal"` |
| `tooling/src/checks/plugin-boundaries.ts:238-252` | `runtimeForPath`: add `core` and `internal` branches |
| `tooling/src/checks/plugin-boundaries.ts:213-217` | R6 cycle edges: include `core`+`internal` in all runtime graphs (like `shared` was) |
| `tooling/src/checks/no-plugin-imports-in-core.ts:17` | Allow `@plugins/.../core` imports from non-plugin code |
| `plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` | Detect `core/index.ts` and `internal/index.ts`; update `PluginNode.exports`; update `pluginModuleRe` regex |
| `tooling/src/docgen.ts` | Add `renderExportsAt("core", ...)` and `renderExportsAt("internal", ...)`; remove `renderExportsAt("shared", ...)` after migration |
| `server/tsconfig.json` | Add `../plugins/*/core` and `../plugins/*/internal` at all 5 nesting levels |
| `web/tsconfig.app.json` | Add `../plugins/*/core` and `../plugins/*/internal` at all 5 nesting levels |
| `central/tsconfig.json` | Add `../plugins/*/core` and `../plugins/*/internal` at all 4 nesting levels |

**Verify:** `./equin check` passes.

### Phase 2: Migration script — rename all `shared/` directories

Write `tooling/src/migrate-shared-to-core.ts` (one-shot Bun script):

```
1. Build plugin tree
2. For each plugin with shared/:
   a. Determine target: core/ (if in the 16-plugin list) or internal/ (otherwise)
   b. Rename shared/ → target/ on disk (mv)
   c. Rewrite ALL imports repo-wide:
      "@plugins/<path>/shared" → "@plugins/<path>/core" (or /internal)
      Include: plugins/, server/src/, web/src/, central/src/, tooling/src/, cli/src/
3. Print summary: N→core, M→internal, K files rewritten
```

The target determination can be automated:
- Grep for `@plugins/<path>/shared` across the entire repo
- If ANY importer is outside the plugin's subtree → `core/`
- Otherwise → `internal/`

Import rewriting is textual: replace the quoted string `"@plugins/<path>/shared"` with the target. Safe because import specifiers are always string literals.

**Verify:** `./equin check` passes. TypeScript compiles (`bunx tsc --noEmit` in server/, web/, central/). `./equin build` succeeds.

### Phase 3: Lock down + cleanup

1. **Add R10** to `plugin-boundaries.ts` — block cross-plugin `internal/` imports:

```typescript
if (!frameworkExempt && resolved.suffixHead === "internal") {
  violations.push({
    rule: "cross-plugin-internal",
    file: relFile,
    message: `cross-plugin import from \`${imp.path}\` — internal/ is plugin-private`,
    fix: `if this plugin needs a public API, create a core/ barrel.`,
  });
}
```

2. **Remove `shared` from RUNTIMES/VALID_RUNTIMES** — no plugin has `shared/` anymore.

3. **Remove `shared` patterns from tsconfig `include`** arrays.

4. **Update `boundary.config.ts`** — remove `shared` from runtimes map entirely.

**Verify:** `./equin check` passes with 0 violations.

### Phase 4: Documentation

Update `CLAUDE.md`, `plugin-core/CLAUDE.md`, `server/CLAUDE.md`:
- `core/` = public API barrel, cross-plugin + framework-importable
- `internal/` = private DRY between runtimes, same-plugin only
- `server/src/` can now import `@plugins/foo/core`
- Cross-plugin import grammar: `@plugins/<name>/{web,server,central,core}` (never `internal`)

## Verification

After full implementation:

1. `./equin check` — all checks pass
2. `./equin build` — builds clean, docs show `Exports (core):` where appropriate
3. TypeScript: `bunx tsc --noEmit` in server/, web/, central/
4. Smoke test: `server/src/` imports `@plugins/tasks-core/core` → compiles, passes checks
5. `server/src/` imports `@plugins/tasks-core/internal` → R10 rejects it
6. No `shared/` directory exists anywhere under `plugins/`
