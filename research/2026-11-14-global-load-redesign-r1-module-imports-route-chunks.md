# Load redesign R1: module-granular cross-plugin imports, served as route chunks

Task `task-1794615000-vyqet0` (step M2 + route chunks of
[the load-model redesign](./2026-11-12-global-load-model-redesign.md), §9 steps 9 and 13, reshaped
by §12.1, §12.5 and §14).

## Context

A page loads plugin code as one artifact per plugin folder (`<p>.web.<hash>/index.js`), resolved
through a 1,950-entry import map. Two consequences (§12–§14 of the redesign doc):

- **Barrel grain.** `import { cn } from "@plugins/…/ui-kit/web"` evaluates the whole ui-kit
  artifact and every vendor it imports (~100 KB br on `/about`); importing a page's pane loads
  the page; the plugin registry's `import("@plugins/x/web")` evaluates every re-export of every
  registered plugin, not just its `default` (the plugin definition). M1 measured that module-
  granular resolution roughly halves the website's route set.
- **Per-file delivery.** `/about` preloads 605 files, main `/agents` 1,676. M1 measured that
  emitting one file per module costs +24 % brotli and multiplies requests on the local HTTP/1.1
  gateway (97–99 % of the preload phase queued), so the modules must be re-grouped into a few
  files per route ("route chunks") — required, not optional.

Goal: a cross-plugin import loads only the module defining the export (and what that needs), while
a route is still served as a few compressed files. Keep the plugin boundary rules (authors still
write `@plugins/<p>/web`) and content-addressing.

## What the spikes settled (2026-11-14, scratch, main's served dist)

1. **Re-bundling the served artifacts with rolldown works and is cheap enough**: main's 1,937
   artifact modules → 91 boot chunks (`codeSplitting.groups[].maxSize` 300 KB) in ~4–8 s with
   sourcemaps. Boot first-party bytes **3.45 MB br in 1,564 files → 2.37 MB br in 91 files**
   (−31 %, from cross-module compression alone).
2. **Statement-level tree-shaking does not give module granularity.** Making the registry import
   only `default` of each (single-file) artifact cut 1.3 %: modules keep their top-level calls
   (`defineSlot(…)`, `memo(…)`, contributions), so the unit must be the module.
3. **`treeshake.moduleSideEffects: false` is unsafe**: rolldown then drops the side-effect
   statements of modules whose exports ARE used (a used module's `console.log` vanished in the
   fixture). And marking only facades side-effect-free does not drop side-effectful re-exported
   modules. So elision must be explicit: rewrite each named import to the module that defines it.

## Design

### A. Artifacts keep module boundaries (builder)

Page-loaded kinds (every kind but `WORKER_ONLY_KINDS`) build with
`output.preserveModules: true, preserveModulesRoot: <plugin dir>`; the barrel entry stays
`index.js` (co-entries `<folder>.js`), every other module lands at its plugin-relative path
(`web/components/x.js`). Content-addressing is unchanged (same address inputs; the builder
identity changes once, so the fleet rebuilds once).

A web barrel gains a second entry, **`__plugin.js`: the barrel minus its re-exports** (its imports,
side-effect imports included, and its `export default`). The barrel itself re-exports `default`
from it, so there is one plugin-definition object. Barrels are pure (R3), so the split is
mechanical (rolldown's `parseAst`, TS): drop `ExportNamedDeclaration`s that re-export (with a
`source`, or a bare export list). The registry's `import("@plugins/x/web")` resolves to it at link
time — the registry reads only `.default` (`web-sdk/core/loader.ts`).

Assumptions that were flat and become recursive: `parseEmittedImports`, `artifactSourcemaps`,
`assertCoEntriesOffHostPath`.

### B. Link: the page's modules → route chunks (new stage `artifacts:link`, `core/internal/link.ts`)

After vendors, before compose, over the page artifacts + registry + entry:

1. **Elision pre-pass.** Parse each module's imports (es-module-lexer + `import-clause.ts`). For a
   named import/re-export of an `@plugins/…` barrel, follow the target artifact's re-export hops
   (`export { a as b } from "./y.js"`, `import { a as t } …; export { t as b }`) to the defining
   module and rewrite the statement to import from it. Namespace imports and non-registry dynamic
   imports keep the barrel (whole artifact). Registry dynamic imports of a web barrel →
   `__plugin.js`.
2. **Membership** over the elided graph: `boot` = static closure of the entry + the eager plugins'
   `__plugin.js`; `app:<root>` = closure of that app's deferred plugins minus boot (today's
   `appPreloadSeeds`); everything else is lazy.
3. **rolldown** over that graph (first-party modules read from the store with their input
   sourcemaps; vendors, `@browser-host*` and the worker specifiers external), with
   `codeSplitting.groups`: `boot` (maxSize ~250 KB → a few files per route on HTTP/1.1),
   one group per app root, default chunking for lazy code. `new URL("<rel>", import.meta.url)` is
   rewritten to the module's absolute served path (images, workers); any other relative
   `import.meta` use fails the link.
4. **Publish** each chunk as its own store entry `chunk.<hash16>/index.js` (+ map, precompressed by
   `publishDir`), so an unchanged chunk keeps its URL across builds, and the link result as a
   record entry `link.<key16>` (key = the input addresses + vendor set + builder identity): a tree
   whose page artifacts did not change reuses it without running rolldown.

The page then loads only chunks + the vendor set + host modules. The import map keeps only what
stays external (vendors, `@browser-host/*`, `@browser-host-worker/*`, `@browser-host-snapshot/*`)
— the ~1,900 `@plugins/*` entries leave it. Worker trees are unaffected (they link per-plugin
artifacts, already depth-aware).

### C. Compose / checks

- Compose seeds the modulepreload closure from the link result (entry chunk, boot chunks, per-app
  chunks) over the chunk import graph; links the chunk entries instead of the page artifacts.
- `map-in-sync` re-derives the link key from the plan and compares it with the dist's recorded
  link (a `.web-link.json` beside `DIST_EDGES_FILE`); never reads the store.
- `scanStagedModules` scans what the page loads (chunks, vendors, hosts, worker trees).
- Leases pin chunk/link entries before checking them; retention/prune treat them like any entry.

### Semantics change (deliberate) and its guard

A module only re-exported by a barrel is no longer evaluated unless someone imports a binding from
it (or the barrel's `__plugin` imports it). Side-effect imports in barrels (21 barrels:
`./internal/register`, …) stay in `__plugin`, so the registrations they exist for are kept.
Verification watches for a descriptor the boot snapshot cannot resolve (it reports one loudly).

## What building it taught (deviations from the plan above)

- **Size-split groups create chunk cycles.** A boot group cut by `maxSize` is an arbitrary cut
  through the module graph; two boot chunks imported each other and one ran before its
  dependency's bodies (`defineSlot` pushing into a registry array not yet initialized). Fixed with
  rolldown's `strictExecutionOrder` (module bodies run in source order whatever chunk holds them).
- **Groups must not capture dependencies.** rolldown's `includeDependenciesRecursively` (default on)
  let the first group reaching a shared module take it, so `/about`'s website group imported a chunk
  of the demo's Pages/Places/agent-manager code for one helper (`assetMirrorFile`): the page editor,
  lexical and yjs came back (+300 KB br). The groups are dependency-closed by construction, so it
  is off. And a module several apps reach sits in a group keyed by the *set* of app roots, never
  claimed by the first.
- **Boot-registering descriptors.** A module declaring a `preload: "boot…"` descriptor was registered
  because its whole barrel was evaluated at boot. Such modules of artifacts the boot evaluated under
  barrel semantics are boot roots of their own (6 on the website, 19 on main). Applying it to every
  page artifact pulled the demo's on-demand descriptors into boot.
- **A head script imports a barrel by specifier** (the demo's prestart, sharing module state with
  the app). Such barrels are a closed list (`PAGE_SCRIPT_MODULES`, `framework/import-map-names`): each
  is a link entry of its own, mapped by its specifier — one instance with the app's.
- Vite spells a worker URL `new URL(new URL("<rel>", import.meta.url).href, "" + import.meta.url)`;
  the link rewrites the inner URL to the file's absolute `/artifacts/…` path and drops the outer.
- `modules.json` in each `link.<key>` record says which group and chunk every module went to — what
  answered "why is the page editor on `/about`", and what R4's budget check can name chains from.

## Measurements (2026-11-14, this checkout's builds)

Bytes: every `<link rel=modulepreload>` of the served HTML plus the entry, fetched with
`Accept-Encoding: br` (`web-artifacts/scripts/measure-route-set.ts`). The website app's own preloads
(spliced per app path by the gateway) are included.

| | `/about` before | `/about` after | `/agents` before | `/agents` after |
|---|---|---|---|---|
| Files preloaded (+ entry) | 611 | **104** | 1,679 | **199** |
| — first-party / vendor | 538 / 73 | 36 / 68 | 1,567 / 112 | 91 / 108 |
| br bytes | 1.72 MB | **1.31 MB (−24 %)** | 4.42 MB | **3.45 MB (−22 %)** |
| — first-party br | 1.24 MB | 0.87 MB (−30 %) | 3.46 MB | 2.52 MB (−27 %) |
| — vendor br | 478 KB | 440 KB | 961 KB | 929 KB |
| HTML (raw) | 319 KB | **81 KB** | 493 KB | **95 KB** |
| Import map | 195 KB, 1,564 entries | **7 KB, 83** | 243 KB, 1,952 | **7 KB, 86** |
| Link (cold / reused) | — | 2–6 s / 0 s | — | 5.3 s / 0 s |

Modules: the website links 5,437 modules (1,637 at boot → 27 chunks, ~14k imports elided); main
6,845 (5,300 at boot → 88 chunks, ~18.6k elided).

Load (`debug/profiling/cold-start`, fresh browser context per run, medians; the host's load average
was 20–75 and moved between runs, so only interleaved pairs compare):

| Interleaved pair | DOMContentLoaded | eager plugins loaded | route content |
|---|---|---|---|
| `/about` cold, base → after (5-min load ~25 both) | 256 → **107 ms** | 552 → **235 ms** | 1,016 → **668 ms** |
| `/about` warm HTTP cache (`--code-cache`) | 119 → **57 ms** | 237 → **150 ms** | 531 → **490 ms** |
| `/agents` warm server, cold browser, round 1 (main's deploy → this build) | 619 → **304 ms** | 3,331 → **1,760 ms** | 3,719 → **2,204 ms** |
| `/agents` round 2 | 354 → **193 ms** | 1,738 → **957 ms** | 1,957 → **1,182 ms** |

What is left on the routes is now set by membership, not grain: the website still loads the whole
data-view cluster and the theme customizer at boot because plugins that contribute to boot slots
carry them (R2: lazy contribution implementations), and every non-app plugin is eager (R3). Route
content on `/about` is now gated by the server's boot snapshot (~0.4–0.9 s under load), not code.

## Verification

- `./equin test` on web-artifacts (+ new link tests: elision hops, `__plugin` split, membership).
- `./equin build` (main) + `--composition website`; screenshots of `/agents`, `/about`; console
  free of load errors; boot snapshot resolves every key; a lazy pane (pages, settings) opens.
- `./equin check`.
