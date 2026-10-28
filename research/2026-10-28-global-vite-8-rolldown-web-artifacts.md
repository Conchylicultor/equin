# Vite 8 (Rolldown) for the web-artifacts pipeline

## Context

Vite 8 replaces Rollup + esbuild with Rolldown + Oxc. A 2026-10-27 bump
(att-1792990864-go2iih) passed every check and test but `./equin build` failed in
`plugins/framework/plugins/tooling/plugins/web-artifacts`:

1. every artifact lacked `index.js.map` → `web-artifacts:no-vendored-state-inlined`
   threw (its vendored-module scan reads the sourcemap `sources`);
2. `web-artifacts:own-folder-barrel` threw on `database/plugins/migrations`'
   **lint** artifact (`lint/no-adhoc-drizzle-cli.ts` → `../core/internal/drizzle-cli`).

Vite is held `<8.0.0` in the root `dependencyPolicy` (task-1793076624-k9ljr5).
`@vitejs/plugin-react` 6 (held, task-1793076072-gwttlf) needs Vite 8.

## Findings so far (scratch repro, /tmp, vite 8.3.5)

- `@vitejs/plugin-react` **5.2.0 peers `vite ^8`** — the Babel/React-Compiler
  path keeps working; the Vite move does NOT require plugin-react 6. The two
  holds are independent: only the plugin-react reason text changes.
- A minimal lib build with the pipeline's shape (`sourcemap: true`,
  `cssCodeSplit`, a `generateBundle` that appends to `chunk.code`) DOES emit
  `index.js.map`. So failure 1 is triggered by something specific to the real
  builder config (candidates: the `esbuild` option / `minify: "esbuild"` route —
  under Vite 8 esbuild is a post-step whose map handling differs; the worker
  sub-build; `chunk.code` mutation without `chunk.map` once minified).
- No `lint` or `tooling/lint` artifact has EVER been in the store (6 060 dirs:
  only `web`, `core`, `entry`, `registry`, `browser-host`). So failure 2 is not
  the guard misreading a path — the **barrel closure grew**: under Rolldown some
  emitted module now carries an `@plugins/…/lint` specifier (most likely the
  `tooling/lint/core` barrel — `lint.generated.ts` is a list of
  `() => import("@plugins/<p>/lint")` — reached through an import Rollup
  tree-shook/dropped and Rolldown/Oxc keeps, e.g. an `import { type X }`
  elision difference or a side-effect-free barrel not pruned). The lint
  artifact then builds and the guard correctly refuses its deep import.
  The guard is right; the closure is wrong.

## Plan

1. **Bump** `vite` to `^8.3.5` in every declaring package.json
   (`web-artifacts`, `web-core`, `primitives/css/layout-harness`); drop the
   `vite` entry from the root `dependencyPolicy`; update the plugin-react hold's
   reason (no longer blocked on Vite).
2. **Migrate the config surface to Vite 8 names** (everywhere `viteBuild` is
   called: `vite-builder.ts`, `browser-hosts.ts`, `global-css.ts`,
   `vendors.ts`, web-core's vite contributions): `build.rollupOptions` →
   `build.rolldownOptions`; `esbuild: { keepNames }` → Rolldown's
   `output.keepNames`; `minify: "esbuild"` → Oxc (the default minifier) — the
   artifact hash identity (`BUILDER_VERSION`) bumps so no Rollup-built artifact
   is mixed with Rolldown ones.
3. **Failure 1 (sourcemaps)** — reproduce on the real pipeline (build one
   artifact), find which option drops the map, fix at the config. Keep the
   check's hard failure: the builder must emit a map for every artifact, so
   also assert it in `buildArtifact` (fail at build of THAT artifact, rung 4)
   instead of discovering it later in the check.
4. **Failure 2 (closure)** — dump the emitted module that carries the
   `@plugins/…/lint` specifier, find why it survives under Rolldown, fix at the
   cause (tree-shaking/type-import elision config, or the import in source).
   If the cause is a dynamic `lint` import reached by the browser legitimately,
   declare `lint` browser-unreachable like `prewarm` — `lint/` is a leaf folder,
   never an import target, so a lint artifact is never a real browser load.
5. Run `./equin check`, the web-artifacts tests, `./equin build`; screenshot
   the deployed app; compare boot bundle sizes against main's.

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`
- `./equin check` (incl. `web-artifacts:no-vendored-state-inlined`, deps policy)
- `./equin build` green; app loads at the worktree URL (screenshot), no console
  errors; React Compiler still active.

## Outcome (root causes, confirmed on the real pipeline)

1. **No `index.js.map`** — only for multi-entry artifacts (`web` + co-built
   `exhibits`). Rolldown emits `index.js` as a pure re-export facade over the
   shared chunk and, correctly, gives a facade no map (Rollup kept code in it).
   The check also only ever scanned `index.js.map`, missing modules inlined
   into shared/lazy `.mjs` chunks and `exhibits.js`. Fix:
   `core/internal/sourcemaps.ts` — `artifactSourcemaps` lists every module's
   map, allows a map-less module only if it is a pure re-export facade, throws
   otherwise; the builder asserts it per artifact, the check scans every map
   (scan cache version bumped).
2. **lint artifact** — `facets/core/load-facets.ts` held
   `import("./facet.generated")` in a `const` so the bundler could not see it.
   Oxc/Rolldown folds the constant, so the closure followed it: every `facet/`
   barrel → codegen/core → `lint/core`'s `lint.generated` → every `lint/`
   barrel, built as artifacts, and migrations' lint barrel deep-imports its
   core. Fix: `BROWSER_UNREACHABLE_DYNAMIC_KINDS` is derived — every leaf
   folder (`LEAF_FOLDERS`) but the co-built ones (`exhibits`). A leaf is never
   an import target, so its only dynamic importers are collected-dir
   registries run Bun-side. The variable specifier stays: it also hides the
   edge from the repo's own static import-closure analysis
   (`cli:codegen-manifests-not-frozen` fails without it).

Config spellings, follow-up: every `viteBuild` moved to the Vite 8 names —
`rolldownOptions`, `minify: "oxc"`, and `esbuild: { keepNames }` replaced by
the Oxc minifier's own `compress`/`mangle` `keepNames` (main and worker
passes). Rolldown's `output.keepNames` was tried first: it emits its `__name`
helper as a separate `rolldown-runtime-*.mjs` chunk (no source, so no map —
the new sourcemap guard rejected it — and one more request per split
artifact). Vite's ES-lib preset
for Oxc is compress + mangle without whitespace, like esbuild's. Compared on
five real artifacts (adaptive-bar web with exhibits, conversations web, tasks
web, live core/web): identical imports, dynamic imports and export names;
4–8 % smaller gzipped; function/class names kept natively (Oxc does not mangle
them) instead of through esbuild's `defineProperty(fn, "name")` helper.
plugin-react 5.2 peers Vite 8, so the Babel/React-Compiler path is unchanged.
