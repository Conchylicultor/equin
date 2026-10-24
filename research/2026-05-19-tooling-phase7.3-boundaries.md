# Phase 7.3: Boundaries → `tooling/plugins/boundaries/`

## Context

Phase 7.0–7.2 created the tooling umbrella at `plugins/framework/plugins/tooling/` and migrated guards and lint. This sub-task migrates the boundary checker — the most structurally significant move because:

- Root `boundary.config.ts` imports from `./tooling/src/boundaries/config` (a raw relative path outside the plugin tree).
- `check.ts` imports `Check`/`CheckResult` from sibling `../checks/types` — after migration that sibling is gone; must import from the umbrella `core/`.
- `SOURCE_ROOTS` includes `"tooling/src"` — wrong once boundaries lives under `"plugins"`.
- The `zone("tooling", ...)` entry and two `allow("tooling -> ...")` edges become meaningless once tooling is a plugin.
- `tooling/src/checks/index.ts` imports `createBoundaryCheck` + root config — must be updated atomically or `./equin check` breaks.

---

## Target structure

```
plugins/framework/plugins/tooling/plugins/boundaries/
  package.json                        ← @singularity/plugin-framework-tooling-boundaries
  boundary.config.ts                  ← project boundary rules (moved from repo root)
  core/
    index.ts                          ← barrel: pure re-exports
    types.ts                          ← ZoneDefinition, BoundaryConfig, Edge, RuntimeName
    config.ts                         ← zone(), allow(), deny(), defineBoundaries()
    match.ts                          ← matchZone()
    evaluate.ts                       ← evaluateEdges(), checkRuntime(), isRuntimeException(), detectCycle()
    resolve.ts                        ← buildZoneMap(), ResolvedZone, ZoneMap
    check.ts                          ← createBoundaryCheck() factory
    boundary-rules-check.ts           ← instantiates boundaryRulesCheck from co-located config
```

---

## File-by-file changes

### New: `package.json`

```json
{
  "name": "@singularity/plugin-framework-tooling-boundaries",
  "version": "0.0.1",
  "private": true,
  "description": "Boundary-rules checker: zone DSL, edge evaluator, and project boundary config"
}
```

### New: `core/boundary-rules-check.ts`

Creates the ready-made check instance. Keeps the barrel as pure re-exports.

```ts
import { createBoundaryCheck } from "./check";
import boundaryConfig from "../boundary.config";

export const boundaryRulesCheck = createBoundaryCheck(boundaryConfig);
```

### New: `core/index.ts`

Pure re-exports only (follows guards/lint barrel pattern):

```ts
export { zone, allow, deny, defineBoundaries } from "./config";
export type { BoundaryConfig, ZoneDefinition, Edge, AllowEdge, DenyEdge, RuntimeName } from "./types";
export { createBoundaryCheck } from "./check";
export { boundaryRulesCheck } from "./boundary-rules-check";
```

### Move + edit: `boundary.config.ts` (root → plugin root)

1. **Import path**: `"./tooling/src/boundaries/config"` → `"./core/config"`
2. **Remove `zone("tooling", ...)`**: tooling is now under `plugins/`, covered by `zone("plugin", ...)`
3. **Remove `allow("tooling -> plugin.framework.web-sdk")` and `allow("tooling -> plugin.framework.tooling.lint")`**: tooling-to-plugin edges are now plugin-to-plugin, covered by `allow("plugin.** -> plugin.**")`
4. **Remove `"boundary.config.ts"` from exclude list**: the new location only uses relative imports (`./core/config`), so `extractCrossZoneImports` won't flag it — no exclusion needed

### Move + edit: `check.ts` → `core/check.ts`

1. **`Check`/`CheckResult` import**: `"../checks/types"` → `"@plugins/framework/plugins/tooling/core"`
2. **`SOURCE_ROOTS`**: remove `"tooling/src"` → `["plugins", "web/src", "cli/src"]`

### Move verbatim (5 files)

| Old | New |
|-----|-----|
| `tooling/src/boundaries/types.ts` | `core/types.ts` |
| `tooling/src/boundaries/config.ts` | `core/config.ts` |
| `tooling/src/boundaries/match.ts` | `core/match.ts` |
| `tooling/src/boundaries/evaluate.ts` | `core/evaluate.ts` |
| `tooling/src/boundaries/resolve.ts` | `core/resolve.ts` |

All internal imports are relative (`./types`, `./match`) — unchanged. `resolve.ts` imports `@plugins/plugin-meta/plugins/plugin-tree/core` — valid via the umbrella tsconfig's `@plugins/*` alias.

---

## Consumer update (atomic with the move)

### `tooling/src/checks/index.ts`

Replace lines 4–5:
```ts
// OLD:
import { createBoundaryCheck } from "../boundaries/check";
import boundaryConfig from "../../../boundary.config";

// NEW:
import { boundaryRulesCheck } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
```

Delete line 26:
```ts
// OLD (delete):
const boundaryRules = createBoundaryCheck(boundaryConfig);
```

In the `CHECKS` array, rename `boundaryRules` → `boundaryRulesCheck`.

This works because old `tooling/tsconfig.json` has `@plugins/*` → `../plugins/*`.

---

## Deletions

After all moves and consumer updates:

- `tooling/src/boundaries/` — entire directory (6 files)
- Root `boundary.config.ts`

---

## Verification

1. **`./equin check --boundary-rules`** — boundary checker passes; tooling files classified as `plugin.framework.tooling.*`
2. **`./equin check`** — all checks pass (confirms `checks/index.ts` import works)
3. **`./equin build`** — full build succeeds
4. **Stale references**: `rg 'tooling/src/boundaries' .` and `rg '"boundary\.config"' .` return nothing
