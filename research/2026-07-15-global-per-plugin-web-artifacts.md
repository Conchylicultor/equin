# Per-plugin web build artifacts + import-map composition

## Context

`./equin build` is O(repo): the monolithic Vite/Rollup build re-transforms **6,745 modules on every build** regardless of the diff. Measured over recorded profiles (60 builds / 7 days):

- `viteBuild` is the critical path of virtually every build: **150s idle (main), 525s median (agent), 1,660s worst** — out of a 7.2-min median build.
- ~71 builds/day × ~all-unchanged modules ≈ **129 wall-hours/week** of mostly redundant transforms; this fleet-wide CPU pressure is also what inflates checks (55–110s wall for 2–5s checks) and produces the 20–38 min tail builds.
- A typical agent diff touches **1–3 plugins**; waste ratio ≈ 99.8%.

**Target: build cost O(changed plugins).** Each plugin builds into an independent ES-module artifact; the browser composes them via an import map. A change to plugin A rebuilds only A's artifact (late-bound exports ⇒ no rebuild cascade). Artifacts are content-addressed and shared across worktrees, so a fresh worktree (branched off main) reuses ~everything: cold build ≈ warm build.

**Decisions made with the user (2026-07-15):**
- **Scope:** agent worktrees **and** main-branch builds switch to artifact mode. Release/composition builds (`./equin release`, `--composition`) keep the monolithic optimized Rollup build unchanged.
- **Rollout:** land behind an opt-in (`SINGULARITY_WEB_ARTIFACTS=1` / `--artifacts`), prove parity, then flip the default with `--monolith` as escape hatch.
- **Minify:** supported and **on by default** (artifacts will eventually serve remote deploys); esbuild minify with `keepNames: true` (parity with today's `esbuild: { keepNames: true }`). `--no-minify` for debugging. The minify flag is part of the artifact hash.

Related, independent work: per-check read-set caching (`task-1783767461575-5nnchp`) and moving push checks out of the push flock. This doc is only the frontend build.

## Why this repo is unusually ready for this

- **Cross-plugin imports are already only barrels** (`@plugins/<path>/{web,core}`), no deep paths, no cycles (DAG), enforced by `plugin-boundaries`. The externals rule below is the boundary grammar expressed to the bundler.
- **The runtime already loads every plugin via a generated dynamic-import registry** — `web.generated.ts` entries `{ pluginPath, id, loader: () => import("@plugins/…/web"), dependsOn }`, consumed by `App.tsx` → `loadPlugins` → client-side topo sort (`web-sdk/core/{loader.ts,topo.ts,context.tsx}`). Retargeting `import()` at bare specifiers resolved by an import map changes nothing in the loader.
- **Slot contributions (the DI system) create no build-time edges** — A contributing into B's slot never makes B's artifact depend on A. Only the barrel-import DAG matters, and it's already generated (`dependsOn` from real import statements, `plugin-registry-gen.ts`).
- **Vite-feature surface in plugin code is tiny** (audited 2026-07-15): `import.meta.env` → only `VITE_BUILD_ID` (3 uses) + `DEV` (3 uses); **no** `import.meta.glob`, **no** `?url/?raw/?worker`, **no** web workers/wasm, **no** asset imports from TS. The only real feature: **~15 CSS imports from TS**, incl. npm package CSS (`@xterm/xterm/css/xterm.css`, `react-diff-view/style/index.css`, `@xyflow/react/dist/style.css`, `katex/dist/katex.min.css` → woff2 fonts) and plugin-local files (`loading.css`, `diff-view.css`, `reorder/web/styles.css`, sonata/mail/pages locals).

## Design

### 1. Artifact model & externals rule

One artifact per **imported barrel specifier**:

- `@plugins/<path>/web` — every web entry (~640).
- `@plugins/<path>/core` — only for core barrels actually imported cross-plugin (computable from the import scan).
- A plugin's private files (web internals, its own `shared/`, own-core *internal* files) are **inlined** into its artifact. Its own core *barrel*, when also imported by others, stays external (one URL = one module instance; core barrels can hold module state).

Externals: **everything that is not the plugin's own files** — all `@plugins/*` specifiers and all bare npm specifiers stay verbatim in the emitted JS; the import map resolves them. This is what preserves module identity (React contexts, `web-sdk/core` slot registries + `PluginRuntimeContext`, live-state client singleton, `scoped-store`, deferred-load store — enumerated in the 2026-07-15 loader exploration) and what makes rebuilds cascade-free.

### 2. Vendor artifacts (npm) + inline allowlist

- Needed vendor specifier set = union of bare imports (per subpath: `react-dom/client` ≠ `react-dom`) found by the same import scan that computes `dependsOn` (`plugin-registry-gen.ts` `findImports` — extend to record bare specifiers, it currently keeps only `@plugins/*`).
- Each specifier pre-bundles to one ESM vendor artifact (esbuild, platform `browser`, CJS→ESM interop — the same mechanics as Vite `optimizeDeps`), content-addressed by `(package version from bun.lock, esbuild version, flags)`. Built lazily on first need, cached in the shared store. `react`/`react-dom`/`scheduler` are just three such artifacts — the singleton guarantee is the import map itself.
- **Inline allowlist** (packages bundled *into* consumers instead of vendored): provably-stateless packages where whole-package vendoring is harmful. Initial list: `react-icons/*` (full `react-icons/md` ≈ 2 MB; monolith tree-shakes to the used union; icons are pure so per-plugin inlining + tree-shaking is safe). Declared as a constant in the new plugin's `core/`; guarded by a check (§ Checks).
- Package CSS imported from TS is handled by the per-plugin builder like local CSS (§4) — the vendor artifact never includes CSS.

### 3. Content-addressed store, hashing, changed-plugin detection

- Store: `~/.singularity/web-artifacts/<plugin-slug>/<hash>/` (dir per artifact: `index.js`, optional emitted assets). Naming via `PluginId` encodings (`framework/plugin-id`). Prune by age+count exactly like `checks/core/cache.ts` (14d / bounded entries).
- Hash inputs: the plugin's **own** source files (its `web/` + `shared/` + own `core/` reachable set), builder version constant, minify flag, babel-contribution versions, versions of inlined packages. NOT other plugins' contents (late binding — that's the whole point).
- Fast path per build: stat-fingerprint (mtimeMs,size) walk à la `infra/corpus-index` to skip unchanged plugins without hashing content; content hash only for plugins whose fingerprint moved. Optional cross-check: `findPluginPath` longest-prefix mapping from `git diff --name-only` (promote from `review/plugin-changes/server/internal/compute-plugin-diff.ts` into a shared helper).

### 4. Per-plugin builder

**Vite programmatic `build()` in lib mode, in-process, one Rollup graph per plugin**, parallel under a semaphore. Chosen over a bespoke esbuild+babel pipeline for v1 because it reuses today's exact semantics for free: `@vitejs/plugin-react` with the discovered babel contributions (`findViteContributions` — react-compiler at order −100, element-picker JSX stamping), CSS imports (local + npm + katex fonts), `define`. An esbuild fast path can come later if per-plugin latency warrants.

- Config per artifact: `entry = <barrel>`, `external = (id) => id.startsWith("@plugins/") || isBareSpecifier(id) && !inlineAllowlist(id)`, `define = { "import.meta.env.DEV": "false" }` (build-id removed, §6), esbuild `keepNames`, minify per flag, **no** `@tailwindcss/vite` plugin, sourcemaps on.
- **CSS strategy for plugin-local/package CSS:** inject-from-JS (css-injected-by-js) so an artifact's styles load atomically with its module — no per-artifact `<link>` bookkeeping, correct for lazy loads. Tailwind utilities are NOT in these files (global pass, §5).
- Parallelism: `packages/semaphore` in-process (~`cpus/2`), demoted via `spawn-priority` rules matching the existing branch lane logic. Cold full fleet (~640 web + ~core barrels): est. 2–5 min once per builder-version bump per host; typical build: 1–3 artifacts ≈ **<5s**.

### 5. Global CSS stays global (v1)

One Tailwind v4 pass (app.css `@source "plugins/" + "prototypes/"` — `primitives/css/ui-kit/web/theme/app.css`) emits the single global stylesheet, linked from index.html as today. This keeps `tailwind-scan-covers-classes` and `css-vars-single-owner` invariants untouched. Cost ~1–3s (oxide scanner), accepted O(repo)-but-cheap in v1; candidate for read-set caching later. Runtime theme injection (`ThemeInjector` + index.html replay script) is unaffected.

### 6. Compose step (per build)

Replaces `bun run build` in artifact mode:

1. Ensure changed artifacts + needed vendors are built (§3–4).
2. Generate the **registry artifact**: compile `web.generated.ts` (or the composition-filtered variant) with all `@plugins/*` external — its `loader: () => import("@plugins/…/web")` dynamic imports survive as bare specifiers. The `@composition-web-registry` Vite alias seam becomes an **import-map entry** pointing at this artifact.
3. Generate the **entry artifact** (`web-core/web/main.tsx` + `App.tsx`, own files inlined, everything else external).
4. Emit `dist/index.html` from `web-core/web/index.html`: keep the two inline pre-React scripts (theme replay, DevTools hook), inject inline `<script type="importmap">` (must be inline; ~700 entries ≈ tens of KB — fine), global CSS `<link>`, entry `<script type="module">`, and `<link rel="modulepreload">` for the **eager-tier closure** (from `web-tiers.generated.ts` + `dependsOn` — a boot-latency win the monolith never had; avoids bare-import waterfall).
5. **Symlink** artifacts into `dist/artifacts/` from the shared store, then verify **every mapped URL resolves to a real file** (hard-fail otherwise — the gateway's SPA fallback would otherwise serve index.html for a missing artifact and surface as a cryptic module-parse error).
6. Existing staging → `dist.live.<pid>` → atomic symlink-swap publish in `build.ts` is reused unchanged; gateway (`gateway/proxy.go handleStatic`) serves `dist/` as-is — `http.ServeFile` follows symlinks. Optional hardening (Phase 2): a 404 branch for `/artifacts/*` misses instead of SPA fallback.

### 7. Build-id / stale-tab detection

`import.meta.env.VITE_BUILD_ID` baked per-module breaks content addressing (every build would churn every hash). Replace: compose step injects `window.__SINGULARITY_BUILD_ID__` via an inline script in index.html (monolith mode: same inline script, injected by a tiny Vite html transform, so both modes share one mechanism). Update the single consumer `plugins/build/web/hooks/use-stale-frontend.ts` (+ drop the `define` in `vite.config.ts`).

## What does NOT change

- Loader/topo/slot runtime (`web-sdk/core`), eager/deferred tiers, boot-snapshot flow.
- Server builds (none — server runs from source), checks, migrations, codegen steps.
- Release/composition builds and `serve-app.ts` (monolith path preserved verbatim).
- Gateway routing/spec mechanism (`writeWorktreeSpec` with `web: livePath`).

## Implementation phases

### Phase 1 — engine + opt-in (landable alone)

New plugin `plugins/framework/plugins/tooling/plugins/web-artifacts/`:
- `core/`: builder (vite lib-mode wrapper), vendor pre-bundler, store/hash/fingerprint (reuse `corpus-index` patterns + `check-cache` pruning shape), compose step (import map, index.html, registry+entry artifacts, symlinks, URL-existence verification), inline-allowlist constant, builder-version constant.
- Integration: `build.ts` branches on `SINGULARITY_WEB_ARTIFACTS=1` / `--artifacts` (agent + main builds only; release path untouched): skips `bun run build`, runs global Tailwind pass + compose. Profiler spans per stage (`buildProfilerStart`: `artifacts:detect`, `artifacts:build` (+count), `artifacts:vendors`, `artifacts:css`, `artifacts:compose`).
- Extend `plugin-registry-gen.ts` `findImports` collection to also record bare npm specifiers (vendor set input).
- Files: `plugins/framework/plugins/cli/bin/commands/build.ts`, `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`, new plugin tree.

### Phase 2 — parity, hardening, checks

- Build-id refactor (§7): `plugins/build/web/hooks/use-stale-frontend.ts`, `web-core/vite.config.ts`, compose step.
- Eager-tier `modulepreload` emission (§6.4).
- Gateway 404-for-`/artifacts/*` branch (`gateway/proxy.go handleStatic`, ~10 lines).
- New checks (standard `check/index.ts` template, cf. `eager-tier-in-sync`):
  - `web-artifacts:map-in-sync` — recompute expected map vs composed one.
  - `web-artifacts:no-vendored-state-inlined` — no non-allowlisted package's modules inside a plugin artifact (scan emitted bundles for package markers). Makes the singleton class structurally guarded, not trusted.
- Parity verification (see Verification) on several real worktrees + main.

### Phase 3 — flip default

- Artifact mode becomes the default for agent-branch **and** main builds; `--monolith` escape hatch. Release/composition unchanged.
- Docs: `web-core/CLAUDE.md`, root `CLAUDE.md` build section, `docs/` regen.
- Record before/after build-time numbers from the build profiler.

## Verification

1. **Boot parity (the real gate):** build a worktree with `--artifacts`, then drive it with `e2e/screenshot.mjs` — assert zero entries in the plugin load-error surface (`web-core/components/plugin-load-errors.tsx` / deferred-load store `failedPluginPaths`), zero console errors, boot-snapshot resolves every bootCritical key (loud crash report if not — existing invariant), and screenshots of 3–4 heavyweight panes (tasks, pages editor, sonata, mail) match monolith behavior.
2. **Singleton proof:** open two plugins sharing a context/scoped-store path (e.g. pane + sync-status) and exercise them; any duplicated-module regression shows as the silent-default-context failure — covered by the pane screenshots plus one targeted flow.
3. **Incrementality proof:** touch one plugin file → rebuild → exactly one artifact rebuilds (profiler span count), build wall time seconds; touch nothing → zero artifact builds.
4. **Cross-worktree reuse:** fresh worktree off main → first `--artifacts` build reuses store (0 or near-0 builds).
5. **Stale-tab flow:** deploy twice, confirm the stale-frontend toast still fires (build-id refactor).
6. **Unit tests (`bun:test`, co-located):** hash stability/sensitivity (content change ⇒ new hash; sibling-plugin change ⇒ same hash), import-map generation, allowlist externals function.
7. Existing suites still pass: `bun run test:dom` (plugin-render smoke), `./equin check`.

## Risks & mitigations

- **CSS injection order** for the ~15 component CSS files changes (JS-injected `<style>` vs today's link order). Low risk (component-scoped rules); verified by pane screenshots.
- **Import-map browser support:** fine everywhere modern incl. WKWebView ≥ 16.4 (Tauri shell).
- **Missing artifact ⇒ SPA fallback HTML:** compose-time URL verification (hard fail) + Phase 2 gateway 404 branch.
- **Vendor CJS interop edge cases:** same mechanics Vite dev uses on this exact dependency set daily; lazy-build + cache makes fixes cheap.
- **Store poisoning/staleness:** hash includes builder version — bump invalidates fleet; `--monolith` always available.
- **Main on artifacts** (user-accepted): main's daily-driver app serves artifact composition; minify-by-default keeps output production-shaped; release artifacts stay monolithic.

## Phase 1 outcome (2026-07-16)

Phase 1 landed behind the opt-in (`--artifacts` / `SINGULARITY_WEB_ARTIFACTS=1`; `--no-minify` for debugging). Engine: `plugins/framework/plugins/tooling/plugins/web-artifacts/core/` (pure helpers `constants/externals/hash/import-map` + `internal/{own-files,store,identity,vite-builder,vendors,global-css,compose,pipeline}`); shared babel-contribution discovery factored into `plugins/framework/plugins/web-core/core/vite-contributions.ts` (new core barrel, imported relatively by `vite.config.ts`); `plugin-registry-gen.ts` gained `collectBareSpecifiers()` (emitted registry byte-identical); `build.ts` swaps only the vite step and reuses the staging → atomic-publish flow, with profiler spans `artifacts:{detect,build,vendors,css,compose}`.

**Measured (this worktree, M-series host, 2026-07-16):**

- Cold fleet: **924 artifacts** (707 web + 215 folder barrels + entry + registry) ≈ **150s** artifact-build stage standalone (in-process vite lib builds, semaphore cpus/2); ~236s when racing the full check fleet inside `./equin build`.
- Warm no-op `SINGULARITY_WEB_ARTIFACTS=1 ./equin build`: **0 built / 924 reused**, web-artifacts step **6.9–8.9s** (detect ~0.7s stat fingerprints; global css ~5–7s dominates).
- One-file touch through the real build command: detect reports exactly **1 stale**, 1 built / 923 reused, web-artifacts step **8.0s** — vs the monolith's `vite build` step at **209.4s** on the same host, same session.
- Vendor set: 62 specifiers ≈ 5–10s cold (ONE esbuild build), cached by set hash thereafter.
- Import map ~985 entries; eager-tier modulepreload closure ~872 URLs (emitted in Phase 1, ahead of plan §6.4).
- Boot parity (Playwright over tasks / pages / mail / sonata): **0 console errors, 0 entries in the plugin load-error surface**, live data renders on all four panes; the only request failures are the `/api/logs/emit` aborts also present on the monolith main app (baseline noise). Browser log channels clean.

**Bugs the parity gate caught (both fixed in Phase 1, both invisible to compose-time verification):**

- **Own-core dual instance:** `live-state/web` re-exported its descriptor registry via a relative deep import (`../core/resource`), inlining a second copy of the registry next to the shared core artifact — boot-snapshot resolved zero descriptors and config_v2's identity-compared descriptors stopped matching. Fix: the builder rewrites EVERY own-core import of web/shared code (barrel, deep relative, deep alias) to the external `@plugins/<p>/core` barrel, so no core file can ever be inlined into a sibling artifact. A deep-imported symbol the barrel doesn't re-export fails loudly as a missing export; two barrels needed additions (`conversations/agents`, `primitives/log-channels`).
- **CJS vendor interop:** the named-export wrapper destructured the interop default, which is `exports.default` (undefined) for `__esModule`-marked transpiled packages (`@tonejs/midi`). Fix: plain re-export form (`export { X } from "pkg"`), which esbuild lowers to interop property access correct for both CJS flavors.

**Deviations from the design above (all deliberate):**

1. **Own core barrel is ALWAYS externalized**, not only when cross-imported — keeps every artifact hash a pure function of the plugin's own files (no global "is my core cross-imported" bit) and structurally rules out dual-instance core state. Relative own-core-barrel imports are rewritten to the canonical `@plugins/<path>/core` specifier at resolve time.
2. **Vendors are ONE esbuild multi-entry build with `splitting: true`** (optimizeDeps-exact), not one isolated bundle per specifier: marking a CJS `require()` external emits a browser-fatal `__require` shim, and per-spec bundles would duplicate stateful transitives (`scheduler`). Shared transitives live in shared chunks (module identity preserved); content-addressed by the SET (sorted spec + resolved version + interop wrapper list + esbuild version + flags). CJS named exports are enumerated with `cjs-module-lexer` into explicit re-export wrappers.
3. **Core/vendor sets derive from EMITTED artifact imports** (post-tree-shaking, type-stripped, recorded in each artifact's `meta.json`), not the source scan — `import type` edges never force an artifact. The closure generalizes to any statically imported single-segment folder barrel (`core`, `fixtures`, …). `collectBareSpecifiers` remains as the source-level cross-check input for the Phase-2 `map-in-sync` check.
4. **Build-id refactor (§7) pulled into Phase 1** — unavoidable, not optional: a per-module `VITE_BUILD_ID` define would churn every artifact hash every build. Artifacts compile `import.meta.env.VITE_BUILD_ID` to the global identifier `__SINGULARITY_BUILD_ID__`, declared by an inline script the compose step injects into index.html; `use-stale-frontend` works unchanged in both modes (monolith keeps the JSON define).

**Known Phase-1 costs (accepted):**

- No cross-artifact tree-shaking: a core barrel ships whole (e.g. schema cores pull `drizzle-orm/pg-core` into the vendor set ≈ browser bytes the monolith would have shaken). Bytes, not correctness.
- 5 unmapped DYNAMIC imports warn at compose (sonata `prewarm` registries via asset-mirror core, layout-harness `fixtures`) — release/debug-time loaders never invoked in the browser; static-import coverage and the registry's dynamic imports are verified hard-fail.
- Heavy toolchain imports (vite ~0.6s, tailwind ~1.3s) are lazy inside the plugin so plain CLI startup stays fast (barrel import ~74ms).
- In-process artifact builds are not `darwinbg`-demoted (the monolith's child-process demotion doesn't apply); acceptable while opt-in.

**Phase 2 hand-off (beyond the items already listed above):**

- `web-artifacts:map-in-sync` check built on `collectBareSpecifiers` + the composed map.
- `web-artifacts:no-vendored-state-inlined` check (scan artifacts for non-allowlisted package markers).
- Gateway 404-for-`/artifacts/*` branch (`gateway/proxy.go handleStatic`).
- Global CSS pass caching (read-set keyed) — it is now the dominant warm-build cost (~7s of ~14s).
- Consider demoting in-process artifact builds on agent branches (thread QoS or worker processes).
- Store notes: `~/.singularity/web-artifacts/{store,vendors,fingerprints}`, age+count pruning, `BUILDER_VERSION` (currently 3) invalidates the fleet on builder-semantics changes.

## Phase 2 outcome (2026-07-16)

All four hardening items landed:

1. **`web-artifacts:map-in-sync` check** (`web-artifacts/check/index.ts`). Detects an artifact-mode dist by the compose-emitted `.web-artifacts.json` marker (now also recording `minify`, so the check recomputes with the dist's own flag); a monolith dist passes. It recomputes the EXACT expected composition — the pipeline's planning was factored into `core/internal/plan.ts` (target hashing, barrel closure, vendor requests, map-entry assembly) shared verbatim by the pipeline and `core/internal/expected.ts`, so expected vs deployed cannot drift by construction. `collectBareSpecifiers` was deliberately NOT used as the verdict input: the source scan includes `import type` edges the emitted artifacts tree-shake away, so it over-approximates the vendor set and would false-fail; the exact recompute is strictly stronger. Two failure shapes: URL diff (`stale artifact` / missing / extra specifiers, stale entry script) and `missing-artifacts` (an expected artifact absent from the store ⇒ the dist predates the tree). Both verified by break-glass (hand-edited map; unbuilt source edit).
   - **Build-race resolution (plan assumption that broke):** checks run in parallel with the frontend build, BEFORE the atomic publish — a dist-vs-tree check would fail every build that changes source. New `markBuildInProgress()`/`isBuildInProgress()` in `checks/core/run-context.ts` (env marker set at the top of the build action): map-in-sync skips inside a build and returns `null` from `cacheSignature()` so the skip is never cached. `push` re-runs checks in a fresh subprocess and standalone `./equin check` in its own process — both verify for real. Its `cacheSignature` otherwise folds in dist index.html + marker + store mtime, so a hand-edited dist can't hide behind the tree-hash cache.
2. **`web-artifacts:no-vendored-state-inlined` check** (same `check/index.ts`). Signal: sourcemap `sources` — `meta.staticImports` records only what stayed EXTERNAL, so it cannot see inlined modules, while every module bundled INTO an artifact appears in `sources` (the builder emits sourcemaps unconditionally). Scans the current tree's expected fleet (artifacts not yet in the store are skipped — staleness is map-in-sync's job; empty store ⇒ pass). A full-store scan measured 13s/3.4GB, so verdicts persist per artifact dir in `~/.singularity/web-artifacts/vendored-scan.json` (content-addressed dirs ⇒ immutable verdicts; stored unfiltered so an allowlist edit re-filters without re-scanning) — warm runs are ~ms. Fleet reality check: 923 artifacts scanned, the only node_modules package inlined anywhere is `react-icons` (the allowlist). Break-glass verified via a poisoned verdict (fails naming artifact + package) and unit tests.
3. **Gateway `/artifacts/*` 404** (`gateway/proxy.go` `handleStatic`): a miss under `/artifacts/` — including a dangling store symlink — returns 404 instead of the SPA fallback (which handed the module loader index.html and surfaced as a cryptic parse error). 3 new tests in `proxy_test.go` (hit serves file, miss 404s, non-artifact routes keep the fallback); `go build`/`go vet`/`go test` clean. **Takes effect on the next gateway restart** (not restarted here).
4. **Global-CSS pass caching** (`core/internal/global-css.ts`): the emitted stylesheet + font assets are cached content-addressed under `~/.singularity/web-artifacts/css/`, keyed by a fingerprint of the pass's TRUE input surface — Tailwind v4's automatic source detection scans the vite root (= repo root, honoring gitignore), so the key covers the git-enumerated worktree file set (tracked ∪ untracked-not-ignored) ∪ the `@source` dirs parsed from app.css (not hardcoded; covers them even if gitignored) + `@import` package versions (relative imports: content hash) + vite/tailwindcss/@tailwindcss/vite versions + minify + `BUILDER_VERSION`. Content hashing rides the shared stat-fingerprint fast path (`cachedAggregateHash`, factored out of `ownHashFor`), so a warm key is one `git ls-files` + a stat sweep. Over-inclusion (README edit ⇒ spurious 7s re-pass) is accepted; under-inclusion would silently serve stale CSS. Two profiler spans: `artifacts:css-key` and `artifacts:css` (labelled `global css (cached)` on hit). On a hit, vite/tailwind are never imported. Pruned like vendor sets (14d).

**Measured (this worktree, same M-series host, 2026-07-16):** warm no-op `SINGULARITY_WEB_ARTIFACTS=1 ./equin build` web-artifacts step **2.8s** (was 6.9–8.9s; css: cache hit) — remaining cost ≈ detect stats + css-key fingerprint + vendor-set key resolution + compose. First build after the change: one-time full-repo content hash into the fingerprint cache + tailwind pass (~52s racing the full check fleet), then steady-state 2.8s. Both checks green in the fleet on artifact and monolith dists; map-in-sync FAILs correctly on a hand-edited deployed map and on an unbuilt source edit.

**Phase 3 hand-off:**

- Flip the default (artifact mode for agent + main builds, `--monolith` escape hatch); docs (`web-core/CLAUDE.md`, root `CLAUDE.md` build section).
- The 5 unmapped-dynamic-import warnings (sonata prewarm, layout-harness fixtures, icon-picker core) still print each compose — consider a declared exempt list so real regressions stand out.
- Warm-step residue (~2.8s) attribution if further shaving is wanted: vendor-set key resolution re-resolves 62 specs through esbuild each build (~1s) — could be memoized on (bun.lock hash, spec set).
- Gateway restart required for the 404 branch to serve.
- `no-vendored-state-inlined` trusts the builder's `sourcemap: true`; if a sourcemap-less artifact mode is ever added, the check hard-fails on the missing map (by design — decide policy then).

## Phase 3 outcome (2026-07-16)

**The flip landed: artifact mode is the DEFAULT** for normal builds (agent branches and main). `build.ts` announces the decision on every build (`Frontend mode: web artifacts (default)` / `… monolithic vite build (--monolith)`).

- **Escape hatches (the rollback story):** `--monolith` flag, `SINGULARITY_WEB_MONOLITH=1` env. Precedence: explicit flag > env > default(artifacts) — verified: `--monolith` wins, env alone selects monolith, `--artifacts` beats the env. `--artifacts` / `SINGULARITY_WEB_ARTIFACTS=1` remain accepted no-ops; `--artifacts --monolith` and `--artifacts --composition` fail loudly.
- **Release/composition stay monolithic unconditionally:** `--composition` short-circuits the mode resolution before flags/env are even consulted, and `release.ts` shells out to `build --composition <name>` — so the release pipeline is hard-guarded by construction; no separate guard needed.

**The Phase-2 "exemption list" premise was partially wrong — 4 of the 6 warned dynamic imports were browser-REACHABLE breakage, not noise:**

- The 3 `…/fixtures` barrels: Debug → Layout Lab's gallery calls `loadFixtures()` in the browser, which invokes the layout-harness core registry's dynamic imports — unmapped ⇒ the gallery crashed in artifact mode.
- `icon-picker/core`: `loadFullIconSet()` (runs whenever any icon picker mounts — avatar chooser, page icons, app icons) lazily deep-imports its own core's generated icon map; the own-core rewrite externalizes that to the core barrel specifier, which was unmapped AND didn't export `ICON_SVG_MAP`. Every icon picker was broken in artifact mode.
- Only the 2 sonata `prewarm` registries are genuinely browser-unreachable (release-runner data, loaded Bun-side via the composition-filtered variant).

**Fix (structural, instead of a specifier exemption list):** the barrel closure now follows DYNAMIC `@plugins/*` folder-barrel imports too (`closureSpecsOf` in `plan.ts`) — a dynamically-imported barrel becomes a mapped, lazily-fetched artifact, the import-map twin of the monolith's lazy chunk — EXCEPT kinds declared browser-unreachable: `BROWSER_UNREACHABLE_DYNAMIC_KINDS` (`core/constants.ts`, currently `{prewarm}`, each entry documented). Exempt specifiers are silent at compose; any other unmapped dynamic import still warns loudly (`findUnmappedDynamicWarnings`, unit-tested with a simulated new unmapped import). Static hard-fail coverage unchanged. `plan.ts` is shared with `map-in-sync`, so the check recomputes the same closure by construction. icon-picker: `ICON_SVG_MAP` is now a core-barrel export and the lazy import targets the barrel (`import("../../core")`). Fleet grew by exactly 4 barrel artifacts (215 → 219; 989 map entries).

**Measured (this worktree, M-series host, 2026-07-16):**

- First default build after the change: 5 built / 923 reused (icon-picker web+core + 3 fixtures barrels), both web-artifacts checks green, **0 compose warnings** (was 6 per build).
- Warm no-op `./equin build` (quiet machine): web-artifacts step **2.2s** (0 built / 928 reused, css cache hit), checks 2.7s. Under post-monolith host contention the same no-op read 16.6s — contention, not work.
- Rollback build `./equin build --monolith`: green, deployed, vite step 143.6s (6,747 modules) — `map-in-sync` passes on a monolith dist by design.
- Browser verification on the deployed artifact dist: 0 console errors, 0 plugin load errors; `loadFullIconSet()` through the real import map → 18 categories / 2,119 icons / search works (was a guaranteed `TypeError` before the fix); Layout Lab renders its 1 contributed fixture (= source truth; overlay/pin currently contribute none).
- `bun test plugins/framework/plugins/tooling/plugins/web-artifacts`: 54 pass. `./equin check`: exit 0.

**Known Phase-3 costs / open items:**

- A fixtures artifact INLINES its own plugin's `web/` files (externals treat only own-core specially), so a fixture rendering its own plugin's component uses a second component instance next to the plugin's web artifact. Benign for presentational fixtures (contexts still come from shared external artifacts); if a fixtures/ dir ever grows module state, extend the own-barrel externalization to non-core folder barrels.
- Vendor-set key resolution memoization (the ~1s residual on busy hosts) deliberately NOT done — still open, keyed on (bun.lock hash, spec set) if wanted.
- Gateway restart still pending for the Phase-2 `/artifacts/*` 404 branch to serve.

## Key file reference

- Build entry: `plugins/framework/plugins/cli/bin/commands/build.ts` (staging/publish: ~L136–183, 1197–1234; vite step: ~L1094–1108)
- Vite config + babel contributions: `plugins/framework/plugins/web-core/vite.config.ts`
- Registry/eager codegen: `plugins/framework/plugins/tooling/plugins/codegen/core/{plugin-registry-gen.ts,eager-tier-gen.ts,regen-pipeline.ts}`
- Loader/runtime: `plugins/framework/plugins/web-sdk/core/{loader.ts,topo.ts,context.tsx,load-tiers.ts}`, `plugins/framework/plugins/web-core/web/{index.html,main.tsx,App.tsx}`
- Store/pruning precedent: `plugins/framework/plugins/tooling/plugins/checks/core/cache.ts`; fingerprint precedent: `plugins/infra/plugins/corpus-index`
- Changed-path→plugin mapping: `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts` (`findPluginPath` — promote to shared)
- Gateway static serving: `gateway/proxy.go` (`handleStatic`)
- Stale-tab consumer: `plugins/build/web/hooks/use-stale-frontend.ts`
- Tailwind global source: `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`
