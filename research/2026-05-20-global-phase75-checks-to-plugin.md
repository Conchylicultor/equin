# Phase 7.5: Checks → `tooling/plugins/checks/`

## Context

Part of the `tooling/` → plugin migration (Phase 7). Phases 7.0–7.4 are complete — the umbrella, guards, lint, boundaries, and codegen are all sub-plugins. Checks is the last module to move before the Phase 7.6 final cleanup.

`tooling/src/checks/` contains 18 individual check implementations, a runner (`runChecks`, `listAllChecks`, `CHECKS[]`), types (`Check`, `CheckResult`), and a utility script. After this migration, `tooling/src/` will be empty (ready for Phase 7.6 deletion).

**Bonus scope**: `config-origin-gen.ts` also moves to the codegen sub-plugin in this phase — it's the checks' only dependency that still lives in `tooling/src/`, and the umbrella tsconfig has no `@tooling/*` alias to resolve it. Moving it to codegen is semantically natural (it uses `buildEnrichedTree` from codegen) and eliminates the last `@tooling/*` import from the CLI.

---

## Target structure

```
plugins/framework/plugins/tooling/plugins/checks/
├── package.json
└── core/
    ├── index.ts                        ← pure barrel
    ├── types.ts                        ← re-export shim from umbrella core
    ├── runner.ts                       ← extracted from current index.ts
    ├── allow-default-project.ts
    ├── config-origins-in-sync.ts
    ├── conversation-trailer.ts
    ├── eslint.ts
    ├── migrations-in-sync.ts
    ├── no-plugin-imports-in-core.ts
    ├── no-plugin-workspace-deps.ts
    ├── no-raw-event-source.ts
    ├── no-raw-sse.ts
    ├── no-raw-websocket.ts
    ├── no-reexport-default.ts
    ├── no-relative-server-imports.ts
    ├── no-use-resource-cast.ts
    ├── plugin-boundaries.ts
    ├── plugins-doc-in-sync.ts
    ├── plugins-have-claudemd.ts
    ├── plugins-registry-in-sync.ts
    ├── snapshot-chain-intact.ts
    ├── typescript.ts
    └── scripts/
        └── fix-shared-to-relative.ts
```

No tsconfig changes needed — the umbrella's `"include": ["core", "plugins/*/core", "plugins/*/bin"]` already sweeps `checks/core/` automatically.

---

## Design decisions

1. **Split `index.ts` → `runner.ts` + pure barrel.** The current `index.ts` mixes barrel exports with runner logic (`runChecks`, `loadPluginChecks`, `isCheck`, etc.). Barrel purity is enforced by the `plugin-boundaries` check itself. Extract all logic into `runner.ts`; the barrel re-exports from `./runner` and `./types`.

2. **Move `config-origin-gen.ts` to the codegen sub-plugin.** The `config-origins-in-sync` check imports `renderConfigOriginContent` via `@tooling/config-origin-gen`. The umbrella tsconfig doesn't have `@tooling/*`, so this import would break after the move. The file already uses `buildEnrichedTree` from codegen — it's codegen for config origins and belongs there. This also migrates the `build.ts` line 567 dynamic import.

3. **`types.ts` re-exports from umbrella `core/`.** All check files' `import type { Check } from "./types"` continue unchanged.

---

## Steps

### Step 1: Create checks sub-plugin scaffold

Create `plugins/framework/plugins/tooling/plugins/checks/package.json`:
```json
{
  "name": "@singularity/plugin-framework-tooling-checks",
  "version": "0.0.1",
  "private": true,
  "description": "Check runner and built-in checks for ./equin check"
}
```

Create `plugins/framework/plugins/tooling/plugins/checks/core/types.ts`:
```ts
export type { Check, CheckResult } from "@plugins/framework/plugins/tooling/core";
```

### Step 2: Move `config-origin-gen.ts` to codegen sub-plugin

- Copy `tooling/src/config-origin-gen.ts` → `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` (no import changes needed — already uses `@plugins/*`)
- Add to `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts`:
  ```ts
  export { generateConfigOrigins, renderConfigOriginContent } from "./config-origin-gen";
  ```
- Update `cli/src/commands/build.ts:567`:
  ```ts
  // from: await import("@tooling/config-origin-gen")
  // to:   await import("@plugins/framework/plugins/tooling/plugins/codegen/core")
  ```

### Step 3: Create `runner.ts` and barrel `index.ts`

Extract all logic from `tooling/src/checks/index.ts` into `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`:
- All imports (lines 1–24), rewriting `from "./types"` stays as-is
- `CHECKS` array (lines 26–47)
- `getRoot()` (lines 51–57)
- `loadPluginChecks()` (lines 64–101)
- `isCheck()` (lines 103–111)
- `listAllChecks()` (lines 113–117)
- `RunChecksOptions` interface (lines 119–121)
- `runChecks()` (lines 123–166)

The file already uses `@plugins/*` for `buildPluginTree` (line 3) and `boundaryRulesCheck` (line 4) — those stay unchanged.

Create pure barrel `plugins/framework/plugins/tooling/plugins/checks/core/index.ts`:
```ts
export { CHECKS, runChecks, listAllChecks } from "./runner";
export type { RunChecksOptions } from "./runner";
export type { Check, CheckResult } from "./types";
```

### Step 4: Move and rewire check implementation files

Copy all 18 check files and `scripts/` to `plugins/framework/plugins/tooling/plugins/checks/core/`. Rewiring per file:

**`allow-default-project.ts`** — 3 changes:
- Line 5: `from "../eslint/allow-default-project"` → `from "@plugins/framework/plugins/tooling/plugins/lint/core"`
- Line 72: `"tooling/tsconfig.json"` → `"plugins/framework/plugins/tooling/tsconfig.json"`
- Line 102 hint: `tooling/src/eslint/allow-default-project.ts` → `plugins/framework/plugins/tooling/plugins/lint/core/allow-default-project.ts`

**`config-origins-in-sync.ts`** — 1 change:
- Line 4: `from "@tooling/config-origin-gen"` → `from "@plugins/framework/plugins/tooling/plugins/codegen/core"`

**`typescript.ts`** — 1 change:
- Line 35: `` runTsc(`${root}/tooling`, []) `` → `` runTsc(`${root}/plugins/framework/plugins/tooling`, []) ``

**`no-raw-sse.ts`** — 1 change:
- Line 13: `"tooling/src/checks/no-raw-sse.ts"` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-sse.ts"`

**`no-raw-websocket.ts`** — 1 change:
- Line 17: `"tooling/"` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-websocket.ts"`

**`no-raw-event-source.ts`** — 1 change:
- Line 14: `"tooling/"` → `"plugins/framework/plugins/tooling/plugins/checks/core/no-raw-event-source.ts"`

**`scripts/fix-shared-to-relative.ts`** — comment-only:
- Lines 7–8: Update path in usage comment to the new location

**12 files** move verbatim (no rewiring): `conversation-trailer.ts`, `eslint.ts`, `migrations-in-sync.ts`, `no-plugin-imports-in-core.ts`, `no-plugin-workspace-deps.ts`, `no-reexport-default.ts`, `no-relative-server-imports.ts`, `no-use-resource-cast.ts`, `plugin-boundaries.ts`, `plugins-doc-in-sync.ts`, `plugins-have-claudemd.ts`, `plugins-registry-in-sync.ts`, `snapshot-chain-intact.ts`

### Step 5: Update CLI consumers

**`cli/src/commands/check.ts:3`**:
```ts
import { CHECKS, listAllChecks, runChecks } from "@plugins/framework/plugins/tooling/plugins/checks/core";
```

**`cli/src/commands/build.ts:11`**:
```ts
import { runChecks } from "@plugins/framework/plugins/tooling/plugins/checks/core";
```

### Step 6: Update external string references

**`plugins/infra/plugins/paths/check/index.ts:22`**:
```ts
"plugins/framework/plugins/tooling/plugins/checks/core/migrations-in-sync.ts",
```

### Step 7: Update `eslint.config.ts` comments

- Line 10: `tooling/src/checks/eslint.ts` → `plugins/framework/plugins/tooling/plugins/checks/core/eslint.ts`
- Line 13: `tooling/src/lint/` → `plugins/framework/plugins/tooling/plugins/lint/core/`

### Step 8: Remove `@tooling/*` aliases

**`cli/tsconfig.json`**: Remove `"@tooling/*": ["../tooling/src/*"]` — all CLI consumers are migrated.

**`tooling/tsconfig.json`**: Remove `"@tooling/*": ["./src/*"]` — no internal consumers remain.

### Step 9: Delete old files

- Delete `tooling/src/checks/` (entire directory)
- Delete `tooling/src/eslint/` (re-export shim — no remaining consumers)
- Delete `tooling/src/config-origin-gen.ts` (moved to codegen)
- After deletions, `tooling/src/` is empty. Delete it too, leaving `tooling/` with only `package.json` and `tsconfig.json` for Phase 7.6.

---

## Verification

1. `./equin check` — full run, all checks pass
2. `./equin build` — config-origin codegen resolves from codegen barrel; checks run in build pipeline
3. `rg "@tooling/" --type ts` in `cli/` — zero results
4. `rg "tooling/src/" --type ts` — zero code references (only Phase 7.6 cleanup docs)
