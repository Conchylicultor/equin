# Single-source the `@plugins/*` tsconfig alias (kill the per-config duplicate)

## Context

The `@plugins/*` path alias is the load-bearing cross-plugin import grammar for the
whole repo. Today **every** `tsconfig` in the repo redeclares it independently, each
with its own depth-relative target string:

| File | declared target | extends base? |
|---|---|---|
| `tsconfig.json` (root, solution) | `./plugins/*` | no |
| `tsconfig.tools.json` | `./plugins/*` | yes |
| `tsconfig.test.json` | `./plugins/*` | yes |
| `plugins/framework/plugins/web-core/tsconfig.json` (solution) | `../../../*` | no |
| `plugins/framework/plugins/web-core/tsconfig.app.json` | `../../../*` | yes |
| `plugins/framework/plugins/server-core/tsconfig.json` | `../../../*` | yes |
| `plugins/framework/plugins/central-core/tsconfig.json` | `../../../*` | yes |
| `plugins/framework/plugins/cli/tsconfig.json` | `../../../../plugins/*` | yes |
| `plugins/framework/plugins/tooling/tsconfig.json` | `../../../*` | yes |
| `tsconfig.base.json` | — (none) | — |
| `web-core/tsconfig.node.json` | — (none) | yes |

All of those targets resolve to the **same** absolute path, `<repo-root>/plugins/*` —
they only differ because tsconfig `paths` resolve relative to the file that declares
them, and each file sits at a different depth.

Because `paths` in an `extends` child **fully replace** (don't merge with) the parent's
`paths`, and the three resolvers in play each read a *different* config, the duplication
is a silent footgun:

- **Vite** uses its own alias (`web-core/vite.config.ts` → `@plugins` → `../../../`), independent of tsconfig.
- **tsc** reads each project's `tsconfig.app.json` / referenced config.
- **bun** (the docgen / `barrel-import` / plugin-tree runtime) reads the **nearest
  `tsconfig.json`** walking up from the source file — for a file under `web-core/` that
  is `web-core/tsconfig.json`, *not* `tsconfig.app.json`.

So when a `web-core/` file imports `@plugins/<…>`, it resolves under Vite and tsc but
throws `Cannot find module @plugins/...` at runtime in the bun docgen — a confusing
error far from the cause. This already bit the select-scope work; the current "fix" is a
hardcoded duplicate of the alias in `web-core/tsconfig.json` that will rot or be
forgotten the next time a config is added or a file moves.

**Goal:** declare `@plugins/*` exactly once, have every config inherit it, and make it
structurally impossible to silently reintroduce a per-config copy.

## Why single-sourcing works (verified)

`paths` declared in `tsconfig.base.json` (at repo root) resolve relative to the **base
file**, i.e. to `<root>/plugins/*` — the universally-correct target for *every* config
regardless of its own depth. Confirmed empirically that both runtimes honor an
**inherited** base-relative `@plugins/*` from a deeply-nested leaf config that has no
`paths` of its own, including from a **solution-style** config (`files: []` +
`references`, which is the shape bun lands on for `web-core/`):

- bun 1.3.13: resolves `@plugins/foo/web` from a nested `run.ts` ✓
- tsc 5.8 (`tsc -p`): clean, no unresolved-module errors ✓

So a single declaration in `tsconfig.base.json` covers tsc, bun, and (already
independent) Vite.

## Plan

### 1. Declare the alias once, in `tsconfig.base.json`

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    /* …existing options… */
    "paths": { "@plugins/*": ["./plugins/*"] }
  }
}
```

### 2. Remove the duplicate from every config that already extends base

Delete the `paths` (or just the `@plugins/*` entry) from each:

- `tsconfig.tools.json`
- `tsconfig.test.json`
- `plugins/framework/plugins/web-core/tsconfig.app.json`
- `plugins/framework/plugins/server-core/tsconfig.json`
- `plugins/framework/plugins/central-core/tsconfig.json`
- `plugins/framework/plugins/cli/tsconfig.json`
- `plugins/framework/plugins/tooling/tsconfig.json`

(`web-core/tsconfig.node.json` already has no `paths` — leave it.)

### 3. Make the two solution configs inherit base

Neither currently `extends` anything. Add `extends` and drop their `paths`:

- `tsconfig.json` (root) → `"extends": "./tsconfig.base.json"`. It has `files: []` and
  only `references`, so inheriting base's compiler options is inert; it just needs the
  alias for bun runs whose cwd is the repo root.
- `plugins/framework/plugins/web-core/tsconfig.json` →
  `"extends": "../../../../tsconfig.base.json"`. This is the config bun lands on for
  `web-core/` files — the one whose missing alias caused the original bug.

After this step, **`tsconfig.base.json` is the only file in the repo that names
`@plugins/*`.**

### 4. Add a regression-guard check: `tsconfig-alias-single-owner`

New check sub-plugin (same shape as the existing ones under
`plugins/framework/plugins/tooling/plugins/checks/plugins/<name>/check/index.ts`,
default-exporting a `Check` — discovered automatically, no registry edit):

- **Path:** `plugins/framework/plugins/tooling/plugins/checks/plugins/tsconfig-alias-single-owner/check/index.ts`
- **Id:** `tsconfig-alias-single-owner`
- **Logic:**
  1. Read `tsconfig.base.json` (raw, **without** following `extends`) and collect the
     set of alias keys it declares under `compilerOptions.paths` (today: `@plugins/*`).
  2. Enumerate every `tsconfig*.json` in the repo — root-level
     (`rg --files -g 'tsconfig*.json'` equivalent via `fs`: root + `plugins/framework/plugins/*/tsconfig*.json`),
     excluding `node_modules`, `sidequests/`, and `tsconfig.base.json` itself.
  3. For each, read its **raw** `compilerOptions.paths` and **fail** if it locally
     declares any key the base owns.
  4. Failure message lists offending files + the alias, with the fix: "remove the
     `@plugins/*` paths entry; it is inherited from `tsconfig.base.json`."
- **Parsing:** use TypeScript's own `ts.readConfigFile(path, ts.sys.readFile)` — it
  parses JSONC and returns the **single file's literal** object (it does *not* resolve
  `extends`), which is exactly the raw view we need. `typescript` is already a dep; no
  new JSONC parser. Reuse the framework-plugin enumeration idea from
  `plugins/framework/plugins/tooling/plugins/checks/core/discover.ts`.

The invariant is generic: base owns the shared aliases, no leaf may redeclare them. If a
new shared alias is added to base later, the check covers it automatically with zero
edits.

Also add the plugin's `CLAUDE.md` (the `plugins-have-claudemd` check requires it) and
let `./equin build` regenerate the plugin docs.

## Critical files

- `tsconfig.base.json` — add the single `paths` declaration.
- `tsconfig.json`, `tsconfig.tools.json`, `tsconfig.test.json` — drop alias / add extends.
- `plugins/framework/plugins/web-core/tsconfig.json` + `tsconfig.app.json` — add extends / drop alias.
- `plugins/framework/plugins/{server-core,central-core,cli,tooling}/tsconfig.json` — drop alias.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/tsconfig-alias-single-owner/` — new check + `CLAUDE.md`.

## Verification

1. **Type-check (tsc, all targets):**
   `./equin check type-check` — must stay green (proves every project still
   resolves `@plugins/*` via inheritance).
2. **bun docgen / plugin tree (the path that originally broke):**
   `./equin build` — the docgen / `barrel-import` step rebuilds the plugin tree
   under bun; a regression here is exactly the original `Cannot find module @plugins/...`.
   To target the failure class directly, confirm a `web-core/` file importing a plugin
   still resolves: temporarily run the barrel-import/docgen entry, or rely on the build's
   plugins-doc generation which walks `web-core/`.
3. **New guard check passes on the cleaned tree, fails on a duplicate:**
   - `./equin check tsconfig-alias-single-owner` → green after step 1–3.
   - Manually re-add `"paths": { "@plugins/*": [...] }` to any leaf tsconfig and rerun
     → the check must fail and name that file. Revert.
4. **Full sweep:** `./equin check` — all checks green (includes
   `migrations-in-sync`, `plugins-doc-in-sync`, `plugins-have-claudemd` for the new
   sub-plugin, and `type-check`).
5. **App boots:** `./equin build` succeeds and `http://<worktree>.localhost:9000`
   loads (Vite alias path, unaffected, sanity check).

## Notes / risks

- Vite resolution is independent and untouched — no change to `web-core/vite.config.ts`.
- Root `tsconfig.json` and `web-core/tsconfig.json` gaining `extends: base` pulls in
  base compiler options, but both are solution configs (`files: []`) so nothing is
  compiled under them directly — inert.
- `sidequests/` are independent projects with their own tsconfigs and are explicitly
  excluded from the guard check.
