# Build pipeline step 4: plugin records — each plugin's facts read once, shared by every worktree

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`), redesign item 2 ("Plugin records") and the first half of item 3 ("Generators combine records"), in "Build pipeline: redesign" (`block-5979c8a6-…`). Prior step: `research/2026-11-03-global-build-pipeline-step3c-repo-snapshot.md`. Task: task-1793674540-792iob.

## Context
After 3c, a warm build with nothing changed (W0, quiet VM) spends ~16 s in codegen + migrations. Migrations are 5.25 s (item 5, not this step). Almost all of the other ~11 s re-derives per-plugin or per-file facts that did not change:

| W0 span (3c after, VM median) | s | What it really does |
| --- | --- | --- |
| `packageNames` | 1.97 | first faceted tree: 11 facets × 1,640 plugins, plus whole-tree `relate` |
| `slotDeclarations` | 2.20 | imports every main-bundle web barrel (~7.5k modules) to declare slots, then the orphan guard |
| `pluginDocs` | 2.16 | the enriched tree: imports every server/machine/central barrel (3.5k modules) and extracts all facets a second time |
| `browserHostInfer` + `Coverage` (lumen) | 1.97 | a whole-graph `Bun.build` to learn import edges, plus marker-call scans |
| `iconManifest`, `fieldsEager`, `eagerTier` ×2, `dataViews` | 1.47 | per-file source scans of every plugin |
| `pluginRegistry`, `compositionRegistry`, `formatSources`, `exemptRuleIds`, rest | ~1.1 | registries over the tree, formatter, check/lint fleet import |

None of it is kept between builds, so a fresh worktree (W3) pays it all again, and on the main thread most of the remaining `getdirentries`/`access` calls (FSU: 64k / 189k) are Bun resolving the barrel imports.

The fix is the redesign's: every fact is a pure function of a small, content-addressed input, so it is stored under that input's key in a store shared by all worktrees, and the generators become cheap combinations. A change then costs the records it touches (O(change)), never a global fingerprint.

## Design

### 0. Facts come in three granularities, keyed by what they really read
| Granularity | Examples | Key |
| --- | --- | --- |
| **File fact** | a module's import specifiers (resolved), marker calls (`defineDataView`, icon names, `preload:`, eager-tier markers), Tailwind/token candidates for cross-refs | `H(blob id, extractor identity)` |
| **Plugin fact** (facet extract) | the 11 facets' `extract` outputs | `H(plugin id, sorted (rel, blob) of the plugin's own files — sub-plugin dirs excluded, extractor identity)` |
| **Evaluated fact** | what only running a barrel tells: declared slots (key, kind, reorderable, companions), runtime contributions (slotId, kind, id, companion, componentName, doc), `register[]`, config descriptors (serialized, with the origin hash), token-group descriptors, theme / app payloads | `H(barrel's module Merkle key, evaluator identity)` |

* **Extractor identity is derived, never a hand-bumped version:** the Merkle key (below) of the extractor's own entry module. Editing one facet re-extracts that facet only; editing `parse-utils` re-extracts everything that uses it, which is a real input change.
* **Module Merkle key:** `H(blob, sorted keys of its resolved repo imports, lock hash for npm imports)`, strongly connected components collapsed to one key. Computed in memory from the file facts' import edges: O(modules + edges), milliseconds, no `Bun.build`. This is also what replaces the browser host's whole-graph `Bun.build` (its inference and coverage become graph walks over file facts).
* Generated files (`*.generated.ts`) are ordinary members: keyed by their blob. Evaluated facts are read only after the pre-barrel manifests are written (today's ordering rule), so the key sees the fresh manifest.

### 1. The store: one SQLite file under the data root
* `defineDataDir({ kind: "cache", name: "plugin-records", reclaim: { kind: "safe" } })`, one `records.sqlite` (`bun:sqlite`, WAL, busy timeout), table `facts(kind, key, value BLOB, used_at)`.
* Why SQLite, not one file per record: a W0 build does ~20k lookups (1,640 plugins × 11 facets + ~15k file facts + ~1,100 evaluated). One prepared `SELECT … WHERE key IN (…)` batch is tens of ms; 20k file opens are not. WAL gives concurrent readers and writers across worktrees without our own lock or publish protocol.
* Values are JSON (plain data only; asserted at write: a function or a `Map` in a fact throws, naming the facet).
* Prune: rows not used for 14 days, run by the build at most once a day (the same policy shape as `STORE_PRUNE_POLICY`). `used_at` is updated in one batched statement per build.
* New plugin `plugins/plugin-meta/plugins/plugin-records/` owning: the store, the three key functions, the module graph + Merkle keys, and `loadRecords(snapshot)`. It reads the build's `RepoSnapshot` (`blobOf`), so the build must hand codegen S0 as a **snapshot** (today `app-artifacts.ts:403` takes `loadRepoFiles`; it becomes `loadRepoSnapshot`, +~0.1 s, and S1 can then reuse S0's blob ids for unchanged files).

### 2. One plugin tree, built from records
* `buildPluginTree(…, { facets: true })` looks up each (plugin, facet) record; only misses run `facet.extract`, and misses run in parallel on `packages/thread-pool` when there are more than a threshold (cold or a facet edit), in-process otherwise.
* **Facets must be pure functions of their key** to be cached; the exploration found three that are not:
  * `db-schema` mutates a module-global `allRefNames` in `extract`: the ref names move into its extract output, `relate` builds the map.
  * `exemptions` `require`s `exempt/index.ts`: its key includes that module's Merkle key (it is code), via the facet declaring "also keyed by these modules' Merkle keys".
  * `structure` reads the sub-plugin dir set: the plugin's key includes its child dir names.
  * A loud guard keeps it so: in the build's first-miss path, an extract that reads a file outside its key (the ambient `FsSnapshot` already brokers every read) throws, naming the facet and the path.
* `relate` / `prepareRelate` stay whole-tree, in memory over the records. `cross-refs.prepareRelate`'s repo-wide token scan reads per-file candidate facts instead of re-scanning sources. (Step 1 measures what `relate` costs; if it is more than ~100 ms it gets its own record-diff design, not in this step.)
* **The barrel-free / enriched split goes away.** There is one tree: facet records + evaluated records (§3) merged into the same node facets (`slots`, `contributions.runtime`, `registrations` read the evaluated record instead of `ctx.imported`). `buildBarrelFreeTree` / `buildEnrichedTree` become one memoized `buildRecordTree(snapshot)`; the second extraction inside docs disappears.

### 3. Evaluated records: barrels imported only on a miss
* **Evaluator:** for the missed barrels, `registerBarrelStubs`, import them (one process, ESM cache shared, as today) and serialize each barrel's facts. Runs in-process for few misses, on the thread pool for many (cold).
* **Order rule kept:** the evaluator runs after the pre-barrel manifests are written, and `setPreBarrelImportGuard` still arms around it; but on W0 / W3 it imports nothing.
* **Slots get a stable identity that needs no declaration pass: `(creating module, ordinal)`.** This is the piece that makes a record a function of its own closure.
  * A contribution's slot is often declared by a plugin outside the contributor's closure (`slots: { ...S }` re-declares a group defined in a leaf module, e.g. `theme-customizer/web/index.ts:26`, `network/live/web/index.ts:75`). Resolving `slotId` inside the evaluator would therefore depend on barrels the key does not cover.
  * In evaluator mode only, `defineSlot` stamps each slot with the module whose top-level evaluation created it (the innermost module-code frame, `Error.stackTraceLimit = Infinity`) and its ordinal within that module. Factories (`Pane.define` → `definePaneHeaderSlot`) are attributed to the module that called them at top level, not to the factory's file, so they do not collapse onto one site.
  * Records store slot identities, never resolved ids: a barrel's `slots` record → `{ key path, identity, kind, reorderable, companions }`; a contribution → `{ slot identity, kind, id, companion, componentName, doc }`.
  * **The combine resolves** identity → owner plugin + `slotId` from all declared records (throwing on a slot two plugins claim, as `declarePluginSlots` does), and produces the same `SlotNaming` answers the generators use today.
* **The slot orphan guard becomes the same combine:** created identities (each module's record lists what it created) minus declared identities, over the main bundle's plugins only (registry scope, as today). Identities are unique, so a factory used by ten panes cannot hide nine missing declarations. It still runs before config origins are generated.
* **Facts filled from the whole declared set** (`subscribeSlotsDeclared`: reorder's ~240 config registrations, pane's header slots): only the **subscriber's own** barrel facts depend on it, not its importers'. A barrel whose own plugin calls `subscribeSlotsDeclared` (found statically from the file facts) is keyed also by the hash of the combined declared-slot facts, and its miss runs a full declaration pass first (today's 2 s, only when a slot is added, removed or re-flagged). Loud guard: the evaluator re-reads every barrel's contributions after a declaration pass; a barrel whose facts changed but is not keyed this way throws, naming it.
* **Evaluator identity** includes the barrel stubs (`barrel-import/core/internal/stubs.ts`, `auto-stub*`: they patch `globalThis` and install a `Bun.plugin`), the Bun version and the platform.
* **Live code is not a fact.** Two consumers need a live object, and both keep importing, on demand only:
  * `config-origins-in-sync`'s `descriptor.schema.safeParse` and `config-stable-list-ids`: checks, run in the check process, unchanged.
  * `seedAuthoredOverrides`' `seedWhen` (only reorder's directive has one): asked only on the path that would create a file, so that path imports the one barrel. Rare, and loud.
  * Every other descriptor read (`fields`, `defaults`, the origin hash, `overrideLegend`, `requiresAuthoredOverride.guidance`) is plain data. Theme and app payloads are already rendered "as data" into their manifests.
* Generators read evaluated facts instead of importing: `config-origin-gen` / `override-legend-stamp` (descriptors), `token-group-vars-gen` / `color-token-ref-gen`, `reorderable-slots-gen`, `web-slot-contributions` (theme / app payloads), docgen's runtime halves. The origin providers (`OriginAnnotationsPreparer`, reorder's catalog) consume the combined records. Each fact kind has one zod schema, parsed on read, so a stale-shaped row fails loudly instead of being half-read.
* **Soundness net: `--verify-records`.** A mode of the build (and of `measure-build-steps.ts`) that evaluates everything fresh and diffs it against the store, naming any record whose key missed an input. Run in this step's gates, on the VM; candidate for a daily main-only job afterwards.

### 4. Generators and docs on records
* `iconManifest`, `fieldsEager`, `eagerTier`, `dataViews`, browser-host inference / coverage, the registries: read file / plugin facts. Generated files are still written only when their bytes change.
* Docs keep rendering everything (0.13 s); the gain is that nothing is extracted to render. Per-plugin re-rendering is redesign item 4 ("Docs"), a later step.
* The `*-in-sync` checks and the page / ids / active-data checks that call `buildEnrichedTree` read the same record tree, so a check process pays lookups, not imports.

### Rejected: one digest of the whole tree
A memo keyed by every `plugins/**` blob would make W0 and W3 free with no new machinery, but any edit invalidates all of it, so W1 still imports 11k modules. That is the global fingerprint the track rules out (and the push-lock work already rejected).

### Not in this step
* Migrations skip (item 5, 5.25 s of W0 — the single biggest remaining span; next step).
* `exemptRuleIds`' check/lint fleet import (0.14 s), `formatSources`, the `tsc repo` pass (build-speed track).
* Per-plugin docs re-render (item "Docs").

## Expected (quiet VM, to be measured)
| | W0 | W1 (one web edit) | W3 (fresh worktree) | Cold codegen |
| --- | --- | --- | --- | --- |
| Codegen without migrations, today | ~11 s | ~10 s | ~12 s | ~14 s |
| After | ~1.5 s (snapshot, ~20k lookups, relate, combines, format) | ~2–3 s (+ 1–3 file/plugin facts, 1 evaluated barrel and the barrels that import it) | ~1.5 s | ~5 s (parallel extraction + parallel evaluation) |

An edit to a widely imported primitive (ui-kit, web-sdk) re-evaluates every barrel whose closure holds it: bounded by today's cost, and proportional to what the edit can change.

## Implementation order (each with tests; one session)
1. **Measure the leftovers first** with `measure-build-steps.ts`: `relate` per facet, `prepareRelate`'s token scan, the guard's import vs check split. Decide the threshold for the thread pool.
2. `plugin-records` plugin: SQLite store, file facts (imports resolved through the same resolver `importClosure` uses), module graph + Merkle keys (tests: SCCs, npm, a generated file, a changed blob moving exactly its dependents' keys). The browser host's inference and coverage move onto it — equivalence test against today's `Bun.build` closure for lumen.
3. Facet records: the three purity fixes, the read-outside-key guard, `buildRecordTree`, parallel misses. Gate: every node's facets deep-equal today's barrel-free tree's on the repo.
4. Evaluated records: slot identities, the combine (naming + orphan guard), the declared-set-keyed subscribers, generators on records, one tree. Gates: generated files and all docs byte-identical after a build (`git status` clean); the combine's `SlotNaming` equals today's declaration pass for every slot; the guard still fails on a seeded orphan, including one minted by a pane factory; reorder's ~240 contributions present; `--verify-records` clean.
5. Build wiring: S0 as a snapshot, codegen threads it; delete `barrel-free-tree.ts` / `enriched-tree.ts`; update the `no-uncached-tree-in-checks` lint to the new entry.
6. VM before / after (`steps-build-pipeline.sh`, `BUILD_PIPELINE_STEPS="baseline install lib w0 w1 w3 fsu cf"`; before = main at the base, after = this branch), then the measurements page, the track page's benchmark and status, and the next main task (migrations skip) filed with the page id.

## Gates
* Correctness: byte-identical generated files and docs; facet deep-equality; seeded orphan / seeded config descriptor change / seeded token group change each change exactly their outputs.
* W0 and W3 import **zero** plugin barrels (asserted in the build: the evaluator reports how many it imported; logged, and a test asserts 0 on a second identical pass).
* FSU: `getdirentries` and `access` on the build's main thread drop by the barrel-import share (target: 64k → under 20k).
* No cold regression (C0 / CF).

## Critical files
* New: `plugins/plugin-meta/plugins/plugin-records/` (`core/`, `data-dirs/`).
* `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`, `fs-snapshot.ts`.
* `plugins/plugin-meta/plugins/facets/core/{facets,load-facets}.ts`, `facets/plugins/{db-schema,exemptions,structure,slots,contributions,registrations,cross-refs}/facet/index.ts`.
* `plugins/framework/plugins/tooling/plugins/codegen/core/`: `regen-pipeline.ts`, `barrel-free-tree.ts`, `enriched-tree.ts`, `slot-declaration-guard.ts`, `config-origin-gen.ts`, `token-group-vars-gen.ts`, `reorderable-slots-gen.ts`, `web-slot-contributions.ts`, `browser-host-gen.ts`, `browser-host-coverage.ts`, `docgen.ts`, `icon-manifest-gen.ts`, `fields-eager-gen.ts`, `eager-tier-gen.ts`, `data-views-gen.ts`.
* `plugins/framework/plugins/web-sdk/core/slots.ts` (evaluator-mode creation site).
* `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` (S0 as a snapshot).
* Reuse: `loadRepoSnapshot` (`tooling/core/repo-files.ts`), `computeBlobListHash` (`web-artifacts/core/hash`), `createThreadPool` (`packages/thread-pool`), `registerBarrelStubs` / `importBarrel` (`plugin-meta/barrel-import`), `defineDataDir` (`infra/paths`).

## Outcome (2026-11-04)

What was built, and where it differs from the plan above:

* **`plugin-meta/plugin-records`**: one SQLite store (`cli/`'s `openRecordStore`, WAL, rows unread for 14 days reclaimed daily) behind a synchronous batched `RecordStore` interface (`core/`, with a per-process memory store for every process the build does not install the shared one in). Keys are `recordKey(...)` over content identities only.
  * **Module graph**: file facts are each module's imports through Bun's own transpiler (`scanImports`, with and without `trimUnusedImports`), so the graph carries both the runtime's edges (what a barrel import evaluates; the Merkle keys) and a bundler's (unused TypeScript imports dropped). Merkle keys over SCCs.
  * **Evaluated records**: a barrel is imported only on a miss; its default export and slot-bearing exports are serialized (`serialize.ts`: functions as named stand-ins, symbols, Maps, class instances as plain fields; zod schemas, React elements, cycles as values that throw when read).
  * **Slot identity**: `slot-declaration` tracks each slot's creating module (the stack's bottom frame — the module whose top-level evaluation runs) and ordinal from the first `importBarrel`. Records name slots by it; the naming and the orphan guard are settled over records (`settleSlotNaming`, the pure half of `declarePluginSlots`).
  * **Declaration-dependent barrels** (reorder, pane): detected from module facts (their own modules subscribe), keyed also by a hash of every declaration; a miss re-runs the live source-scope pass over every barrel and throws if any other barrel changed across it.
  * **Cached per-file scans** (`scanFilesCached`): icon names, data views, eager-tier inputs, registry default exports and import specifiers, and server portability's per-module facts.
* **Facets**: `extract` is static only and cached per (plugin, facet) under the plugin's own files (`pluginFilesManifest`, exactly what its snapshot exposes), the facet's module Merkle key, the harness and the lockfile, under a strict snapshot (a read outside throws). `enrich` adds the evaluated half (slots, contributions' runtime half, registrations); `prepareRelate` became `extractBatch` (cross-refs' token scan, keyed also by `app.css`). Purity fixes: db-schema (module-global refs moved into the record; repo-relative paths), structure (dir names in the key).
* **Codegen**: `evaluated-barrels.ts` (web evaluation after the pre-barrel manifests, every barrel after the post-web ones, each with its own snapshot); the guard, token groups, theme/app declarations, reorderable slots, config origins and the enriched tree read records. `declareSlotsFromBarrels` stays the LIVE pass for the checks that hold live slots. Config origins read descriptor data from records; `config-origins-in-sync` / `config-stable-list-ids` ask for live descriptors (`live: true`), and the seeder imports live only to ask a `seedWhen`.
* **Browser host and portability on the graph**: `serverPortabilityOf` and the browser host's closures read the module graph's bundler view instead of `Bun.build`. `plugin-records/scripts/closure-equivalence.ts`: over all server barrels, 4,666 modules each way, 0 out-edge differences, 0 unresolved imports.
* **Not done**: parallel extraction / evaluation of misses (the cold path is still serial — see below); `--verify-records` as a build mode (verification is the in-sync checks, which evaluate fresh in their own process, plus `measure-build-steps.ts --dump`).

**Correctness**
* All `*-in-sync` checks, `plugins-doc-in-sync`, `browser-host:contributions-covered` and `config-v2:registrations-paired` pass on a build that read every record from the store: the records reproduce what live barrel imports produced.
* A records pipeline run, then a second one, wrote nothing; the docs diff after the change holds only the new plugin's own lines.
* Locally, a second identical pipeline imports 0 barrels (`webImported: 0`, `allImported: 0`) and loads 2,553 modules instead of 13,485.

**VM, quiet 6-core** (`steps-build-pipeline.sh`; before = `7da70977e0`, after = it + this change; W0 ×3, W1 ×3, W3 ×2, median), seconds:

| Step | W0 before → after | W1 | W3 |
| --- | --- | --- | --- |
| Codegen + migrations | 15.63 → 10.37 | 17.53 → 10.71 | 19.93 → 13.93 |
| … generate migrations (unchanged) | 4.86 → 5.00 | 5.47 → 4.81 | 5.02 → 5.93 |
| … codegen without migrations | 10.77 → 5.37 | 12.06 → 5.90 | 14.91 → 8.00 |
| … packageNames (first faceted tree) | 2.00 → 0.36 | 2.42 → 0.39 | 2.63 → 1.00 |
| … slotDeclarations | 1.91 → 0.45 | 2.35 → 0.91 | 2.46 → 0.53 |
| … pluginDocs | 2.16 → 1.19 | 2.44 → 1.16 | 4.03 → 1.40 |
| … browserHostInfer | 1.62 → 0.31 | 1.85 → 0.30 | 1.69 → 0.36 |
| … iconManifest / dataViews | 0.55 / 0.19 → 0.07 / 0.04 | 0.60 / 0.21 → 0.07 / 0.04 | 0.54 / 0.20 → 0.09 / 0.06 |
| Whole build `--skip-checks` | 20.15 → 14.94 | 27.20 → 17.10 | 40.44 → 29.96 |

* **Cold codegen regressed**: C0 (empty data root), from "Generating plugin registry" to "Running checks": 18.4 → 21.8 s. Not yet attributed; likely the cost of making every record cold (JSON + SQLite inserts, ~17 MB of serialized barrels, two transpiler scans per module) on top of the still-serial extraction. The whole C0 build (dominated by a cold `tsc repo`, 244 vs 272 s) is 264 → 296 s with the same user CPU (343 vs 342 s).
* **FSU**: `getdirentries` in the build process 140k → 133k. The barrel-import threads are gone, but most of what remains is not a barrel walk: the `tsc repo` thread (76k), the main thread's ~12k reads of every plugin's folders (`exempt/`, `lint/`, `check/`, `e2e/` included — the bootstrap ensureDeps walk 3c kept), and four ~8k threads present before too. The target (under 20k) was not met.
* What W0 codegen still spends: migrations 5.0 s (the next step), the enriched tree + docs 1.2 s, the slot guard 0.45 s, browser-host coverage 0.41 s (its scans still read), the barrel-free tree 0.36 s, format 0.27 s, fieldsEager 0.25 s, compositionRegistry 0.24 s.
