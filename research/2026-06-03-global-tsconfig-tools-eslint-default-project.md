# Plan: `tsconfig.tools.json` — give build-time files a real project, retire the ESLint default-project fallback

## Context

ESLint's type-aware rules need every linted `.ts/.tsx` to belong to *some* TypeScript
project. Files with no owning `tsconfig` — lint barrels (`plugins/**/lint/*.ts`),
plugin `scripts/*.ts`, root `*.config.ts`, plugin-root `*.config.ts` — currently fall
into typescript-eslint's **default-project** fallback. That fallback:

- builds an *inferred Program* per stray file, anchored on `defaultProject =
  web-core/tsconfig.app.json`, whose `include` covers **~1,507 files** → each of the
  ~11 stray files triggers a program over the entire web surface (the option is
  literally named `maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING`);
- has a hard upstream cap of 8 files; we already had to make the cap track the
  allowlist (`eslint.config.ts:42-43`) because each new lint-contributing plugin pushed
  it over;
- resolves stray Node/build files against the **DOM-flavored** web program (wrong libs);
- gives these files **no real `tsc` coverage at all** — `discoverTscTargets`
  (`.../checks/core/discover.ts`) only scans `plugins/framework/plugins/*`, so the
  `typescript` check never type-checks them.

This plan introduces a dedicated **`tsconfig.tools.json`** that owns the orphaned
build-time files, wires it into both the ESLint `projectService` and the `typescript`
check, relocates the 3 files shadowed by a nearer plugin config into that config, and
then **deletes** the now-obsolete `allowDefaultProject` machinery (cap + discovery
helper + `allow-default-project-in-sync` check).

Outcome: all build-time files get a correct, shared, fast Program; they gain genuine
`tsc --noEmit` validation for the first time; the slow default-project path and its
scaling cliff are gone, not just bounded.

## Discovery mechanism (why this works)

typescript-eslint's `projectService` resolves a file → project by finding the **nearest
`tsconfig.json`** walking up, then (if that config is a solution with `references`)
traversing references to find the project whose `include` matches. The repo *already*
relies on this: a file like `plugins/welcome/web/index.tsx` has no nearby config, so its
nearest config is the root `tsconfig.json`, which traverses `references → web-core →
tsconfig.app.json` (whose `include` matches). Adding `{ "path": "./tsconfig.tools.json" }`
to the root references makes orphan build-files resolve to the tools project the same
way. No `composite` needed (the existing references work without `tsc -b` on root).

**Shadowing caveat:** a stray file whose *nearest* `tsconfig.json` is a plugin config
that doesn't reference tools will NOT reach the root tools project. Three files hit this:

| Stray file | Nearest config (shadows root) | New home |
|---|---|---|
| `plugins/framework/plugins/server-core/scripts/backfill-pushes.ts` | `server-core/tsconfig.json` | add `scripts` to its `include` |
| `plugins/framework/plugins/tooling/plugins/checks/core/scripts/fix-shared-to-relative.ts` | `tooling/tsconfig.json` | add `plugins/*/core/scripts` to its `include` |
| `plugins/framework/plugins/web-core/vitest.config.ts` | `web-core/tsconfig.json` | add `vitest.config.ts` to `tsconfig.node.json` `include` (next to `vite.config.ts`) |

These three already have the right types/paths in their owning config (`server-core` &
`tooling` carry `@types/bun` + `@plugins/*`; `web-core/tsconfig.node.json` carries
`node`), and all three plugins are existing `tsc` targets (`server-core`, `tooling`
directly; `vitest.config.ts` via web-core's `tsc -b` in `vite build`, exactly like
`vite.config.ts` today). So relocation gives them real `tsc` coverage too.

The remaining **8 orphans** (no nearby config → root → tools): `eslint.config.ts`,
`plugins/debug/plugins/logs/lint/index.ts`, the two
`plugins/ui/.../typography/lint/*.ts`, `plugins/database/plugins/embedded/scripts/start.ts`,
`plugins/database/plugins/pgbouncer/scripts/start.ts`,
`plugins/ui/plugins/tweakcn/plugins/community-browser/scripts/fetch-catalog.ts`,
`plugins/database/plugins/migrations/drizzle.config.ts`.

## Changes

### 1. Create `tsconfig.tools.json` (repo root)

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node", "@types/bun"],          // scripts use fs/path + Bun.spawn/Bun.write
    "paths": {                                 // drizzle.config + fix-shared-to-relative use @plugins/*
      "@plugins/*": ["./plugins/*"],
      "@/*": ["./plugins/framework/plugins/web-core/web/*"]
    }
  },
  "exclude": ["**/node_modules"],
  "include": [
    "*.config.ts",
    "plugins/**/lint/*.ts",
    "plugins/**/scripts/*.ts",
    "plugins/**/*.config.ts"
  ]
}
```

Notes:
- Base already sets `module: ESNext`, `moduleResolution: bundler`, `strict`,
  `noEmit: true`, `skipLibCheck` — inherited, no override.
- The broad `include` globs harmlessly also match the 3 shadowed files and
  `vite.config.ts`; that's fine — `projectService` assigns each file to its *nearest*
  resolved project (the plugin config wins for those), and for `tsc -p
  tsconfig.tools.json` double-coverage just means tools also type-checks them (benign).
  If we want strictness, add the 4 to `exclude`, but it is not required.
- No `composite` — references discovery does not need it here.

### 2. Root `tsconfig.json` — register the project

Add to `references`:
```jsonc
{ "path": "./tsconfig.tools.json" }
```

### 3. Relocate the 3 shadowed files into their owning config's `include`

- `plugins/framework/plugins/server-core/tsconfig.json` → add `"scripts"` to `include`.
- `plugins/framework/plugins/tooling/tsconfig.json` → add `"plugins/*/core/scripts"` to
  `include` (covers `plugins/checks/core/scripts/`).
- `plugins/framework/plugins/web-core/tsconfig.node.json` → `include` becomes
  `["vite.config.ts", "vitest.config.ts"]`.

### 4. Wire `tsconfig.tools.json` into the `typescript` check

`plugins/framework/plugins/tooling/plugins/checks/core/discover.ts` —
`discoverTscTargets` currently scans only `plugins/framework/plugins/*`. Append an
explicit root target:

```ts
targets.push({
  name: "tools",
  dir: root,
  args: ["-p", "tsconfig.tools.json"],
  hasEntrypoint: false,   // build's runtime-tsc loop filters on hasEntrypoint and skips it;
                          // the `typescript` check runs ALL targets, so tools is checked there
});
```

This makes `./equin check --typescript` (and the check phase of `./equin
build`) run `tsc -p tsconfig.tools.json --noEmit`. `build.ts:708` filters
`hasEntrypoint`, so the build's separate entrypoint-tsc loop correctly ignores tools.

### 5. `eslint.config.ts` — drop the default-project machinery

- Remove the import of `discoverAllowDefaultProject` (keep the other lint-rule imports).
- Remove `const allowDefaultProject = …` and `const defaultProjectFileCap = …`
  (lines ~35-43, including the explanatory comment block).
- Replace the `projectService` object with the boolean form:

```ts
parserOptions: {
  ecmaVersion: "latest",
  sourceType: "module",
  projectService: true,    // every file must resolve to a real project; unowned → loud error
  tsconfigRootDir: here,
},
```

With no `allowDefaultProject`, any file that fails to resolve to a project now errors
loudly (the verification gate, below) instead of silently using the slow fallback.

### 6. Remove the obsolete discovery helper + export

- `plugins/framework/plugins/tooling/plugins/lint/core/allow-default-project.ts` —
  delete `discoverAllowDefaultProject` and its only-private helper
  `isInLocalTsconfigInclude`. **Keep** `walkPluginTree` and `findPluginDirs` (used for
  lint-rule discovery elsewhere). Consider renaming the file to `plugin-dirs.ts` since it
  no longer concerns allow-default-project (optional; verify importers first).
- `plugins/framework/plugins/tooling/plugins/lint/core/index.ts` — drop
  `discoverAllowDefaultProject` from the re-export (keep `findPluginDirs`).

### 7. Delete the `allow-default-project-in-sync` check

Its sole purpose is to assert `allowDefaultProject ∩ tsconfig-covered = ∅`. With the
allowlist gone, it's dead.

- Delete `plugins/framework/plugins/tooling/plugins/checks/plugins/allow-default-project/`.
- `./equin build` regenerates `check.generated.ts` (drops the registration) and
  `plugins-doc-in-sync` docs. Do NOT hand-edit the generated registry.

## Critical files

| File | Action |
|---|---|
| `tsconfig.tools.json` | **create** |
| `tsconfig.json` (root) | add tools reference |
| `plugins/framework/plugins/server-core/tsconfig.json` | `include += "scripts"` |
| `plugins/framework/plugins/tooling/tsconfig.json` | `include += "plugins/*/core/scripts"` |
| `plugins/framework/plugins/web-core/tsconfig.node.json` | `include += "vitest.config.ts"` |
| `plugins/framework/plugins/tooling/plugins/checks/core/discover.ts` | append tools target |
| `eslint.config.ts` | drop allowlist+cap, `projectService: true` |
| `.../tooling/plugins/lint/core/allow-default-project.ts` | remove discover fn + helper |
| `.../tooling/plugins/lint/core/index.ts` | drop export |
| `.../checks/plugins/allow-default-project/` | **delete** (regenerate registry) |

## Verification (end-to-end)

Run from the worktree root. **The ESLint pass is the load-bearing gate** — with
`projectService: true` and no allowlist, any file not owned by a project errors with
`"… was not found by the project service"`.

1. **Tools project type-checks** (first-ever `tsc` coverage may surface latent errors —
   unused locals, `noUncheckedIndexedAccess`, etc. — fix them):
   ```bash
   bunx tsc -p tsconfig.tools.json --noEmit
   ```
2. **Relocated files type-check** in their new home:
   ```bash
   bunx tsc -p plugins/framework/plugins/server-core/tsconfig.json --noEmit
   bunx tsc -p plugins/framework/plugins/tooling/tsconfig.json --noEmit
   ```
   (`vitest.config.ts` is covered by web-core's `tsc -b` during the build.)
3. **ESLint resolves every file to a project** (no default-project, no orphan errors):
   ```bash
   bunx eslint .
   ```
   If any file reports "not found by the project service", add it to the appropriate
   config's `include` (or, fallback, re-add a *minimal* `allowDefaultProject` for just
   that residual set — see Risks).
4. **Full check suite** — confirms `allow-default-project-in-sync` is gone, docs regen
   clean, `typescript` check now includes the tools target:
   ```bash
   ./equin check
   ```
5. **Build** — regenerates `check.generated.ts` / docs and confirms a clean deploy:
   ```bash
   ./equin build
   ```
6. **Sanity on the win**: editing a lint barrel / `*.config.ts` and re-running
   `bunx eslint <that file>` no longer drags in the ~1,500-file web program (observably
   faster; tools program is tiny).

## Risks & fallbacks

- **`projectService` doesn't discover tools for an orphan.** Mitigation: the root
  reference uses the same traversal that already maps web/server/central plugin files.
  If a specific orphan still misses, its nearest config is shadowing it (add it there) —
  the eslint error names the file. Hard fallback: keep a minimal `allowDefaultProject`
  for the residual set and point `defaultProject` at a *small* node-only tsconfig
  (degrades to "Lever A", still removes the 1,500-file program). Document whatever
  remains.
- **Latent `tsc` errors in newly-covered files.** Expected and desirable — these files
  were never `tsc`-checked. Budget a small fixup pass (step 1/2). If a fix is genuinely
  out of scope, narrow the tools `include` for that file and note it.
- **Removing a check requires regeneration**, not a hand edit — always via
  `./equin build` (regenerates `check.generated.ts`).
- **`findPluginDirs` / `walkPluginTree` must survive** the helper-file edit — they're
  used for lint-rule discovery, unrelated to the allowlist. Grep importers before
  deleting/renaming.
