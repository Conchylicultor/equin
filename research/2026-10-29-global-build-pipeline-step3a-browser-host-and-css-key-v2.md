# Build pipeline step 3a (v2): per-artifact Tailwind candidates, and the browser host from per-plugin artifacts

Track: wiki "Track: build pipeline (codegen, migrations, frontend)" (`block-3e7bbe1c-…`). This step implements redesign items 7 and 8, plus item 9 for the server artifacts (sub-page "Build pipeline: redesign", `block-5979c8a6-…`).

**v1 → v2.** Reviewed against the Performance instructions (no caching that hides a structural issue, target the cold case, no all-or-nothing fingerprint):
* v1's Part 1 (key the Tailwind pass on a whole-repo candidate scan) was still a global fingerprint: an O(N) scan on every build, any new token anywhere recompiled everything, and cold was unchanged. It is replaced by per-artifact candidates and a direct compile.
* Part 2 gains three gates: cold before/after, the vendor-set rebuild cost, and demo startup.

## Context
1. **The global Tailwind pass re-runs on every build.**
   * Its key (`computeGlobalCssKey`, `web-artifacts/core/internal/global-css.ts`) hashes `git ls-files` plus a raw walk of `plugins/`. That walk includes the gitignored `web-core/.build.lock`, which holds the build's PID, so the cache never hits (8/8 on the VM).
   * Cost per build, quiet / loaded: Tailwind pass 1.1 s / 6.2 s, key 1.0 s / 3.2 s.
   * Structurally, the pass is whole-repo: one scan of every file, one compile, keyed by every file.
2. **The browser host is one whole-graph bundle** (`browser-hosts.ts`): 222 portable server barrels and everything they reach, 2,934 repo modules, 22.1 MB.
   * Its key is every loaded file, so any edit inside the graph rebuilds all of it: 1.6 s quiet, 17 s median loaded.
   * A cold build bundles a second copy of the `core` modules the page already built.
   * Goal: one edit costs one artifact, warm or cold.
   * Must keep: the coverage guard and the "no Node builtins" gate.
   * Not the fix: building on demand or at push.

## Facts the design rests on
* `browser-host.generated.ts` already loads members through `loader: () => import("@plugins/<p>/server")`. Only `inlineDynamicImports: true` merges them.
* Artifact addresses exclude dependency contents (`core/hash.ts`). A stable link name cascades nothing.
* Vendor entry files have stable spec-derived names (`vendorEntryFileName`). Their chunks are reached only relatively.
* `scanStagedModules` resolves relative specifiers through the staged symlinks.
* PGlite loads `pglite.wasm`, `pglite.data` and `initdb.wasm` via `new URL("./x", import.meta.url)`. These are about 16 MB of the 22.1 MB, and esbuild does not carry them.
* Three graph modules use `import.meta.glob`:
  * `migrations/bundled-source`: the parent plugin's `data/*.sql`;
  * `config_v2/bundled-layer`: the repo's `/config/**/*.jsonc`;
  * lumen's `bin/bundled-prototypes.ts`.
* Tailwind is installed at 4.3.3:
  * `@tailwindcss/oxide`'s `Scanner.scanFiles` extracts candidates from given files;
  * `@tailwindcss/node`'s `compile(css).build(candidates)` compiles from a candidate list, with no scan.
* `app.css` uses `source(none)` + `@source "plugins/"`. The `tailwind-scan-covers-classes` check enforces `used ⊆ scanned = declared`.

## Spike results (2026-10-29, this host, load \~20)

* **Host bundle byte split (minified, 22.19 MB total, JS 1.31 MB gzip, built in 2.7 s):**

  | Part | Size | Modules |
  | --- | --- | --- |
  | PGlite wasm | 9.65 MB | |
  | PGlite data | 6.00 MB | |
  | PGlite initdb.wasm | 0.38 MB | |
  | PGlite JS | 0.75 MB | |
  | Other npm | 1.03 MB | lexical 0.24, zod 0.18, drizzle-orm 0.16, yjs 0.12 |
  | Repo `server/` | 1.51 MB | 870 |
  | Repo `core/` | 1.07 MB | 852 |
  | Repo `shared/` | 1.79 MB | 69 |
  | Repo, no folder | 0.78 MB | 698 |
  | Repo `data/` | 0.66 MB | 381 |
  | Repo `bin/` | 0.08 MB | 6 |

  * Of `shared/`, 1.75 MB is ONE file: `ui/tweakcn/community-browser/shared/catalog.json`.
  * The rows with no folder are the repo `/config/**/*.jsonc` glob.
  * `data/` is migrations SQL plus lumen's thumbnails.
  * Script: `web-artifacts/scripts/measure-browser-host.ts`.
* **The npm bundle and the host on this host's store:**
  * 32 npm bundles in the last 17 days, 2–9 a day.
  * 66 distinct host builds in 2 days.
  * Build profiles (258 builds, loaded host): `artifacts:browser-hosts` median 14.8 s, rebuilt in 168 of 218 builds (median 23.6 s when rebuilt), p90 72.8 s.
  * `artifacts:css` 8.8 s and `artifacts:css-key` 4.6 s median.
  * `artifacts:vendors` median 0.2 s, \~1.1 s when it rebuilds.
* **Tailwind (`web-artifacts/scripts/measure-tailwind.ts`):**
  * Compiling `app.css` takes \~40 ms. Building from the 103,762 candidates takes \~0.2 s, and the optimize pass 30–70 ms, so a direct compile is \~0.3 s.
  * Tailwind's own scan of `plugins/` (18,136 files) takes 1.5–2.3 s.
  * **Per-plugin extraction must use a scanner whose sources are that plugin's own folders** (`new Scanner({ sources }).scan()`).
    * Its union equals the global scan exactly, and the stylesheet is byte-identical.
    * Passing raw content to `scanFiles` adds 464 candidates (Tailwind treats `.css` files differently), so it is wrong.
    * Passing file paths to a sourceless scanner returns nothing.
  * Cost: \~4 ms per plugin, paid only for stale artifacts.
  * **Scope change, measured:** candidates from the shipped folders only (web, core, shared, exhibits, prewarm) drop 129 selectors and add 0. Checked with token-bounded matches, all 129 come from tests, lint rules, docs, e2e, server, machine or check code, or comments. None comes from a class in shipped code.
* **Multi-entry Rolldown (`web-artifacts/scripts/spike-multi-entry.ts`):**
  * All 222 server barrels build in one run in 0.67 s, with every bare spec external.
  * 223 chunks, **no chunk shared between entries, no entry importing another**.
  * One by one in one process: 16 ms each.
  * The cold risk of 2.2 is small. The one-run build is kept, and disjointness stays asserted on every build.

## Part 1: Tailwind from per-artifact candidates

### Model
Each artifact records the Tailwind candidates of the files it inlines. The global stylesheet compiles the union of the composition's artifacts' candidates. No file walk, no global key.

### Pieces
* **Extract at artifact build** (`vite-builder.ts`):
  * After a build, run `Scanner.scanFiles` over the artifact's own files (the same list `listOwnFiles` hashed) and write the sorted set to `candidates.json` inside the artifact dir, before `publishArtifact`.
  * It is a function of the artifact's own files plus the oxide version. Add the oxide version to the builder identity (`identity.ts`).
  * Reused artifacts carry their set, and a fresh worktree reads it from the shared store.
* **Combine in the pipeline** (`pipeline.ts`, `global-css.ts`):
  * Read every planned artifact's `candidates.json`, take the union, then:
    * `compile(appCss, { base, onDependency })` (`@tailwindcss/node`);
    * `.build(union)`;
    * minify / optimize as today.
  * Font `url()`s from the `@fontsource` imports are resolved and emitted as hashed assets. First choice: a CSS-only vite pass over the compiled string, without the Tailwind plugin. Drop it if its overhead dominates.
* **Cache, only if measurement says so:**
  * If union + compile costs ≲ 0.3 s, there is no cache.
  * Otherwise, keep `css/<hash(union, appCss, imports, toolchain)>`. This is legitimate: the key is the combined records (cheap) and a miss is the cheap compile, not a scan.
  * Either way, the whole `git ls-files` + `walkAllFiles` + `__global-css|inputs` aggregate is deleted.
* **Scope change (diffed, not assumed):**
  * Today Tailwind scans everything under `plugins/` (server code, tests, `bin/`, markdown); after, only what an artifact ships.
  * Expected: the same or fewer rules. Every class a page renders comes from shipped code.
  * Verify:
    * diff the selector set of the old and new stylesheet for the main composition;
    * every rule dropped must come only from non-shipped files;
    * a rule added is a bug.
  * Also: the stylesheet becomes per-composition (its fleet's union), which is more correct for hermetic/release builds.
* **Keep the invariant exact** (`checks/plugins/tailwind-scan-covers-classes`):
  * `scanned` is now "inlined by some artifact".
  * The check fails on a tracked class-authoring file that no artifact's own-file roots cover. It reuses `inlinedRootsFor` from `web-artifacts/core`, read-only.
  * It keeps requiring `source(none)`.
  * The `@source` line stays, for editor tooling, or is dropped if the check no longer needs it (decided at implementation, recorded in the check's CLAUDE.md).

**Tests (`global-css.test.ts`, `vite-builder.test.ts`):**
* the candidate set lands in the artifact;
* the union compiles the same CSS as the scan over the same files;
* a comment edit leaves the union unchanged.

## Part 2: the browser host linked from per-plugin artifacts

### Model
The worker loads the same per-plugin artifacts as the page:
* one `server` artifact per graph member;
* the page's own `core` artifacts;
* the fleet's vendor set.

They are reached through a **link tree of stable names**, because a worker has no import map.

### 2.1 `server` artifacts (plan.ts)
* `planFleet` adds a `server` target for each member of each fleet host's generated `hostEntries` (codegen's coverage-guarded list).
  * Entry: `plugins/<p>/server/index.ts`. Spec: `@plugins/<p>/server`.
  * Address: `kind + own files (server, shared) + identity`.
  * Same externals, own-folder barrel rewrite, inline audit.
* `resolveBarrelClosure` pulls in `core` barrels that only the server graph reaches. These are ordinary `core` targets shared with the page.
* `composeMapEntries` and the preload closure skip the `server` kind. It is reachable only through the link tree.
* **No Node builtins, per artifact:**
  * fail when an artifact in a host's link closure emits a platform-API import, using `isPlatformApi` from `framework/tooling/boundaries/core`, which already backs `boundaries:portable-closure`;
  * this replaces `EXTERNALIZED_RE`.

### 2.2 Stale server artifacts as one Rolldown run (redesign item 9, for these)
* This is the cold gate's lever: 222 separate vite builds at about 80 ms of setup each would make cold slower than the 1.6 s bundle.
* All stale `server` targets build as entries of ONE vite/Rolldown invocation, with every `@plugins/*` and npm spec external. Each entry's output is split back into its own content-addressed artifact.
* **What must hold (spike first, asserted per build):**
  * no output imports a chunk shared with another entry;
  * this includes Rolldown's runtime helpers: force them per entry, or fail;
  * each artifact's emitted files, sourcemaps and inline audit cover only its own plugin.
* If the spike shows Rolldown cannot keep entries disjoint, the fallback is still one toolchain setup: one `rolldown()` instance, reused across sequential per-entry `generate` calls. Its cold cost is measured the same way.
* The same mechanism is later reused by the page's cold artifacts (item 9 proper). Not in this step.

### 2.3 Globs in an artifact's address
* `globRootsOf` moves into `own-files.ts`. An artifact whose own files hold a literal `import.meta.glob` adds to its address the recursive listing and contents of each static base. A non-literal pattern throws.
* The inline audit accepts files under those roots.
* This covers `bundled-source` (`data/*.sql`), `bundled-layer` (`/config/**`) and lumen's prototypes. The cost is legitimate: those files are the bytes the artifact inlines.

### 2.4 Link derivation: stable names, content-addressed targets
* `linkForWorker(artifactDir)` (new `worker-link.ts`) is a pure function of one artifact's bytes. It is published once to the store as `worker-links/<dirName>.<linkerHash>`. That cache is per artifact and content-keyed: O(changes), and each rewrite takes milliseconds.
* With `es-module-lexer` it rewrites every bare specifier (static, and dynamic string literals) to a relative URL into the tree:
  * `@plugins/<path>/<folder>` → `<up>/p/<slug>/<folder>/index.js`, or the co-entry file;
  * npm `<spec>` → `<up>/v/<vendorEntryFileName(spec)>`.
* Names, not hashes: a dependency's rebuild never changes its importers' linked bytes.
* An unmappable spec fails: a composition specifier, `@browser-host/*`, or a spec missing from the vendor set.

### 2.5 Host entry and compose
* `@browser-host/<plugin>` becomes:
  * `host.js`: `start()` starts the worker from `./worker/<host-slug>/entry.js`, and `serviceWorkerUrl` is unchanged;
  * an entry artifact built from the host's `bin/browser-host.ts` closure (its `bin/` plus glob roots), linked like the rest;
  * `frames-sw.js`, still bundled whole: it is a classic script that cannot import. It is small, and keeps a recorded-inputs key scoped to its own modules.
* Compose stages:
  * `dist/worker/p/<slug>/<folder>` → the linked store entry, for every artifact in the host's static and dynamic closure;
  * `dist/worker/v` → the vendor set.
* `materialize` copies, as everywhere.
* `scanStagedModules` verifies the tree. Extend pass 2's export-name join to relative imports that cross artifact links.
* **Vendors:**
  * the server targets' bare specs join `collectVendorRequests`;
  * new, and generic: vendor assets follow their module. For each bundled input with `new URL("<literal>", import.meta.url)`, the referenced package file must sit beside every output file containing it (found through esbuild's `metafile`).
  * **Package assets live in their own per-version store, never re-made by a vendor rebuild.**
    * The store is `cache/web-artifacts/package-assets/<pkg>@<version>/<file>`. Each file is published once through `publishDir`, so it is precompressed once with its `.br`/`.gz` sidecars and shared by every worktree.
    * A vendor set **hard-links** the files into place (with the sidecars) instead of copying and recompressing them. `materialize` copies, as everywhere.
    * Today the 16 MB of PGlite wasm/data is recompressed (\~5 s, `precompress.ts`) on every host rebuild. Under a single vendor set it would be recompressed on every vendor rebuild. With the store, it is compressed once per PGlite version, and a vendor rebuild's cost is its JS alone.
    * `precompressDir` skips a file whose sidecars already exist and are newer than the file (hard-linked ones), so publishing a vendor set does not recompress them.
* **Removed:** `hostInputsHash`, `moduleRecorder` for the worker, the `browser-hosts/*.json` records, the worker pass and `inlineDynamicImports`.

### 2.6 Known global key this step widens (measured, not fixed here)
* The vendor set is one esbuild split build keyed by every spec and version, so any new package or bump rebuilds all of it. Adding the server graph's packages (PGlite included) widens what invalidates it.
* Measure the vendor-set cold build with and without the server specs, and how often its key changed over recent builds (from the store's `vendors/` entries and build profiles).
* File per-package vendor artifacts as a follow-up task (sidequest, manual) when this step lands.

## Gates (this step fails if any regresses)
* **Cold:**
  * the frontend total of a cold build must not regress (C0/C1, quiet VM);
  * the server artifacts' build stage must cost no more than today's host bundle in the same cold run.
* **Demo startup:**
  * Measure the time from `start()` to the first answered read and to the demo's first rendered pane, median of 5 runs, both with a cold HTTP cache and with a warm one, on the same build machine.
  * Also record the request count and bytes.
  * A regression beyond run-to-run noise fails the step.
  * The lever, if needed: a generated list in the entry that issues every link-tree `import()` at once (flattening the loader waves). Never a whole bundle.
* **Warm, one edit inside the graph (W4):** exactly one stale `server` artifact and no host rebuild.

## Measurements (before and after each part)
* **Local, once: the current bundle's byte split** (rolldown `chunk.modules` `renderedLength` by id, plus asset sizes):
  * repo;
  * PGlite code;
  * PGlite assets;
  * other npm.
* **Quiet VM, `sidequests/clean-install/steps-build-pipeline.sh`:**
  * add W4 (a comment line in a graph member's server file, e.g. `apps-core/app-usage/server`);
  * add an env switch to skip ISO (codegen is untouched);
  * run C0/C1, W0, W1, W2 and W4 on the base commit, then on the branch;
  * record per-stage frontend times: `browser hosts` / server artifacts, `global CSS`, `build artifacts`, `vendors`, `compose`.
* **Part 1 specifically:** the per-artifact extraction cost (added to each artifact build), union + compile wall time, and cold vs today's 1.1 + 1.0 s.
* **Track page:** update the Overview checkboxes, Current status, the before/after benchmark table, and the byte split in "Build pipeline: measurements". Then file the next main task (the repo snapshot, redesign item 3) with the page id.

## Verification
* `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`. New tests cover:
  * candidates;
  * the union compile;
  * link rewrite (stable names, dynamic literals, unmappable spec throws, co-entry);
  * glob roots in the address;
  * vendor asset copy;
  * the Node-builtin gate;
  * multi-entry disjointness.
* `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/tailwind-scan-covers-classes` and `./equin test plugins/apps/plugins/website/plugins/demos/plugins/lumen`.
* `./equin build`, then check the demo with the `browser_*` tools:
  * every read answers and writes render;
  * the console shows no errors and no failed fetches;
  * the CSS selector diff is clean;
  * the app's UI looks unchanged (spot screenshots of the agent manager and pages).
* A hermetic build of the main composition: the materialized `dist/worker` holds no symlinks.

## Critical files
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/`:
  * changed: `global-css.ts`, `vite-builder.ts`, `identity.ts`, `browser-hosts.ts`, `plan.ts`, `pipeline.ts`, `compose.ts`, `own-files.ts`, `inline-audit.ts`, `vendors.ts`, `staged-verify.ts`;
  * new: `worker-link.ts`.
* `web-artifacts/CLAUDE.md`: rewrite the invariants "A browser host is the one whole-graph artifact" and "The global CSS pass…".
* `web-artifacts/package.json`: add `@tailwindcss/oxide` and `@tailwindcss/node`, at `@tailwindcss/vite`'s version.
* `plugins/framework/plugins/tooling/plugins/checks/plugins/tailwind-scan-covers-classes/`.
* `sidequests/clean-install/steps-build-pipeline.sh`.
* Read-only: `codegen/core/browser-host-gen.ts`, `server-core/core/browser-host.ts`, `lumen/bin/*`.
