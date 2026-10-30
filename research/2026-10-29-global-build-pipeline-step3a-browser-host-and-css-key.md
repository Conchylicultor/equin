# Build pipeline step 3a: the Tailwind key, and the browser host from per-plugin artifacts

Track: wiki "Track: build pipeline (codegen, migrations, frontend)" (`block-3e7bbe1c-…`). This step implements items 1 and 2 of its redesign's order of work (sub-page "Build pipeline: redesign", `block-5979c8a6-…`, items 7 containment and 8).

## Context

1. **The global Tailwind pass re-runs on every build.** `computeGlobalCssKey` (`web-artifacts/core/internal/global-css.ts`) hashes `git ls-files` plus a raw walk of every `@source` dir (`plugins/`). The walk includes the gitignored `web-core/.build.lock`, which holds the build's PID, so the key changes on every build (8 of 8 warm builds on the VM). The pass costs about 1.1 s quiet and 6.2 s median loaded. The key itself costs another 1.0 s quiet and 3.2 s loaded.
2. **The browser host is one whole-graph bundle** (`web-artifacts/core/internal/browser-hosts.ts`): lumen's worker, with 222 portable server barrels and everything they reach (2,934 repo modules, 22.1 MB). Import maps do not reach workers, so vite's worker pass inlines it all. Its key is every file it loaded, so an edit to any of them rebuilds the whole graph: 1.6 s quiet, 17 s median loaded. A cold build bundles a second copy of every `core` module the page artifacts already built. The user wants the browser server to scale like the regular server: one edit costs one artifact, warm or cold. Two things must stay: the coverage guard (codegen, `browser-host-coverage.ts`) and the "no Node builtins" gate. Building on demand or at push is not the fix.

## Facts the design rests on (from exploration)

- `browser-host.generated.ts` already uses **dynamic loaders**: `loader: () => import("@plugins/<p>/server")` for 222 entries, booted in waves by `bootPluginGraph`. Only `inlineDynamicImports: true` collapses them into one bundle today.
- **Artifact addresses never include a dependency's contents** (`core/hash.ts`). The address is `kind + own files (inlinedRootsFor) + builder identity`. A stable link name therefore cascades nothing.
- **Vendor entries have stable, spec-derived names** (`vendorEntryFileName`: `react-dom/client` becomes `react-dom__client.js`). Their shared chunks are hashed but are reached only relatively, inside the set.
- `scanStagedModules` already resolves relative specifiers through the staged symlinks and fails on any miss.
- PGlite reaches `pglite.wasm`, `pglite.data` and `initdb.wasm` through `new URL("./x", import.meta.url)`. That is 16 MB of the 22.1 MB, and esbuild does not carry these assets.
- `import.meta.glob` inside the graph:
  - `migrations/bundled-source` reaches up to its parent plugin's `data/*.sql`;
  - `config_v2/bundled-layer` reads the repo's `/config/**/*.jsonc`;
  - lumen's `bin/bundled-prototypes.ts` reads `../data/prototypes/**`.
- **Tailwind's own scanner is installed:** `@tailwindcss/oxide@4.3.3`, through `@tailwindcss/vite`. Its `Scanner({sources}).scan()` returns the candidate set the pass compiles, and it honours the same ignore rules the pass does.

## Part 1: the Tailwind key from Tailwind's own candidates

**Measure first.** Diff the per-file aggregate between two consecutive warm builds. This confirms that `.build.lock` is the only churning input, and not something else gitignored under `plugins/`.

**Fix:** key the pass on what it compiles, not on the bytes of every file.

- `computeGlobalCssKey` becomes the following record:
  - `appCss` and the `@import` hashes and versions (unchanged);
  - the toolchain versions (unchanged);
  - `candidates = sha256(sorted Scanner.scan())`.
- The scanner gets the same sources the pass uses: app.css's `@source` / `@source not` entries, resolved against app.css's dir, with `source(none)`. Use `@tailwindcss/node`'s `compile()` on app.css to read `compiler.sources` exactly, rather than re-parsing. `parseCssInputs` stays only for `@import`.
- The `git ls-files` call, `walkAllFiles` and the `__global-css|inputs` stat aggregate are deleted.
- **Exact by construction:** the stylesheet is a pure function of app.css, its imports, the toolchain and the candidates. A lock file, a comment without a new token, or a doc edit no longer re-runs the pass.
- Add `@tailwindcss/oxide` and `@tailwindcss/node` to `web-artifacts/package.json`, pinned to the `@tailwindcss/vite` version.
- **Risk:** the oxide scan's own cost over `plugins/`, expected well under the 1.0 s fingerprint it replaces. If it is not cheaper, it still stops the rerun (1.1 s and up), and the per-artifact candidate records (redesign item 7) remove the O(N) scan later.

**Tests:** extend `global-css.test.ts`:
- the same key across a lock-file or comment-only change;
- a new key when a new class appears in a source file;
- a new key when app.css changes.

## Part 2: the browser host linked from per-plugin artifacts

### Model
The worker loads the same per-plugin artifacts the page does: one `server` artifact per graph member, the page's own `core` artifacts, and the fleet's vendor set. They are reached through a **link tree** of stable names, because a worker has no import map.

### 2.1 `server` artifacts (plan.ts, vite-builder.ts)
- `planFleet` adds one `server` target per member of each fleet host's `hostEntries`. Members are read from the generated registry, and that list is already codegen's (coverage-guarded).
  - Entry: `plugins/<p>/server/index.ts`. Specifier: `@plugins/<p>/server`.
  - Address: the usual `kind + own files (server, shared) + identity`.
  - Built by the existing `buildArtifact`: same externals and own-folder barrel rewrite, same inline audit, same concurrency pool.
- `resolveBarrelClosure` then pulls in any `core` barrel that only the server graph reaches. These are ordinary `core` targets, shared with the page.
- **The "no Node builtins" gate, per artifact:** after a `server`-kind build (or any artifact in a host's link closure), fail when an emitted static or dynamic import is a platform API. Reuse `isPlatformApi` from `framework/tooling/boundaries/core`, which already backs `boundaries:portable-closure`. This replaces `EXTERNALIZED_RE`.
- **Server targets never enter the page's import map or its preload closure.** `composeMapEntries` skips the `server` kind. They are reachable only through the link tree.

### 2.2 Globs in an artifact's address (generalises browser-hosts' `globRoots`)
- An artifact whose own files hold `import.meta.glob` adds to its address the recursive listing and contents of each literal glob's static base. `globRootsOf` moves from browser-hosts into `own-files.ts`, and a non-literal pattern still throws.
- The inline audit's `isHashedFile` accepts files under those roots. Without this, `bundled-source` (its parent's `data/*.sql`), `bundled-layer` (`/config/**`) and lumen's prototypes would fail the audit, which is the audit doing its job.

### 2.3 The link derivation: stable names, content-addressed targets
- `linkForWorker(artifactDir)` is a pure function of one artifact's bytes. It is published to the store as `worker-links/<dirName>.<linkerHash>`, so it is computed once per artifact version and shared by every worktree.
- With `es-module-lexer`, it rewrites every bare specifier, static and dynamic string literal alike, to a relative URL into the link tree:
  - `@plugins/<path>/<folder>` becomes `<up>/p/<slug>/<folder>/index.js`, or `exhibits.js` and the like for co-entries;
  - an npm spec becomes `<up>/v/<vendorEntryFileName(spec)>`;
  - `<up>` comes from the file's depth.
- **Names, not hashes:** a dependency's rebuild never changes its importers' linked bytes. The `.map` files are copied as they are; the line and column shifts in rewritten lines are accepted.
- An unmappable spec fails the link step: a composition specifier, `@browser-host/*`, or a spec missing from the vendor set.

### 2.4 The host entry, and compose
- The host artifact, `@browser-host/<plugin>`, shrinks to:
  - `host.js`: `start()` does `new Worker(new URL("./worker/<host-slug>/entry.js", import.meta.url), {type:"module"})`, and `serviceWorkerUrl` is unchanged;
  - an entry artifact built from the plugin's `bin/browser-host.ts` closure (its `bin/` plus glob roots), with every `@plugins/*` external, then linked like any other artifact;
  - `frames-sw.js`, still bundled whole, because it is a classic script with no imports. It is small, and its inputs record is kept but scoped to it.
- Compose stages `dist/worker/p/<slug>/<folder>` as a symlink to the linked store entry, for every artifact in the host graph's static and dynamic closure (walked from the linked metas). It stages `dist/worker/v` as a symlink to the vendor set.
  - `materialize` copies, as everywhere else.
  - `scanStagedModules` verifies the tree for free: relative specifiers must resolve. Extend its pass 2 so the export-name join also applies to relative imports that cross artifact links.
- **Vendors:** server targets' bare specs join `collectVendorRequests`, so PGlite and drizzle-orm/pglite are part of the one vendor set (keyed by version, as today).
  - **New: vendor assets follow their module.** For every bundled input holding `new URL("<literal>", import.meta.url)`, copy the referenced package file beside each output file that contains it, using esbuild's `metafile`.
  - Generic, and it stays under the vendor key (the package version).

### 2.5 What goes away
`hostInputsHash`, `moduleRecorder`, the `browser-hosts/*.json` input records, the worker pass and `inlineDynamicImports` all go away. The host's address is no longer a recorded list of every loaded file.

### Expected cost
| Change | Today | After |
| --- | --- | --- |
| Edit inside a server plugin | the 1.6 s quiet / 17 s loaded whole bundle | 1 `server` artifact (\~0.5–1 s) + 1 link (ms) + compose symlinks |
| Cold build | 222 server artifacts plus the server-only `core` barrels, in the existing pool | no second copy of the page's `core` artifacts |
| Release / hermetic | | the same path, materialized |

### Risk to measure: worker boot latency
Many module requests replace one 22 MB fetch, there is no modulepreload in a worker, and the waterfall depth follows the dynamic loader waves. Measure the demo's time to its first served read, before and after. Compare it with the 22 MB download, which this change also splits into cacheable, unchanging pieces. If it regresses badly, the next lever is a generated preload list in the entry, which issues all link-tree `import()`s at once. A whole bundle is not the answer.

## Measurements (before and after each part)

- **Local, once: the bundle's byte split** (asked for and never measured). Using rolldown's `chunk.modules` `renderedLength` by id from the current host build, split it into:
  - repo bytes;
  - PGlite code;
  - PGlite assets (wasm, data);
  - other npm bytes.
- **Quiet VM, `sidequests/clean-install/steps-build-pipeline.sh`:**
  - Add W4: one comment line in a server file inside the host graph, for example `apps-core/app-usage/server`. That is the case this step targets.
  - Add an env switch to skip ISO, because codegen is unchanged here.
  - Run C0/C1, W0, W1, W2, W4 on the base commit (W4 is new), then on this branch.
  - Report:
    - per-stage frontend times (`browser hosts`, `global CSS fingerprint`, `global Tailwind pass`, `build artifacts`, `compose`);
    - cold frontend total;
    - the Tailwind hit rate across warm builds.
- **Demo boot** (local, with the `browser_*` tools, on my build): time from `start()` to the first answered read, and the worker's request count and bytes.
- **Update the track page:** the Overview checkboxes, Current status, a before/after benchmark table, and the byte split in "Build pipeline: measurements".

## Verification
- `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts` covers:
  - global-css;
  - the link rewrite (new unit tests: stable names, dynamic literals, unmappable spec throws, a co-entry);
  - glob roots in the own-files address;
  - the vendor asset copy;
  - the Node-builtin gate.
- `./equin test plugins/apps/plugins/website/plugins/demos/plugins/lumen` (the boot test is unaffected, since it runs in Bun).
- `./equin build`, then open the demo route with the `browser_*` tools. Every read answers, writes render, and the console shows no errors and no failed module fetches. `./equin check web-artifacts:*`.
- **A server-file edit, rebuilt:** the log shows 1 stale `server` artifact and no host rebuild.
- A hermetic build of the main composition is the release path. The materialized `dist/worker` must hold no symlinks.

## Critical files
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/`: `global-css.ts`, `browser-hosts.ts`, `plan.ts`, `pipeline.ts`, `compose.ts`, `own-files.ts`, `inline-audit.ts`, `vendors.ts`, `staged-verify.ts`, new `worker-link.ts`.
- `web-artifacts/CLAUDE.md`: rewrite the invariant "A browser host is the one whole-graph artifact".
- `sidequests/clean-install/steps-build-pipeline.sh`: W4, and the ISO skip.
- Read-only: `codegen/core/browser-host-gen.ts` (the member list), `server-core/core/browser-host.ts`, `lumen/bin/*`.
