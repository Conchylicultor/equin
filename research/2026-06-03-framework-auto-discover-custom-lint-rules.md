# Auto-discover the custom framework lint rules

## Context

The root `eslint.config.ts` hand-imports and hand-registers the three **custom**
framework lint rules — `promise-safety`, `icon-safety`, `reactive-server-io` —
in its `baseConfigs` block (plugin registration + per-rule severities). This is
the exact consumer-knows-contributor coupling that the per-plugin `lint/index.ts`
auto-discovery mechanism (used by `debug-logs`) was built to eliminate. Now that
contributed lint rules apply repo-wide rather than only within the contributor's
subtree, there is no scoping reason left for these three to be special-cased.

**Goal:** make the three custom rules ordinary auto-discovered `lint/index.ts`
contributions, exactly like `debug-logs`, so `eslint.config.ts` carries no
knowledge of any *custom* rule. Adding/removing a custom global rule becomes a
pure plugin add/remove with zero edits to `eslint.config.ts`.

**Scope decision (confirmed with user):** *Only the custom rules move.* The
genuinely third-party / built-in config — the `@typescript-eslint` plugin + its
rule severities, `react-hooks`, and the built-in ESLint rules (`eqeqeq`,
`no-constant-binary-expression`, `no-template-curly-in-string`) — **stays** in
`eslint.config.ts` as generic base plumbing. These configure external plugins
and built-ins; they are not custom rule modules and need no new contribution
form. No raw-flat-config-fragment contribution shape is introduced.

## Key constraints discovered

- **Lint-only plugins are first-class discoverable.** `buildPluginTree` admits
  any dir with a `lint/index.ts` barrel (no `web`/`server`/`core`/`definePlugin`
  required) — `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`.
  `collectEntries(root, "lint")` iterates that tree and emits an entry for every
  `lint/index.ts` with a default export — `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`.
  So a new `lint/index.ts` lands in `lintEntries` automatically.
- **But each new plugin dir still needs:** a `package.json` (boundary check R1
  fails otherwise), a `CLAUDE.md` (check `plugins-have-claudemd`), and the
  regenerated `lint.generated.ts` + `docs/plugins-*.md` committed (checks
  `plugins-registry-in-sync`, `plugins-doc-in-sync`). All three artifacts are
  produced by `./equin build`.
- **jiti constraint (do NOT regress).** `eslint.config.ts` loads each barrel by
  absolute path because jiti does not resolve the `@plugins/*` alias. Therefore a
  barrel may only import npm packages and its own sibling files (relative, same
  plugin). It must NOT import `@plugins/*` at runtime and must NOT relative-import
  across plugins. This is why the `{name,rules,ignores}`→config expansion stays
  inline in `eslint.config.ts` (it can't be a shared helper the barrels import).
  The existing `debug-logs` barrel already obeys this (only imports
  `@typescript-eslint/utils`, defines its rule inline) — mirror it byte-for-byte.
- **`discoverAllowDefaultProject` already covers `<plugin>/lint/*.ts`** (top-level
  files only — `allow-default-project.ts`), so rule files placed directly under
  each new `lint/` dir get TS-parse coverage with no config change. Keep them
  flat (no subdirectory).

## Plan

### 1. Create three lint-only plugins under the lint umbrella

For each, the new home is `plugins/framework/plugins/tooling/plugins/lint/plugins/<name>/`,
containing only a `lint/` dir + `package.json` (+ auto-generated `CLAUDE.md`).

**`promise-safety/`**
- `lint/no-bare-catch.ts` — moved verbatim from `lint/core/promise-safety/no-bare-catch.ts`
- `lint/no-floating-promises.ts` — moved verbatim from `lint/core/promise-safety/no-floating-promises.ts`
- `lint/index.ts`:
  ```ts
  import noBareCatch from "./no-bare-catch";
  import noFloatingPromises from "./no-floating-promises";

  export default {
    name: "promise-safety",
    rules: {
      "no-bare-catch": noBareCatch,
      "no-floating-promises": noFloatingPromises,
    },
  };
  ```
- `package.json`: `{ "name": "@singularity/plugin-framework-tooling-lint-promise-safety", "version": "0.0.1", "private": true, "description": "promise-safety lint rules (no-floating-promises, no-bare-catch)" }`

**`icon-safety/`**
- `lint/no-lucide-react.ts` — moved from `lint/core/icon-safety/no-lucide-react.ts`
- `lint/index.ts`: default-export `{ name: "icon-safety", rules: { "no-lucide-react": noLucideReact } }`
- `package.json`: name `@singularity/plugin-framework-tooling-lint-icon-safety`

**`reactive-server-io/`**
- `lint/no-reactive-server-io.ts` — moved from `lint/core/reactive-server-io/no-reactive-server-io.ts`
- `lint/index.ts`: default-export `{ name: "reactive-server-io", rules: { "no-reactive-server-io": noReactiveServerIo } }`
- `package.json`: name `@singularity/plugin-framework-tooling-lint-reactive-server-io`

> Package names verified against the boundary-check convention: intermediate
> `plugins` segments are dropped (e.g. `@singularity/plugin-framework-tooling-checks-allow-default-project`).
> Mirror `debug-logs` for the barrel shape — `{ name, rules, ignores? }`, no
> `@plugins/*` imports. (None of these three carry `ignores`.)

### 2. Strip the custom rules from `eslint.config.ts`

In `eslint.config.ts` (`baseConfigs[0]`):
- **Remove the import** `iconSafetyRules, promiseSafetyRules, reactiveServerIoRules`
  from `"./plugins/framework/plugins/tooling/plugins/lint/core"`. Keep
  `discoverAllowDefaultProject` (still used by `languageOptions`).
- **Remove the three plugin registrations** from `plugins:` —
  `"icon-safety"`, `"promise-safety"`, `"reactive-server-io"`. Keep
  `"@typescript-eslint"` and `"react-hooks"`.
- **Remove the four custom-rule severities** from `rules:` —
  `"icon-safety/no-lucide-react"`, `"promise-safety/no-floating-promises"`,
  `"promise-safety/no-bare-catch"`, `"reactive-server-io/no-reactive-server-io"`.
  Keep all `@typescript-eslint/*`, `react-hooks/*`, and built-in rules.
- Update the file's header doc comment (lines 15–16): the custom rules now live
  in their own `lint/plugins/<name>/` plugins and are auto-registered by the
  existing contribution loop, not in `baseConfigs`.

The existing contribution loop (`pluginConfigs`) already registers each
discovered plugin's namespace and turns on every contributed rule as `"error"`
repo-wide — so the three moved rules are re-enabled automatically with identical
severity. No new code path is added.

### 3. Clean up `lint/core`

- `lint/core/index.ts`: remove the three re-exports
  (`iconSafetyRules`, `promiseSafetyRules`, `reactiveServerIoRules`). Keep
  `lintCollectedDir`, `discoverAllowDefaultProject`, `findPluginDirs`.
- Delete the now-moved source dirs: `lint/core/promise-safety/`,
  `lint/core/icon-safety/`, `lint/core/reactive-server-io/`.
- Confirm nothing else imports the removed exports. Exploration found only
  `eslint.config.ts` consumed them; `discoverAllowDefaultProject`/`findPluginDirs`
  (kept) are also used by the `allow-default-project` check.

### 4. Regenerate + verify

- Run `./equin build`. This regenerates `lint.generated.ts` (adds the three
  new `lintEntries`), the three new `CLAUDE.md` files, and the `docs/plugins-*.md`.
- Commit all generated artifacts (required by `plugins-registry-in-sync` and
  `plugins-doc-in-sync`).

## Critical files

- `eslint.config.ts` — strip custom-rule imports/registrations/severities; keep parser, third-party, built-in, loop.
- `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` — drop three re-exports.
- `plugins/framework/plugins/tooling/plugins/lint/plugins/{promise-safety,icon-safety,reactive-server-io}/` — new plugins (lint barrel + moved rule files + package.json).
- Deleted: `lint/core/{promise-safety,icon-safety,reactive-server-io}/`.
- Generated (via build): `lint/core/lint.generated.ts`, new `CLAUDE.md`s, `docs/plugins-compact.md`, `docs/plugins-details.md`.

## Verification

1. `./equin build` succeeds; `lint.generated.ts` now lists all four lint
   entries (`debug-logs` + the three moved rules).
2. `./equin check --eslint` passes and still flags the moved rules. Sanity
   check enforcement end-to-end, e.g. temporarily add a `console`-free file with a
   bare `import { FaBeer } from "lucide-react"` and confirm `icon-safety/no-lucide-react`
   still errors; revert. (Or simpler: confirm the check output references the
   `promise-safety/`, `icon-safety/`, `reactive-server-io/` namespaces.)
3. `./equin check --plugin-boundaries` passes (new plugins have correct
   `package.json` names).
4. `./equin check` (all) is green — confirms `plugins-have-claudemd`,
   `plugins-registry-in-sync`, `plugins-doc-in-sync` are satisfied after committing
   generated files.
5. Confirm `eslint.config.ts` contains no reference to `promise-safety`,
   `icon-safety`, or `reactive-server-io` (`rg -n 'promise-safety|icon-safety|reactive-server-io' eslint.config.ts` → no matches).
