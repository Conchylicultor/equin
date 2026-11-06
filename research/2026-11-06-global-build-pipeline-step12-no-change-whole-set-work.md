# Build pipeline step 12: a no-change build still re-does whole-set work

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1794000380-vnujhc. Previous step: `2026-11-06-global-build-pipeline-step11-no-change-build-and-checks.md`.

## Context
After step 11, a W0 build (nothing changed) is ~7.2–7.9 s on the quiet VM. Step 11 listed what is still whole-set: plugin docs 1.25 s, compose 1.17 s, the module graph 0.75 s, browser-host coverage ~0.8 s, the overlay's `ls-files --ignored` 0.23 s. Goal: each costs what changed. Measure first, fix by size.

## 1. Measured (host, this worktree, W0 `--skip-checks`, 2026-11-06)
Three profiled W0 builds: Bun `--cpu-prof` of the build process (inclusive time per function, plus the samples inside each span's window), and a temporary trace of every `buildModuleGraph`, `scanFilesCached` and record-store `getMany` call. Wall 11.7–13.0 s on the loaded host; profiled 9.5–10.7 s.

| Span | ms | Where it goes |
| --- | --- | --- |
| `pluginDocs` | 1,015–1,345 | **render 0.27 s** (test-helper discovery 0.14 s: `existsSync` of 3 candidate barrels × ~1,700 plugins, then the read of every `CLAUDE.md`). **The rest is its inputs**: the server barrels' module graph 0.26 s, the facet records read a SECOND time 0.18 s, the evaluation records 0.1 s, relating facets 0.05 s |
| `artifacts:compose` | 746–760 | `scanStagedModules` 0.59 s: **`realpathSync` 0.33 s + `existsSync` 0.1 s** for every staged file and every import edge; lexing is 0.04 s and reading 0.035 s |
| lease release (tail of `viteBuild`) | ~0.5 | the lease is a dir of ~2,400 pin symlinks: `rmSync` of it 0.47 s, plus 0.13 s of `symlinkSync` to make them |
| `browserHostInfer` + `Coverage` | 0.8–1.3 | coverage's `parseShape` 0.25 s (masking every scoped source file for re-exports and page-bound imports, read from disk every build) |
| record reads (spread over the spans) | ~0.9 | `getMany`: **7,483 calls for 106k `file` keys** (0.65 s), 37k `facet` keys in 2 calls (0.22 s): see below |
| record keys (spread) | ~0.42 | `recordKey` → `sha256Hex` is `@noble/hashes` (pure JS) even on Bun: ~140k keys per build |

**Why the record layer is O(repo) per build, three times over:**
* **9 module graphs per build**, each walked from scratch over the same snapshot: facet identities, portability (4,692 modules), three browser-host closures (1,318 / 2,321 / 838), the drizzle verdict (1,886), the web evaluation (7,308), the server evaluation (10,773), the host snapshot (2,583). ~31k module visits, each a record read + resolution + Merkle hashing, for ~11k distinct modules.
* **The same keys read twice**: the facet records (barrel-free tree, then enriched tree: 2 × 18,678), the icon scan (2 × 12.7k), data views (2 × 4.9k).
* **One `getMany` per plugin**: the eager-tier scan calls `scanFilesCached` once per plugin (5,094 calls), the registry's import scan once per plugin dir (2,245): each its own SQLite statement.

A key lookup itself is ~6–15 µs on the 1 GB store (3.3M `file` keys): measured alone, 12k keys in 150–220 ms with a cold connection.

Not this track's, seen in the same profile: `tsc:repo` (critical path, build-and-push speed), `typescript` module load 0.77 s and `eslint` 0.13 s in the build process (both `tsc:repo`'s), CLI start-up ~0.5 s.

## 2. Fixes, by size

### a. The record layer reads each fact once per build
* **`sha256Hex` uses the host's native digest when it has a synchronous one** (`Bun.CryptoHasher`), else `@noble/hashes`: the same bytes on every host (a test pins it against noble), so no stored key moves. A primitive-level fix: every caller of `string-hash` gets it.
* **The record store answers a key once per process.** A record is a pure function of its key, so `getMany` keeps what it read (and what it put) in a per-process map and asks SQLite only for keys it has never seen. Not a fingerprint: a key is the full identity of its value. This collapses the facet, icon and data-view re-reads, and every re-walk's file facts.
* **One module graph per snapshot.** `buildModuleGraph` keeps one growing graph per `(snapshot, written)` input: a call walks only modules no earlier call on that input reached, and Merkle keys are computed over the union (a module's key depends only on its own closure, so it is the same whichever entries asked). The 7 graphs over the first snapshot become one walk; the evaluations, which read later snapshots (after codegen wrote), get their own.
* **Scans batch per generator**: the eager-tier and registry import scans pass all their files to one `scanFilesCached` call, then group by plugin (7,339 SQLite statements → 2).

### b. A build lease is one file, not a dir of links
Pins are appended as lines to one `pins` file in the lease dir (one `write` per coalesced batch, under the same shared store lock); release removes the file and the owner lock. `liveLeaseTargets` reads the lines. Same protocol (shared/exclusive `store.lock`, kernel-held owner lock), O(1) syscalls per batch instead of one symlink per entry and an `rm -r` of ~2,400.

### c. The staged scan resolves directories, not files
`scanStagedModules` realpaths each scanned root once and derives every file's real path from it (an artifact dir holds no links; a worker tree's children are each a root). Relative imports resolve against the set of scanned files first (exact: the importer's real dir + spec), and fall back to the disk only for a target outside it. Map URLs memoize their link dir's realpath. Same failures, same joins; tests in `staged-verify` cover worker-tree links.

### d. Docs: discovery from the view
`collectTestHelpers` asks the build's repo view whether a testing barrel exists (`has`) instead of 3 `existsSync` per plugin. The enriched tree's facet re-read is gone with (a).

### e. Browser-host coverage: shapes as file records
If (a)–(d) leave it the biggest: the coverage's per-file shape (`parseShape`: imports, re-exports, page-bound) becomes a `*.scan.ts` file scan, so an unchanged file is never re-masked.

### Not this step
* Rendering docs only for changed plugins: the render is 0.27 s on the loaded host and its inputs (the tree) are needed anyway; keying a per-plugin render on its facet slice and reverse index costs about what it saves. Recorded with the numbers.
* The overlay's `ls-files --ignored` (0.23 s, `--skip-checks` only) and `tsc:repo`'s module loads: build-and-push speed.
* A filesystem change signal (user decision).

## Verification
* Tests: `./equin test` on `packages/string-hash`, `plugin-meta/plugin-records`, `framework/tooling/web-artifacts`, `framework/tooling/codegen`.
* A build regenerates byte-identical generated files and docs; `./equin check` passes (incl. `plugins-doc-in-sync`, `plugins-registry-in-sync`, `browser-host:contributions-covered`).
* Host: W0 before/after with the same trace (graphs, `getMany` calls/keys) and CPU profile.
* Quiet VM, base and branch in two worktrees of one VM, alternating: W0 with and without checks, W1, W3; CC (cold codegen) and C1 must not regress.

## Critical files
* `plugins/packages/plugins/string-hash/core/internal/sha256.ts`
* `plugins/plugin-meta/plugins/plugin-records/cli/internal/sqlite-store.ts`, `core/internal/module-graph.ts`, `core/internal/file-scans.ts`
* `plugins/framework/plugins/tooling/plugins/codegen/core/{eager-tier-gen,plugin-registry-gen,test-helpers-doc}.ts`
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{lease,staged-verify}.ts`

## Outcome (2026-11-06)
Landed (a), (b), (c), (d). (e) not done: after (a)–(d), coverage is 0.70–0.74 s on the VM, mostly reading and masking scoped sources whose shape includes resolved targets; making it records means splitting the shape into raw per-file facts (a `*.scan.ts`) plus resolution. Next step.

### What changed
* `string-hash`: `sha256Hex` / `sha1Hex` take Bun's native `CryptoHasher` when the host has it, `@noble/hashes` otherwise; a test holds both paths equal (lone surrogate included).
* `plugin-records` `sqlite-store`: `getMany` keeps what it read per process and never asks SQLite for that key again.
* `plugin-records` `module-graph`: one growing graph per input (snapshot, store, `readOutside`, `written`; by identity), walking and keying only new modules (an earlier module is a leaf with its stored component key), a failed walk rolled back, growth serialized; each call gets a breadth-first view of its own closure. Callers pass the shared `NO_OUTSIDE_FILES`. Tests: keys equal to a single walk when grown leaf-first through a cycle, a view refuses what is outside it, a failed walk leaves the graph usable.
* Eager-tier and registry import scans: one `scanFiles` per generator (7,339 store reads → 2).
* `web-artifacts` lease: pins are whole files `pins.<n>` (one per coalesced batch); a prune still reads a lease of the symlink form.
* `web-artifacts` staged scan: real paths per directory (memoized), edges resolved in a second pass against the scanned set (disk only for a target outside it).
* `docgen`: test-helper barrels read once per plugin node.

### Measured
**Host (loaded), W0 `--skip-checks`, CPU profile of the build process:** record reads (`getMany`) 911 → 443 ms, module graphs 855 → 192 ms, `recordKey` 421 → 60 ms, `scanStagedModules` 592 → 424 ms (`realpath` 335 → 82), the lease's 0.6 s of `symlink` + `rm` gone, `pluginDocs` span 1,015 → 578 ms.

**Quiet VM (6 cores / 12 GB), base `d0b1738660` and the branch in two worktrees of ONE VM, alternating, 3 pairs each (s):**

| | Base | Branch |
| --- | --- | --- |
| W0 full build with checks | 6.90 / 6.97 / 6.99 | **6.16 / 6.17 / 6.18** |
| W0 `--skip-checks` | 7.30 / 7.31 / 7.34 | **6.23 / 6.25 / 6.30** |
| … codegen + migrations (`packageNames` → `formatSources`) | 3.62–3.72 | **2.98–3.04** |
| … `pluginDocs` | 0.91–0.95 | **0.60–0.63** |
| … `artifacts:compose` | 0.61–0.80 | **0.32–0.48** |
| … frontend (`viteBuild`) | 1.38–1.44 | **0.84–1.00** |
| … browser-host infer + coverage | 0.78–0.81 | 0.70–0.74 |
| … `tsc:repo` (`--skip-checks`) | 1.81–1.84 | 1.36–1.41 |
| W1 (web edit) whole | 9.11 / 9.14 / 9.30 | 8.56 / 8.80 / 9.32 (`tsc:repo` 3.3–3.9 is its critical path) |
| … codegen + migrations | 4.12–4.14 | **3.35–3.53** |
| W3 fresh worktree whole | 19.9 / 22.8 | 20.6 / 23.0 (`tsc:repo` 8–10 and the backend's first boot 5–6: other tracks) |
| … codegen + migrations | 4.45 / 4.57 | 3.79 / 4.40 |
| C1 cold hermetic build, 1 pair | 262.2 | 273.6 |
| … `tsc repo` / web artifacts / registry → checks | 248.0 / 47.6 / 12.6 | 260.9 / 48.4 / 11.2 |
| CC cold codegen (in-process, then pooled) | step 10: 11.7 / 9.8, 8.6 / 9.2 | 11.8 / 9.9, 9.2 / 9.3 |

C1's whole difference is the cold `tsc repo` pass (±5 s between runs in step 11, another track's); this change's parts are equal or faster cold.

### Left, measured
* What a no-change build still reads is each distinct record key once (~70k: per-file scans ~37k, facets ~18.7k, module facts ~11k, evaluations ~3k) — the floor of per-file / per-plugin records without a change signal. A per-plugin aggregate record over its files' blobs would cut the scans' lookups ~20×.
* `adoptDeploy` 0.73 s, browser-host coverage 0.7 s, the staged scan's read + lex of every staged module ~0.2 s (a per-store-entry surface record would make it O(new entries)), docs render ~0.3 s.
* Review (sonnet): no correctness finding; one low (a view's iteration order changed from breadth- to depth-first, which could change which unresolved module an error names) fixed: views are breadth-first.
