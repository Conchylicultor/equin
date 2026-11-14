# web-artifacts

Per-plugin web build artifacts: each plugin's `web/` barrel (with its
`exhibits/` as a second entry, when it has one) and every imported
folder barrel — `core`, `prewarm`, … — builds into an independent,
content-addressed vite lib-mode artifact under `~/.equin/cache/web-artifacts/`;
the compose step assembles `dist/` (inline import map + entry + preloads +
links into the store). This is the ONLY frontend build — the monolithic vite
build it replaced is gone (`web-core/vite.config.ts`, `--monolith`,
its environment switch), so every dist producer runs this pipeline:
`./equin build` (once per target namespace) and `./equin build
--hermetic --composition <name…>` (the release path). Design/history:
`research/2026-07-15-global-per-plugin-web-artifacts.md`,
`research/2026-08-06-global-one-dist-per-namespace.md`.

Two knobs distinguish the producers, both passed to `runWebArtifactsPipeline`:

- **`source`** — WHICH fleet to plan. Omitted ⇒ the committed full registry; a
  composition MUST pass `compositionFleetSource({ root, name })` or it silently
  composes every plugin in the repo. Never `vendors` on the release path:
  `readFleetVendorMeta` throws unless the full non-composition fleet is already
  in this host's store, which a bare release host does not have; omitted, the
  pipeline resolves its own vendor set.
- **`materialize`** — real copies instead of store symlinks. Release only: its
  dist is copied into a shippable bundle, and it is written and read across a
  window where `.build.lock` is released, so a concurrent build's store pruning
  could dangle the links.

Key invariants:

- **A registry's on-demand entries are built, never preloaded.** A
  composition's web registry also lists `webScopedEntries` (a bundled browser
  host's page scope beyond its own plugins, codegen's `scopedOnlyWebPlugins`):
  the fleet plans and maps them like `webEntries`, and the plan's
  `deferredPaths` holds them, so they never join the boot's modulepreload
  closure — the scope loads them when the visitor asks.
- **Stale artifacts compile where the caller says, never all on one thread.**
  The pipeline builds through an `ArtifactBuilder`
  (`core/internal/artifact-builder.ts`). A request is plain data
  (`{ repoRoot, minify, target }`), and every builder runs the same
  `buildArtifact` through `createArtifactBuildHandler`.
  - The build CLI passes the pooled builder: `cli/`'s
    `createPooledArtifactBuilder`, i.e. `packages/thread-pool` worker threads
    running `bin/build-worker.ts`.
  - Its size is about two threads per three cores, clamped to the build's host
    grant, and the pipeline is admitted for that many units.
  - Omitted, it builds in-process, where Babel (JS) serializes every build on
    the one thread.
- **A Babel contribution runs only on the modules it can change.** Each `vite/`
  contribution (web-core's `BabelContribution`) declares
  `appliesTo({ id, code })`, false only for a module it would leave unchanged.
  - `babelContributionsPlugin` (`core/internal/babel-transform.ts`) is the
    builder's own pass: `@vitejs/plugin-react`'s production options, minus
    running on everything. A module none applies to skips Babel.
  - `scripts/babel-equivalence.ts` builds a sample both ways and requires
    byte-identical output.
- **Every emitted external import must resolve in the import map — and link.**
  Static imports and the registry's dynamic imports hard-fail the build on a
  miss. Other dynamic `@plugins/*` folder-barrel imports are composed into
  mapped, lazily-fetched artifacts by the barrel closure — EXCEPT kinds declared
  browser-unreachable (`BROWSER_UNREACHABLE_DYNAMIC_KINDS` in
  `core/constants.ts`: every leaf folder but the co-built `exhibits` — `lint`,
  `facet`, `prewarm`, … — only ever named by a collected-dir registry run
  Bun-side), which are skipped and silent.
  Any other unmapped dynamic import warns loudly at compose.
  Resolving is not enough: every name a static import binds must actually be
  exported by the target's emitted bytes, or the browser throws `SyntaxError:
  … does not provide an export named 'X'`. Because cross-plugin imports stay
  external and an importer's hash excludes its target's contents, renaming an
  export in B leaves A reused-unrebuilt and unexamined — compose is the only
  place the fleet's bytes are read against each other, so it hard-fails on a
  broken link too (`--skip-checks` included; `type-check` is skippable and
  casts/stale `.d.ts` typecheck green while the bytes disagree). Skipped as
  semantically unknowable: `import * as ns`, dynamic imports, and targets
  emitting `export *` (an incomplete export set — the fleet emits zero, and one
  appearing warns loudly rather than silently weakening the gate). Web barrels
  additionally must export `default`: the registry's loaders are dynamic and
  typed `Promise<{ default: unknown }>`, so nothing else catches its loss.
- **One URL = one module instance.** An import landing in one of the plugin's
  own non-inlined folders is rewritten to that folder's external
  `@plugins/<path>/<folder>` barrel (never inlined); vendors are one esbuild
  split build so stateful transitives are shared. Guarded at build time, on
  each artifact before it is published (`core/internal/vendored-inline.ts`):
  the `sources` of EVERY module's sourcemap (`index.js`, co-entries, shared and
  lazy `.mjs` chunks — `core/internal/sourcemaps.ts`) must name no npm package
  outside `INLINE_PACKAGES`, or that artifact's build fails. Its cost is what a
  build built; a reused artifact was guarded by a builder of the same identity
  (the guard and the allowlist both feed it). It used to be a check that
  re-derived every verdict per pass — an `existsSync` per artifact and per
  cached verdict (~58k), 4–7 s of the check thread on every build. The one
  module allowed no map is a pure re-export facade (Rolldown emits a
  multi-entry `index.js` that way when everything it reaches is shared with
  `exhibits.js`); any other map-less module fails the build of that artifact.
- **A planned target carries no store fact.** A target's address is pure
  hashing over the repo snapshot; whether the store holds it is not part of
  the plan (`PlannedTarget` has no "is it published" bit — only a browser
  host's planning reads its stored records, `matchHostRecord`). The pipeline
  asks the store after pinning (`storeReads`). `map-in-sync` never asks it:
  it plans over `deployedReads` — the edges the dist recorded
  (`DIST_EDGES_FILE`) and the one host build its map serves — because a
  planned address the dist does not name is one it did not compose, whatever
  the shared store holds. Reading the store for those made the check's cost
  and verdict grow with what every checkout on the machine had built (a
  builder-identity change: ~2.5k store reads, over the check file-call budget).
- **Across own folders, only the barrel is importable.** The rewrite above
  accepts only the barrel spelling (`../core`, `@plugins/<own>/core`) and
  throws on a deep path (`../core/x`). Rewriting a deep path made it mean the
  barrel in the browser while `tsc` read the file, so a symbol the barrel did
  not export passed every check and failed ~5 minutes later at compose. The
  `runtime-isolation/no-deep-own-folder-import` lint rule rejects the same
  import in the editor for every browser-built folder (`web`, `core`,
  `shared`, `exhibits`); the throw covers what lint cannot see.
  The one exception is a co-built folder reaching its host (below).
- **A co-built folder is a second entry of its host artifact, never an
  artifact of its own.** `COBUILT_FOLDERS` (`core/own-roots.ts`) maps
  `exhibits` → `web`: a plugin with `exhibits/index.ts` gets its web artifact
  built multi-entry (`index` = `web/index.ts`, `exhibits` =
  `exhibits/index.ts`), so rollup puts every module both reach into a common
  chunk and an exhibit shares ONE instance of its plugin's web modules — which
  is why `exhibits/` may deep-import its own `web/`. The target carries the
  extra entry as `coEntries`; `composeMapEntries` maps `@plugins/<p>/exhibits`
  to the host artifact's `exhibits.js` (one artifact, two specifiers — compose's
  every-URL-is-a-file gate and `scanStagedModules` then verify it like any other
  entry), and the barrel closure resolves an `@plugins/<p>/exhibits` import to
  the HOST artifact (`hostSpecOf`), planning it when the fleet lacks it and
  throwing when the plugin has no `web/`. Extracted CSS rides with the chunk whose
  modules import it (`chunkCssPlugin`, `cssCodeSplit`): an entry's styles run
  with the entry, a dynamically imported chunk's styles only when that chunk
  loads, and styles an exhibit shares with `index.js` live in the shared chunk. `exhibits.js` is
  reached only through the exhibits registry's dynamic import, so it never
  joins the modulepreload closure — asserted per build by
  `assertCoEntriesOffHostPath` (`index.js` must not statically reach a
  co-entry file).
- **What depends on the composition lives only in the registry artifact.**
  A plugin artifact is shared by every composition holding the plugin, so it
  must not carry anything composition-specific. The module that is
  (`core/composition-modules.ts`: `@composition-web-registry` → `index.js`,
  the web registry) is type-stripped into the ONE per-composition registry
  artifact, addressed by its source. It sits behind a fixed bare specifier that
  is external to every build (`COMPOSITION_SPECIFIERS`) and mapped to the
  deployed composition's file.
- **A page worker is bundled whole, and its whole closure is its address.** A
  `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`
  (or a `SharedWorker`: networking's shared socket; Isle's bake workers) is
  built by vite's nested worker pass into `assets/<name>-<hash>.js` inside the
  artifact, its URL resolved against `import.meta.url` (hence `base: "./"`; the
  default emitted an origin-absolute `/assets/…` that 404s). Import maps do not
  reach workers, so the worker build has no externals: it inlines what it
  imports, other plugins' barrels included (`@plugins/<p>/core`). So the entry
  must be named `*.worker.ts(x)` — planning's `ownHashFor` (`own-files.ts`)
  takes every own module so named as a WORKER ENTRY and folds its Merkle key in
  the plugin-records module graph (its blob and the keys of everything it
  loads, transitively) into the artifact's address, and lists the closure's
  modules (`workerFiles`). The worker pass's inline audit allows exactly those
  beside the own files (the page bundle's still allows only its own roots), so
  a worker entry not named so, or one reaching a file the graph does not see (a
  glob, a gitignored file), fails the build instead of fossilising unhashed
  bytes; an import the graph cannot resolve fails planning. `assertWorkersSelfContained`
  hard-fails on any import left in a worker chunk (no dynamic `import()` in a
  worker). Worker chunks never join the import map or the preload closure
  (`parseEmittedImports` reads the top level only); `scanStagedModules` still
  re-lexes them. Being inside the artifact's content-addressed dir, a worker's
  URL changes exactly when the code it bundles does — so a SharedWorker
  instance is per worker version by construction. What a page worker cannot do
  is load a module the page names at run time (another plugin's contribution):
  that needs the worker link tree below, which only browser hosts have.
- **A browser host's worker loads the page's own per-plugin artifacts,
  through a link tree.** A fleet plugin with a `bin/browser-host.ts` (a Web
  Worker booting a portable server graph — `server-core`'s `bootBrowserHost`)
  gets its worker graph planned as artifacts (`planHostClosure`, `plan.ts`): the
  host's `bin/` (kind `bin`) and the barrel closure it reaches — one `server`
  artifact per graph member, the page's own `core` artifacts reused as they
  are. `server` and `bin` are worker-only kinds (`WORKER_ONLY_KINDS`): no
  import-map entry, no preload, no Tailwind candidates. Import maps do not reach
  workers, so each artifact in the closure gets a LINKED copy
  (`internal/worker-link.ts`, store entry `<dirName>.worker`) whose bare
  specifiers are rewritten to relative URLs spelled from names alone
  (`<plugin-id>.<kind>/index.js`, `_vendor/<entry>.js`) — a pure function of the
  artifact's bytes, so a dependency's rebuild never changes its importers. One
  `worker-tree.<hash>` store entry per build links them (and the vendor set);
  its hash combines its links, so a running worker never sees its tree change,
  and the page reaches the entry through the import map
  (`@browser-host-worker/<pluginPath>` — `host.js` calls `import.meta.resolve`
  on it). What a worker never loads (`@browser-host/*`, a browser-unreachable
  leaf's dynamic import) links to a module that throws when loaded. The "no
  Node builtins" gate is per artifact (`assertPortableArtifacts`, boundaries'
  `isPlatformApi`), before the vendor set is built. `scanStagedModules` scans
  each tree through its links, so the worker's relative imports are resolved
  and joined against their targets' exports like the page's. The host module
  itself (`internal/browser-hosts.ts`, served as `@browser-host/<pluginPath>`)
  is `host.js` plus the frame-serving Service Worker (`frames-sw.js`, a classic
  script bundled whole, keyed by its own recorded inputs).
- **A browser host's starting snapshot is an artifact keyed on everything
  that can change its bytes** (`internal/host-snapshots.ts`). A host declaring
  `bin/browser-host.snapshot.ts` gets it run once per address in a fresh Bun
  process (stage `artifacts:host-snapshots`), its file published with an
  `index.js` (`{ version, takenAt, load() }`, version = the file's hash) and
  linked into the worker tree as `<plugin-id>.snapshot`, which
  `@browser-host-snapshot/<pluginPath>` resolves to (external to every build,
  like `@browser-host/*`). Its address: the script's Merkle key in the
  plugin-records module graph (`buildModuleGraph`, static AND dynamic edges —
  so every server module the generated listing's loaders boot, every job,
  warm-up and fixture writer the seed runs, the disk swaps and host-storage's
  codec; derived, never listed), the data that code reads off disk (the glob
  files of the worker closure's artifacts — the migrations and committed
  config the worker inlines — and every file of the host plugin's `data/`),
  the npm resolutions (`lockfileNpmResolutions`, `infra/deps/npm/lock-resolutions`) and the
  `patches/` applied to them, the Bun version, the initialized PGlite cluster
  the take opens from (below) and the stage's layout. An
  import in the take's graph that resolves to no file throws.
  **A take never runs initdb**: its database opens from an initialized,
  empty PGlite cluster (`bin/pglite-cluster.ts`, one initdb in a fresh
  process, published as `pglite.pglite-cluster.<hash>/cluster.tar.gz`),
  keyed on what decides its bytes — PGlite's lockfile line, `patches/`, the
  script and a layout — so one is written per PGlite build and every take of
  every checkout shares it. initdb was half of a fresh take's
  `onReadyBlocking:database` (0.5–0.85 s of 1.0–1.6 s, foreground). A stale snapshot cannot ship: build
  pipeline step 8 had keyed it on data only, and a changed warm-up shipped
  stale data (`research/2026-11-06-global-host-snapshot-address-covers-what-runs.md`,
  with the re-take frequency this costs).
  `map-in-sync` derives the same links (`hostSnapshotLinks`) and reports a
  snapshot the store lacks as missing.
- **A crawlable composition's dist carries its pages' static snapshot, keyed
  like a host snapshot** (`internal/crawl-snapshot.ts`, stage
  `artifacts:crawl-snapshot`). Only when the build CLI passes `crawl` — a
  composition whose row says `crawlable: true` — so every other build skips
  the stage (0 s). The take is the repo's one `bin/static-host.ts`
  (`discoverStaticHostTake`; codegen's `static-host-gen.ts` writes its graph
  beside it), run once per address in a fresh Bun process with the
  composition, an out dir and the initialized PGlite cluster
  (`ensurePgliteCluster`, shared with the host snapshots). Its address: the
  module-graph Merkle keys of the take, of every web barrel of the
  composition's fleet and of every web barrel under the take's own plugin
  (its build-only render half, in no composition) — the take loads both
  through barrel-import, an edge no graph sees —, the files under every glob
  root those modules declare (what the take's disk swaps read in place of the
  bundled providers), all read off the build's repo snapshot: the working
  tree, so an uncommitted or untracked config edit moves the address
  (`crawl-snapshot.test.ts`), the npm
  resolutions, `patches/`, the Bun version, the cluster's address and the
  composition. Published as `<composition>.crawl-snapshot.<hash>`; compose
  links it under `artifacts/` (a prune root) and each of its top-level entries
  (`snapshot/`) at the dist root through that link — copied for a
  materialized dist. An unchanged tree is a cache hit: no process runs.
- **A browser host's inputs are recorded under the address they hash to.** The
  host artifact's address is the content of every repo file its build loaded
  (vite's module list), their directories' listings, each `import.meta.glob`
  static base's recursive listing, `bun.lock` and the builder identity. That
  list is only known after a build, so it is published INSIDE the artifact dir
  (`inputs.json`: `{ inputsHash, files, globRoots }`), never rewritten, pruned
  with it. Planning (build and `map-in-sync` alike) walks every stored build of
  the host, most recently used first, and takes the first whose recorded list
  this tree still hashes to its recorded address (`matchHostRecord`; one
  memoized hasher, so each file is read once); none ⇒ the host builds. Never
  add a per-host "latest" record: the store is shared by every checkout, so
  whichever built last would overwrite it and every other checkout's
  `map-in-sync` would recompute its address from a foreign file list.
- **An artifact's address covers its glob roots.** A literal
  `import.meta.glob` inlines what it matches, possibly outside the plugin (the
  bundled migrations' `data/*.sql`, the repo's `/config/**`). Each pattern's
  static base is a glob root (`globRootsOf`, `own-files.ts`): its files join the
  address and the inline audit's allowed roots. A non-literal pattern, or a
  base as wide as the repo or `plugins/`, throws.
- **An imported image is a file of its artifact, never base64 in its JS.**
  vite's library mode inlines every imported asset whatever
  `assetsInlineLimit` says; `imageAssetsPlugin` (`core/internal/image-assets.ts`)
  takes image imports first and emits each file into the artifact beside its
  modules (served from the content-addressed store dir like a worker chunk,
  its URL `new URL("<file>", import.meta.url)`), the module evaluating to
  `framework/image-import`'s `ImportedImage` (`{ src, width, height }`, the
  size read at build time so the page reserves the box). An image it cannot
  size (`.svg`, `.avif`, `.ico`) fails the build.
- **Vendor assets follow their module.** A bundled npm module fetching a file by
  `new URL("./x.wasm", import.meta.url)` gets it beside every output holding it
  (`internal/package-assets.ts`), hard-linked from a per-content store entry
  published (precompressed) once — rebuilding the vendor set never recompresses
  PGlite's 16 MB.
- **An artifact's address covers exactly what its bytes inline.** The store
  reuses an artifact whenever its address matches, so any source file whose
  content reaches the bundle but not the hash fossilises the artifact: it is
  served forever against sibling code it was never built with. The inlined-folder
  set is therefore ONE list (`inlinedRootsFor` in `core/own-roots.ts`, `[kind,
  "shared", …its co-built folders]` — `web` also inlines `exhibits`), read by both the address side (`listOwnFiles`) and the content
  side (the externals predicate + the own-folder-barrel rewrite); every other own
  folder is external, routed to its own barrel. Backed by an assert that trusts
  neither: `createInlineAudit` reads the module ids rollup actually emitted
  (`generateBundle`) and hard-fails on any first-party file the address did not
  hash (the target's `ownFiles` + `globFiles`, exactly what planning read off the
  repo snapshot — so a gitignored file, or one written after the snapshot, fails
  too). Root containment alone is not enough: test code
  (`web/testing/`, `__tests__/`, `*.test.ts`) sits inside `web/` but is never
  hashed, so a shipping file that reached it would bake unhashed bytes into the
  bundle. The boundary check already bans that import; the audit catches it
  when the check was skipped. Before this, a `fixtures` barrel (the layout
  harness's former leaf folder, now `exhibits/`) inlined its plugin's whole
  `web/` while hashing only `fixtures/` — moving an export out of a sibling plugin surfaced as
  a compose link failure against an hour-old fossil, and the `prewarm` barrels
  inlined an unhashed `shared/` (`…/mirror`) the same way.
  (`research/2026-08-17-global-artifact-address-covers-content.md`)
- **A dist names itself by its content, not by its run.** Compose injects
  globals into `index.html` — `the graph global (GRAPH_GLOBAL)` (`computeGraphHash`: a pure
  function of the source shell, import map, entry, global CSS and preload
  closure, every one of them already content-addressed, plus every page pin a
  reload changes) and the page pins (`pagePins`): the commit (the tree the
  caller sampled BEFORE it read a source file) and the central build the tab
  judges central's values against. Each pin must declare `identity: "covered"`
  (hashed: a redeploy changing only central code is a new page, so its tabs
  are stale and told to reload) or `"excluded"` with a reason (the commit moves
  with the tree when the bytes do not); the hash and the injected script read
  the one list, so no value reaches the page undecided. The graph hash is what the
  caller writes to `.build-graph` and what a tab compares itself against, so two
  builds of an unchanged tree don't ask every open tab to reload. The run id
  (`buildId`) stays out of the bundle: it changes on every build by construction,
  which is exactly what made the old `build-id` nonce useless as
  an identity — and it also gave every compose-serve composition the SAME pin
  despite each composing a different closure.
- **The global stylesheet never blocks the first paint.** Compose writes it
  `media="print"` (fetched at t0, matching nothing) with an inline script that
  applies it on `load`, and hides the body's children until then
  (`stylesheetHead`): the first frame is the themed canvas, whose CSS is inline,
  instead of a blank tab until the stylesheet wins its share of a connection
  carrying the whole modulepreload closure. A failed load is web-core's
  boot-failure screen. The markup is hashed into the graph identity.
- **Every served file is compressed once, when it is published.** All three
  write-once caches (artifact store, vendor sets, global-CSS cache) publish
  through ONE `publishDir` (`core/internal/store.ts`): precompress the tmp dir
  (`precompress.ts`: `<file>.br` q9 — q11 is 30× slower for 6 % — and
  `<file>.gz` -9, for js/css/json/wasm/data/svg/
  html/… ≥ 1 KiB, kept only when ≥ 5 % smaller), write `meta.json`, rename. So
  no entry is ever visible without its sidecars and nothing backfills; compose
  precompresses the shell's own top-level files in staging. The gateway only
  negotiates (`gateway/encoding.go`). Readers that list an entry's files filter
  by extension, so a `.br`/`.gz` never reads as a module.
- **No build prunes; the scheduled `web-artifacts.prune` job does**
  (`plugins/prune`, hourly, main only, in a supervised child). The prune is
  O(the host's caches) — what every dist links plus a stat of every
  unreferenced entry — and it used to open every build's `detect` stage, which
  a file-metadata stall turned into minutes. A dist's links are read ONCE in
  its life (~2.4k readlinks; ~450k for a whole host of 120 worktrees): the
  scan memoizes each dist's targets in `dist-links/`, stamped with its
  `artifacts/` dir's inode+mtime, and trusts a memo only while that stamp still
  matches — so a scan is O(dists) plus the links of the dists published since.
  It runs in two phases (`pruneWebArtifactCaches`): UNLOCKED, collect every
  dist's targets (`scanServedDists`, each dist stamped BEFORE its links or memo
  are read) and survey every cache dir (`surveyCacheDir`);
  then under the EXCLUSIVE store lock, read the leases, re-read only the dists
  that are new or whose stamp moved (`refreshServedDists`), judge the surveys
  against those roots, and re-stat each victim before deleting it (a reuse
  since the survey bumped its mtime ⇒ kept). So the lock every build's pins
  wait on is held for O(dists + victims). An entry published after the survey
  is in no survey, so never a victim.
- **A prune can never remove what a build in progress will compose.** The
  prune runs while builds are between reusing/publishing entries and composing
  them — minutes in which no dist links them yet. So each pipeline run holds a **build lease**
  (`core/internal/lease.ts`): it PINS every entry (page and worker artifacts,
  registry, browser host, worker links and worker tree, vendor set, package
  assets, CSS cache dir) — a line of its own lease's pin file
  (`~/.equin/cache/web-artifacts/leases/<pid>-<rand>/pins`, one append per
  batch; a symlink per pin cost ~0.6 s of every build to make and remove, and
  a prune still reads a lease left in that form) — BEFORE it checks the
  entry exists or publishes it, and releases the lease after compose, once the
  staging dist (`web.staging.*`, a root) links everything. Pins take a SHARED
  flock on `store.lock`; `pruneWebArtifactCaches` holds it EXCLUSIVE while it
  reads the leases, refreshes the dist roots and deletes, so the two never
  interleave: a pin that
  lands first is a root, a prune that lands first is over before the build
  looks, and a planned reuse it removed is simply built (`ensure` re-checks
  `hasArtifact` after pinning). The release removes the lease dir under the
  shared lock too, so a prune never reads a half-removed lease. Concurrent pins
  of one lease fold into one batch (`createCoalescer`): a contended lock costs
  one `waitForFlock` child per lease, never one per pin (a build pins ~1,700
  artifacts at once). The lock also serializes concurrent prunes.
  Crash-safe through the kernel, like `.build.lock`: the owner holds an
  exclusive flock on the lease's `owner.lock` for its life; a prune that can
  take it knows the owner died and reaps the lease. No pid, no heartbeat, no
  age grace. **The count cap bounds the UNREFERENCED population only**
  (`maxUnreferenced`/`trimTo`): roots (dist links + leases) are never victims
  and never counted. It used to count roots, and once the fleet's dists alone
  linked more entries than the cap (~10,800 vs 8,000), every prune deleted
  EVERY unreferenced entry — including what concurrent builds had just
  published — and compose failed with "N mapped URL(s) do not resolve to a real
  file" on every build. Removal tolerates exactly a concurrent remover
  (`removeCacheEntry`: ENOENT, or macOS's EPERM when the top path vanished
  mid-rm, iff the entry is gone; once retried if it is still there). A build
  running code older than this neither pins nor locks, so its prune can still
  remove a new build's entries until every checkout has rebased.
- **A group of store entries is listed through its index, never the store.**
  A browser host's planner tries every stored build of the host
  (`storedHostRecords`); listing the store for the `<slug>.browser-host.`
  prefix read all ~27k store names on every build. Each group is an index dir
  (`index/<group>/`, one empty file per member) written at publish
  (`indexArtifact`) and swept by the store prune (`STORE_PRUNE_POLICY.index`);
  a missing index is built from the store once.
- **Every address is read off ONE repo snapshot, by content id.** The pipeline
  takes `loadRepoSnapshot` (tooling `core`) once, after codegen and the
  formatter wrote, and plans every target from it (`OwnSources`): the file list
  is `snapshot.under(root)` filtered by `isHashedFile`, the hash is over
  `(rel, blob id)` lines, the builder identity's source digest and `vite/`
  contributions are blob ids too. No walk, no stat, no per-worktree cache — a
  fresh worktree knows every address at once. The one content fact an address
  needs beyond ids, each module's `import.meta.glob` patterns, is memoized by
  blob id in the shared `glob-patterns.json` (`GlobPatternMemo`), so only an
  edited module is ever read. A file outside the snapshot is in no address; the
  inline audit (above) fails a build that bundles one.
  (`research/2026-11-03-global-build-pipeline-step3c-repo-snapshot.md`)
  Inside a build this fresh snapshot is also the check of the build's repo
  view (tooling `core`'s `openRepoView`, which codegen read instead of listing
  the tree again): `assertAgrees` fails the build when any file codegen keyed
  off the view no longer holds what the view said.
- **Expected vs deployed cannot drift**: the pipeline and the
  `web-artifacts:map-in-sync` check share the same planning code
  (`core/internal/plan.ts`).
- **Ground truth is verified independently of the planner.** Because the map
  assembly and the metadata-based coverage check share one scanner, a scanner
  blind spot makes both wrong identically (the unscanned-`.mjs`-chunks outage:
  specifiers imported only by a lazy chunk got no vendor/map entry and the
  build passed). Compose therefore ends with `scanStagedModules`
  (`core/internal/staged-verify.ts`): re-lex every staged `.js`/`.mjs` file the
  browser will actually fetch and hard-fail on any unresolvable import.
- **Builder edits auto-invalidate the fleet.** The builder identity hashes this
  plugin's own `core/` source (`builderSourceDigest`), and the vendor-set key
  includes it too — changing scanner/compose/vite/vendor semantics can never
  silently reuse stale artifacts. `BUILDER_VERSION` remains only as a forced-bump
  lever.
- **The global stylesheet is compiled from the artifacts' candidates, never a
  scan.** Each artifact records the Tailwind candidates of exactly the files its
  address hashed (`tailwindCandidates` in its meta, `internal/tailwind-candidates.ts`);
  the CSS stage compiles their union over the composition with
  `@tailwindcss/node`, cached by the union's key. The inline audit makes this
  complete: an artifact ships only files it hashed, so every shipped class is a
  candidate. Extraction goes through the scanner's file path, one source per
  file — `scanFiles` on raw content disagrees with Tailwind's own per-file rules.
  app.css keeps `source(none)` (auto-detection from the repo root walked
  `.claude/worktrees/` on main, ~5s → ~320s) for the scans Tailwind still runs
  itself; `tailwind-scan-covers-classes` guards it.
- **A young entry is never a prune victim.** A prune never deletes an entry
  modified within a minute of its call (it counts toward the cap, never as a
  victim): a build of this code pins before it publishes, but a build running
  older code publishes without a lease, and no root can speak for its entry
  yet. (The build lease above superseded a per-dist `<live>.pins/` link dir,
  which pinned only after reading or publishing, so a prune could still take a
  reused entry in between; the dist sweep reclaims a leftover one.)
- **A served dist keeps serving every address a recently needed graph of its
  namespace links, for O(new names) per build.** A tab resolves imports only through the import
  map of the page it loaded, and fetches much of it lazily — hours later for a
  background tab. So a served namespace has ONE persistent address dir
  (`<ns>/web-addresses`, `distAddressesPath` in the build CLI): every release's
  `artifacts` is a link to it, and compose (`addressDir`) adds this graph's
  names to it — only the absent ones; an existing name must already link the
  same store path, else compose throws. Nothing is re-linked per build: the old
  scheme (`carryForwardServedEntries` recreating every live link in staging)
  re-created ~37k links on main, ~5 s per build, growing by one fleet per
  builder-identity change
  (`research/2026-11-06-global-build-pipeline-step7-real-world-split-v2.md`).
  The dir is seeded once from a dist composed before it existed
  (`seedAddressDir`, `cli/`). Because the dir holds more than this graph, the
  ground-truth scan (`scanStagedModules`) reads the links compose made, never a
  listing of `artifacts/`. `assets/` (the copied stylesheet and fonts) is still
  carried by `carryForwardServedEntries`, kept while some CSS cache dir holds
  the name. Releases never carry and link nothing (`materialize`). Safe because
  every address is write-once (a hash of what its bytes inline; a second
  publish of an address is discarded), so an old tab gets exactly the files it
  was built with and cannot reach a newer build's, and adding a link never
  changes what a published release serves (publish `keep`/`revert` remove a
  release's `artifacts` link, never the dir it names).
  **What stays is bounded by recent graphs, not by history** (address
  retention, `cli/internal/address-retention.ts`, run by the build before the
  publish). A graph (one composed bundle, `.build-graph`) is NEEDED while a
  build composes or serves it, or an open tab names it — the backend touches
  its record when a tab's subscription or resource read carries the graph
  (`build/server-build-id`, through server-core's `setClientBuildObserver`; at
  most hourly per graph). Each namespace keeps one record per graph beside its
  dist (`<ns>/web-graphs/<graph>.names`, `webGraphRecordsDir` in
  `infra/paths`: the names the pipeline linked, `linkNames`; mtime = last
  needed) and an `index.json` of each name's last-needed time, so a build reads
  only the records written or touched since the last one. An address stays
  while a graph needing it was needed within `ADDRESS_RETENTION_MS` (a day);
  the composed and the served graph always stay. A tab whose graph aged out
  fails to load what it lacks, loudly (the red reload chip), never silently.
  Unbounded before: every link was a prune root, so the store grew with
  builds × namespaces (main's dir 80k links, the store 115k entries,
  2026-11-11). Only builds write the address dir, under the checkout's
  `.build.lock`; the prune job never edits it.
  **Pruning never breaks a served dist.** `pruneWebArtifactCaches`
  (`core/internal/lease.ts`; one `pruneCacheDir` policy per cache —
  `STORE_PRUNE_POLICY`, `VENDOR_PRUNE_POLICY`, `CSS_PRUNE_POLICY`,
  `PACKAGE_ASSETS_PRUNE_POLICY`: 14-day
  age-out, then an oldest-first count trim) treats every `artifacts/<name>` link
  target of every dist under the worktrees dir (`web`, `web.live.*`,
  `web.staging.*`, release scratch dists — `core/internal/served-dists.ts`,
  read through each dist's `artifacts` link, so a namespace's address dir is
  read once however many releases name it) as a root: never deleted by age or by the cap. Only unreferenced entries age out.
  A run removes at most `MAX_REMOVALS_PER_PRUNE` entries per cache (oldest
  first; the rest wait for the next run), because removal holds the exclusive
  store lock every build's pins wait on — a one-time un-rooting (main's first
  address-retention trim) must drain over a few runs, not stall builds.
  (Before this, an idle worktree lost its modules to the fleet's builds and
  never booted again.) Dead dists release their entries when their worktree is
  reaped.
  The seed, the assets carry and address retention live in `cli/`, not `core/`, because
  `builderSourceDigest` hashes all of `core/` into every address.
  (`research/2026-09-10-global-stale-tab-plugin-loading.md`)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Per-plugin web build artifacts: content-addressed vite lib-mode builds composed via an import map
- Core:
  - Uses: 50 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `packages/timed-fs` ×8
    - `framework/import-map-names` ×5
    - `framework/plugin-id` ×4
    - `framework/web-core` ×4
    - `infra/host-fs/user-path` ×4
    - `packages/flock` ×4
    - `apps-core/app-preload` ×3
    - `framework/image-import` ×3
    - `plugin-meta/plugin-records` ×3
    - `framework/tooling` ×2
    - `packages/owned-fd` ×2
    - `framework/browser-server/host-storage.decodeHostSnapshot`
    - `framework/product-name.LEGACY_IDS`
    - `infra/deps/npm/lock-resolutions.lockfileNpmResolutions`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `infra/paths.worktreesDir`
    - `infra/spawn.spawnCaptured`
    - `packages/coalesce.createCoalescer`
    - `packages/semaphore.createSemaphore`
  - Exports (types):
    - `ArtifactBuilder`
    - `ArtifactBuildRequest`
    - `ArtifactKind`
    - `ArtifactMeta`
    - `FleetSource`
    - `ImportMapEntry`
    - `OwnFile`
    - `PruneReport`
    - `VendorSetMeta`
    - `WebArtifactsPipelineOptions`
    - `WebArtifactsPipelineResult`
  - Exports (values):
    - `barrelKindOf`
    - `BROWSER_UNREACHABLE_DYNAMIC_KINDS`
    - `BUILDER_VERSION`
    - `buildImportMap`
    - `COMPOSITION_SPECIFIERS`
    - `compositionFleetSource`
    - `computeIdentityHash`
    - `computeInputsHash`
    - `computeOwnHash`
    - `computePreloadClosure`
    - `createArtifactBuildHandler`
    - `defaultFleetSource`
    - `discoverStaticHostTake`
    - `findUnmappedDynamicWarnings`
    - `findUnmappedSpecifiers`
    - `firstSegmentOf`
    - `FORCED_VENDOR_SPECS`
    - `INLINE_PACKAGES`
    - `inlinedRootsFor`
    - `isBareSpecifier`
    - `isBrowserUnreachableDynamic`
    - `isInlinedPackage`
    - `isWorkerChunkPath`
    - `isWorkerTreePath`
    - `makeArtifactExternal`
    - `packageNameOf`
    - `pruneWebArtifactCaches`
    - `readFleetVendorMeta`
    - `runWebArtifactsPipeline`
    - `sha256Hex`
    - `SHARED_ROOT`
    - `STATIC_HOST_ENTRY_REL`
    - `WORKER_ASSETS_DIR`
- Cli:
  - Uses: `packages/thread-pool.createThreadPool`
  - Exports (types): `CarryForwardResult`
  - Exports (values):
    - `carryForwardServedEntries`
    - `createPooledArtifactBuilder`
    - `idealArtifactBuildThreads`
    - `retainAddresses`
    - `seedAddressDir`
    - `servedGraphOf`
- Cross-plugin:
  - Imported by:
    - `apps/demo`
    - `framework/cli/build`
    - `framework/tooling/codegen`
    - `framework/tooling/e2e-harness`
    - `framework/tooling/web-artifacts/prune`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/hash.ts`, `core/internal/browser-hosts.ts`, `core/internal/compose.ts`, `core/internal/global-css.ts`, `core/internal/host-snapshots.ts`, `core/internal/crawl-snapshot.ts`, `core/internal/identity.ts`, `core/internal/lease.ts`, `core/internal/own-files.ts`, `core/internal/package-assets.ts`, `core/internal/pipeline.ts`, `core/internal/plan.ts`, `core/internal/precompress.ts`, `core/internal/served-dists.ts`, `core/internal/staged-verify.ts`, `core/internal/store.ts`, `core/internal/tailwind-candidates.ts`, `core/internal/vendor-cache.ts`, `core/internal/vendors.ts`, `core/internal/vite-builder.ts`, `core/internal/worker-link.ts` (debt)
    - `user-path/no-unproven-claim` — `core/internal/identity.ts`, `core/internal/plan.ts`, `core/internal/vendors.ts` (sanctioned)
    - `user-path/no-unproven-claim` — `core/internal/vendor-cache.ts` (sanctioned)
    - `user-path/no-unproven-claim` — `core/internal/global-css.ts`, `core/internal/package-assets.ts`, `core/internal/staged-verify.ts` (sanctioned)
    - `repo-walk-safety/no-adhoc-repo-listing` — `core/internal/pipeline.ts` (sanctioned)
    - `blocking-fs/sync-named` — `core/internal/browser-hosts.ts`, `core/internal/compose.ts`, `core/internal/global-css.ts`, `core/internal/host-snapshots.ts`, `core/internal/crawl-snapshot.ts`, `core/internal/identity.ts`, `core/internal/lease.ts`, `core/internal/package-assets.ts`, `core/internal/pipeline.ts`, `core/internal/plan.ts`, `core/internal/precompress.ts`, `core/internal/served-dists.ts`, `core/internal/staged-verify.ts`, `core/internal/store.ts`, `core/internal/vendor-cache.ts`, `core/internal/vendors.ts`, `core/internal/vite-builder.ts`, `core/internal/worker-link.ts` (sanctioned)
- Sub-plugins:
  - **`prune`** — The hourly web-artifacts.prune job: prunes the shared write-once web caches (artifact store, vendor sets, CSS cache, package assets) off every build's path — dist links read unlocked, only changed…

<!-- AUTOGENERATED:END -->
