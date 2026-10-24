# Plugin Module Boundaries — v2

Supersedes [`2026-04-18-global-plugin-module-boundaries.md`](./2026-04-18-global-plugin-module-boundaries.md). Same goal (self-healing plugin boundaries), different shape. The earlier plan split public surface across two barrels (`index.ts` for registration, `api.ts` for library exports); design discussion concluded that one barrel + ES-module semantics already distinguishes the two roles, and the second barrel is ceremony without enforcement value. This doc codifies the simpler model and adds acyclicity as a first-class invariant.

## Context

Duplication accumulates across plugins (`descriptor<T>()` copy-pasted 5×, `isDescendant` 4×, `buildTree`/`computeDrop` duplicated, `push-and-exit` prompt constants byte-identical in `web/prompt.ts` and `server/internal/prompt.ts`, etc.). More worrying than the specific cases: *there's no mechanism to prevent this from recurring*. Agents can't discover existing utilities; module boundaries are implicit; cross-plugin imports reach into `internal/` folders (3 imports into `@plugins/tasks/server/internal/tables`, 4 into `@plugins/conversations/server/internal/*`, plus deep component paths) with nothing to catch them.

Most of the infra already exists: the `internal/` convention is used (16 folders), `docs/plugins.md` is auto-generated (`cli/src/docgen.ts`) and verified by `plugins-doc-in-sync`, the check framework (`cli/src/checks/`) gates `./equin push`, and `tsconfig.json` already aliases `@plugins/*` to `./plugins/*`. This plan formalizes the boundary rules, closes the enforcement loop, and deletes the `api.ts` layer the earlier plan had proposed.

## The Rules

**R1. One barrel per runtime folder.** Each `plugins/<name>/<runtime>/index.ts` is the only cross-plugin entry point. It:

- Default-exports a `PluginDefinition` / `ServerPluginDefinition` (consumed by the registries).
- Named-exports the plugin's public library surface (consumed by other plugins).

No `api.ts`, no `shared/api.ts`. One file, two roles — the module system already distinguishes them (default vs named).

**R2. `internal/` is optional grouping, not a privacy mechanism.** Privacy is fully enforced by R4 (only `index.ts` is cross-plugin-importable — every other file, wherever it lives, is private by construction). `internal/` remains available as a *visual convention* when a plugin is large enough that grouping implementation details helps readers. For small plugins, flat is fine. The check does not require `internal/` to exist or forbid it — it enforces the import grammar directly.

**R3. Barrel purity.** Each `index.ts` may contain only:

- `import` statements
- re-exports (`export { X } from "./internal/..."`, `export type { Y } from "..."`)
- type / interface aliases
- exactly one `export default <expression>` (the `definePlugin({...})` call)

No top-level `const`/`let`/`var`, no function/class declarations, no `if`/`try`/loops, no top-level `await`. All logic lives in sibling files (conventionally `internal/` for larger plugins). Keeps barrels readable at a glance and prevents module-load side effects.

The `definePlugin({ contributions: [contribute(Slot, {...})] })` expression is allowed inline; it's a declarative manifest, not logic.

**R4. Cross-plugin import grammar.** The only legal cross-plugin paths are:

- `@plugins/<name>/web` → `plugins/<name>/web/index.ts`
- `@plugins/<name>/server` → `plugins/<name>/server/index.ts`
- `@plugins/<name>/shared` → `plugins/<name>/shared/index.ts` (when the plugin has a `shared/` folder)
- Nested plugins: `@plugins/<name>/plugins/<sub>/<suffix>` recurses with the same grammar.

Any deeper path across plugin boundaries is forbidden — whether it targets an `internal/` folder, a flat sibling file, or a nested component. Intra-plugin deep imports are unrestricted.

**R5. Default-export imports are registry-only.** Only `web/src/plugins.ts` and `server/src/plugins.ts` may import a plugin's default export across plugin boundaries. Other plugins must use named imports. This prevents one plugin from accidentally pulling in another's full PluginDefinition (and its transitive UI/route dependencies).

**R6. The cross-plugin import graph is a DAG.** Build the directed graph of cross-plugin imports (A imports anything from B ⇒ edge A→B). Any cycle fails the check. Cycles signal misdrawn boundaries; the fix is almost always to extract a shared concept into a library plugin.

Slot contributions don't count: plugin B contributing to plugin A's slot flows through `plugin-core` at runtime, not through an import edge. Type-only imports (`import type { ... }`) *do* count as edges — bidirectional type deps mean entangled contracts even if zero-cost at runtime.

**R7. DB schemas are plugin-owned.** Drizzle tables live inside the owning plugin's `server/` folder (current convention: `plugins/<name>/server/internal/{schema,tables}.ts`, which drizzle-kit already picks up via `drizzle.config.ts`'s glob). Whatever the owner wants public — types, table handles for FK use — is re-exported from `plugins/<name>/server/index.ts`:

```typescript
// plugins/tasks/server/index.ts
export { tasks, attempts, type Task, type TaskRow } from "./internal/schema";
export { _tasks, _attempts } from "./internal/tables";
// ...
export default tasksPlugin;
```

Cross-plugin FK use (`references(() => tasks.id)`) requires the owner to re-export `tasks`. One line per FK-able table — a mild cost that makes "other plugins may depend on this table's identity" an explicit decision.

`server/src/db/schema.ts` is the drizzle runtime aggregator and is a framework-level exception: it's allowed to `export *` from plugin internals because it's not plugin code. The check whitelists it explicitly.

**R8. Library plugins share the feature-plugin shape.** A library plugin is a regular plugin with empty `contributions: []`. Same folder layout, same `index.ts`, same check rules, same registry registration (a cheap no-op). `plugins/launch/` is already this shape. `plugins.md` lists them identically; the "Contributes:" section just happens to be empty. No folder-name prefix, no separate registry.

## Check: `plugin-boundaries`

New check at `cli/src/checks/plugin-boundaries.ts`, registered in `cli/src/checks/index.ts`. Runs automatically before `./equin push`. Conforms to the existing `Check` interface (`{ id, description, run(): Promise<CheckResult> }`; see `cli/src/checks/types.ts` and `cli/src/checks/plugins-doc-in-sync.ts` for the shape).

**Implementation:** one pass over `.ts`/`.tsx` files under `plugins/`, `web/src/`, `server/src/`. Regex-extract `from ["']@plugins/...["']` imports plus whether the import is default or named (`import foo from`, `import { ... } from`, `import type { ... } from`). Build:

- A flat list of cross-plugin import edges (source file, target plugin, import kind).
- Per-plugin `index.ts` AST (via TypeScript compiler API or a small hand-rolled walker — the file is a barrel, so a regex-plus-bracket-counter is sufficient).

Then verify:

1. **Package naming.** Every `plugins/**/package.json` has `name === "@singularity/plugin-<folder-name>"`.
2. **Grammar.** Each cross-plugin import path matches R4. Any deeper path fails — there is no `internal/` special case; the check only asks "is this deeper than the barrel?"
3. **Registry exclusivity.** Default imports are only in `web/src/plugins.ts` / `server/src/plugins.ts` (+ `server/src/db/schema.ts` for DB aggregator `export *` — whitelisted).
4. **Barrel purity.** Each `plugins/**/index.ts` contains only the allowed node kinds (R3).
5. **Acyclicity.** The cross-plugin import graph has no cycles (Tarjan or iterative DFS; print the first cycle path on failure).

**Output.** Emit up to ~10 violations per run, each with a `hint` pointing at the concrete fix — e.g. "`@plugins/tasks/server/internal/tables` is private; add `export { _tasks } from './internal/tables'` to `plugins/tasks/server/index.ts` and import from `@plugins/tasks/server`." Match the format of existing checks (short `message`, optional `hint`, stderr-friendly).

Deferred: ESLint `no-restricted-imports` (redundant with the check), `package.json` `exports` enforcement (bypassed by the `@plugins/*` tsconfig alias — revisit only if the check proves insufficient).

## Docgen extension

`cli/src/docgen.ts` already parses plugin barrels via `parseApiExports()` and emits `docs/plugins.md`. Extend it to:

1. Parse each plugin's `web/index.ts` / `server/index.ts` / `shared/index.ts` for top-level *named* `export` declarations (skip the `export default` — that's the PluginDefinition side, already covered).
2. Emit an **Exports:** subsection in the plugin's block, grouping symbols by kind. Docgen infers kind via simple heuristics:
   - `export type` / `export interface` → type
   - capitalized name + JSX-like return annotation → component
   - otherwise → function/value

Schemas re-exported from `internal/schema.ts` simply appear in the list; no special category.

Example:

```markdown
- **`tasks`** — Nested tasks with attempts...
  - Exports (server):
    - Types: `Task`, `TaskRow`, `TaskStatus`
    - Values: `tasks`, `attempts`, `tasksResource`, `nextRankUnder`, `CONVERSATIONS_META_TASK_ID`
  - Contributes: ...
```

This closes the discoverability loop: the existing `plugins-doc-in-sync` check already fails on `docs/plugins.md` drift, so once exports are in the generator, they become part of the verified contract. Add one line to the root `CLAUDE.md`: *"Before writing a helper, search `docs/plugins.md` for it."*

## Scaffolder: `./equin plugin new <name>`

New command at `cli/src/commands/plugin.ts`, registered in `cli/src/index.ts` next to `registerBuild/Check/Push`.

```
./equin plugin new <name> [--web-only] [--server-only] [--parent <path>]
```

Generates the minimum that passes `plugin-boundaries` immediately:

- `plugins/<name>/package.json` — `name: "@singularity/plugin-<name>"`, standard workspace deps (`@singularity/plugin-core`, react via workspace).
- `plugins/<name>/web/index.ts` — a `PluginDefinition` default export with `contributions: []` and a `// TODO:` marker. No named exports.
- `plugins/<name>/server/index.ts` — same, unless `--web-only`.

No `api.ts` (doesn't exist in this model), no `shared/`, no sample components, no mock schemas. A bloated scaffold is worse than none — it generates cruft agents have to delete and can't tell apart from the task.

Then updates the registries:

- Append `import <name>Plugin from "@plugins/<name>/web";` + array entry to `web/src/plugins.ts`.
- Same for `server/src/plugins.ts` unless `--web-only`. Preserve the existing load-order comments (server plugins registry has a hand-maintained order, lines 20–24).

`--parent <path>` creates a nested sub-plugin (e.g. `--parent conversations/plugins/conversation-view`). Current tsconfig enumerates three levels of nesting; reject deeper parents until tsconfig is updated.

**Deferred:** auto-discovery (avoiding the manual registry edit). The scaffolder handles the common case; full auto-discovery needs dependency ordering logic that the server registry's hand-maintained comment explicitly owns today.

## Files to Create / Modify

**New:**

- `cli/src/checks/plugin-boundaries.ts` — the check.
- `cli/src/commands/plugin.ts` — the scaffolder.

**Modified:**

- `cli/src/checks/index.ts` — register `pluginBoundaries` in `CHECKS`.
- `cli/src/index.ts` — call `registerPlugin(program)`.
- `cli/src/docgen.ts` — extend plugin walker (current plugin loop around lines 57–86, renderers near lines 504–508) to emit the Exports subsection.
- `CLAUDE.md` — add the R1–R8 conventions summary and the "search `docs/plugins.md` first" rule. Remove/update any lines that still mention `api.ts` as a public barrel.
- `server/CLAUDE.md` — update the "`index.ts` and `api.ts` are public" line to reflect the single-barrel rule.
- `drizzle.config.ts` (server) — already matches `plugins/*/server/internal/{schema,tables}.ts`; no change needed.

## Migration (prerequisite for the check to go green)

The first run surfaces known violations. Fix iteratively; guard the check registration behind a commented-out `CHECKS` entry until clean.

**`api.ts` collapse.** For each plugin with an `api.ts`, merge its exports into `index.ts` and delete `api.ts`. Update consumers.

- `plugins/launch/web/api.ts` → merge `LaunchButtons`, `LaunchButtonsProps`, `LaunchRequest` re-exports into `plugins/launch/web/index.ts`. Consumers switch from `@plugins/primitives/plugins/launch/web/api` → `@plugins/primitives/plugins/launch/web` (5 imports).
- `plugins/tasks/server/api.ts` → merge all 20+ re-exports into `plugins/tasks/server/index.ts`. Consumers switch from `@plugins/tasks/server/api` → `@plugins/tasks/server` (5 imports).
- `plugins/conversations/server/api.ts` and any other `api.ts` files (config, conversations shared, etc.) → same pattern.

**Deep-path violations.** Current offenders (from grep) — all equally illegal under R4 regardless of whether they target `internal/` or a flat path:

- `@plugins/tasks/server/internal/tables` (3 imports) → re-export table handles from `tasks/server/index.ts`.
- `@plugins/conversations/server/internal/tables` (2 imports), `.../internal/worktree` (2 imports) → re-export the needed symbols from `conversations/server/index.ts`.
- `@plugins/conversations/plugins/conversation-view/web/components/conversation-view` (2 imports) → re-export from the owning plugin's `index.ts` or refactor consumer.
- `@plugins/conversations/plugins/conversation-view/web/views` (5 imports) → re-export from the plugin's `index.ts`.
- `@plugins/stats/plugins/commits/web/components/chart-primitives` (1 import) → re-export or refactor.

**Dead files.**

- Delete `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts` — byte-identical to the server copy, zero external references.

**Barrel purity.** All 6 sampled `index.ts` files are already pure (default export only). The bulk of the change is moving `api.ts` re-exports into `index.ts` — which barrel purity *explicitly allows* (re-exports are a permitted form). Expect few-to-no additional purity violations.

**Registry allow-list.** `server/src/db/schema.ts` currently `export *`s from `plugins/*/server/internal/{tables,schema}`. Whitelist this file explicitly in the check; it's framework-level aggregation, not plugin code, and the file's own comment already declares "Application code MUST NOT import from this file."

## Non-Scope (deferred)

- **`package.json` `exports` field** — bypassed by the `@plugins/*` tsconfig alias. Revisit only if the check proves insufficient.
- **Concrete dedup refactors** (`descriptor`, `buildTree`, `isDescendant`, `formatDate`, `computeDrop`) — follow-up work enabled by this plan. Natural first extraction: `plugins/tree/` (a library plugin for `isDescendant` + `buildTree` + `computeDrop` + `<TreeView>`).
- **ESLint `no-restricted-imports`** — redundant with the check.
- **Auto-discovery of plugins** in the registries — scaffolder handles the common case; auto-discovery would need dependency-ordering logic.
- **Library plugin naming prefix** (`lib-tree/` vs `tree/`) — use flat naming; R8 makes the split transparent.

## Verification

1. **Dry-run violations.** Run `./equin check --plugin-boundaries` on the current tree. Expect the violations listed in Migration. Fix iteratively; re-run until clean.
2. **Docgen.** Run `./equin build`. Confirm `docs/plugins.md` now has an "Exports:" subsection per plugin with named symbols grouped by kind.
3. **Scaffolder round-trip.** Run `./equin plugin new tree`. Inspect the skeleton: it must pass `plugin-boundaries` immediately with no edits, and entries must appear in `web/src/plugins.ts` and `server/src/plugins.ts`.
4. **Negative cases.** Deliberately add each of:
   - `import { TreeView } from "@plugins/primitives/plugins/tree/web/components/tree-view"` (deep path) → expect R4 violation.
   - `import treePlugin from "@plugins/primitives/plugins/tree/web"` in a non-registry file → expect R5 violation.
   - A `const foo = 1;` at the top of a plugin's `index.ts` → expect R3 violation.
   - A cycle: plugin A's `index.ts` imports from plugin B's `index.ts`, which imports from A's → expect R6 violation with the cycle path printed.
   Remove each after verifying the failure fires.
5. **Full check run.** `./equin check` (no flags) runs `plugin-boundaries` alongside existing checks.
6. **Push gating.** On a throwaway branch, confirm `./equin push` runs the check first and blocks the merge flow on failure.
