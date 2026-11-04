# Build pipeline step 5: drizzle-kit only when a schema input changed, and step 4's cold regression

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`), redesign item 5 ("Migrations") and the open half of item 2 ("cold extraction in parallel"), in "Build pipeline: redesign" (`block-5979c8a6-…`). Prior step: `research/2026-11-03-global-build-pipeline-step4-plugin-records.md`. Task: task-1793760999-vfnw9g.

## Context
After step 4 (quiet 6-core VM), W0 codegen + migrations is 10.4 s, and two costs are left, in this order:

1. **`generateMigration` is 5.0 s of W0's 10.4 s**, on every build that changed no schema (~95 % of builds). It runs, unconditionally:
   * the bookkeeping: published origins from git, snapshot bodies, tip join, `settleSnapshotFiles`, journal regen (cheap, not yet measured on its own);
   * the schema load probe: one child that `require()`s all 127 schema-glob files (0.6 s);
   * drizzle-kit in a staged out-dir: a child that loads the same 127 files again and diffs them against the tip (3.7 s), answering "No schema changes".
2. **Cold codegen regressed 18.4 → 21.8 s** with step 4 (C0, empty data root, "Generating plugin registry" → "Running checks"), not attributed. Step 4 extracts and evaluates every missing record serially, and also pays for making every record: two transpiler scans per module, ~17 MB of serialized barrels, JSON + SQLite writes.

## Design

### 1. A drizzle-kit verdict keyed by exactly what drizzle-kit reads
drizzle-kit `generate` is a pure function of:
* the code it loads: every schema-glob file **and its import closure** (their Merkle keys, from the plugin-records module graph), `drizzle.config.ts` (its Merkle key covers `schema-glob-patterns.ts`);
* the schema-glob **file set** (a new `tables.ts` changes the answer with no other edit);
* the staged out-dir: the tip `meta/schema.snapshot.json` and `meta/_journal.json`, as their blob ids, read **after** the reset / join / settle / journal steps that may rewrite them;
* drizzle-kit, drizzle-orm and the other npm code it loads: `bun.lock`'s blob, plus the Bun version and platform.

The key is `recordKey("drizzle-verdict-1", sorted (path, merkleKey) of the schema files, configKey, tipBlob, journalBlob, lockBlob, bunVersion)`, stored in the shared plugin-records store under a new `verdict` table. This is a key over the schema closure only, not the repo: the redesign's "schema key over the schema files only". An edit outside every schema file's closure (the common case) hits.

**What a hit stands for: "the probe found no load failure, and drizzle-kit emitted nothing, no prompt, no diagnostic".** Only that outcome is stored, written at the one place `generateMigration` reaches `added.length === 0` with a clean run. Every other outcome (a migration, prompts, an error) is never cached, so a hit can only skip work whose answer was "nothing to do".

On a hit, `generateMigration` skips the probe, the stage and the child, and continues on the existing `added.length === 0` path, unchanged (the `--migration-name` warning, a reset's adoption file). The bookkeeping before it still runs (it repairs the tree, and the key reads its result). Not used when `--custom` or `--migration-answers` is given (those runs exist to make drizzle-kit emit something).

**Plumbing:**
* `generateMigration` gets the verdict from a small function in `database/migrations` core (`drizzleVerdictKey(input)`, pure, plus the table name), so the key's definition lives beside the drizzle config it describes. The CLI half (`cli/migrations/migrations.ts`) reads and writes it through `currentRecordStore()`.
* Its graph input: the build hands stage 2 the stage-1 `RepoSnapshot` (`app-artifacts.ts:412`) — `generateAppSources` takes it, and `buildModuleGraph(input, schemaFiles + config)` gives the keys, reading no source on a warm store. Callers without a snapshot (`regen-migrations`, `build --hermetic` if it does not have one) load one with `loadRepoSnapshot`; no caller gets a "no cache" path (one code path, measured).
* The schema file set comes from the snapshot filtered by `SCHEMA_GLOBS` (a `Bun.Glob` match over the snapshot's paths), not from a disk glob; asserted equal to `schemaGlobFiles` in a test.

**What escapes the key** (same rule as every record, caught not prevented): a schema module that reads a file or the environment at load. None does today (the config's own comment: no schema-glob file resolves anything at module eval). The `migrations-in-sync` check runs drizzle-kit fresh in its own process on every push, so a stale verdict cannot land.

**Rejected:** comparing a drizzle JSON of the schema in-process (still loads all 127 files: O(schema) on every build); a hash of every `server/**` file (a global fingerprint by another name).

### 2. Cold codegen: attribute, then fix the largest part
Measure first, then fix the biggest attributed cost. Expected candidates, in the order the step 4 outcome suggests:
* **Parallel misses** (planned in step 4, not done): facet extraction misses on `packages/thread-pool` when above a threshold; then barrel evaluation misses, partitioned across workers (each worker pays its own ESM loads of shared modules, so the split must be measured: one worker per partition of the main bundle vs per runtime).
* **One transpiler scan per module instead of two** (`scan-imports.ts` runs `scanImports` with and without `trimUnusedImports`): find whether one pass can yield both (e.g. `Bun.Transpiler.scan`'s export/import info, or computing "unused" from the trimmed scan only for TypeScript files that have type-only candidates).
* **Writes**: one transaction per batch, values written once (no JSON re-stringify of already-serialized values), the 17 MB of serialized barrels reduced where a field is never read back.

Gate: C0 codegen back at or under 18.4 s, and toward the redesign's ~8 s cold target. Nothing is fixed before its share is measured.

## Implementation order (one session)
1. **Measure (local, then VM).**
   * Sub-spans inside `generateMigration` (bookkeeping, probe, stage, child), so the 5.0 s is split before anything is skipped.
   * Size of the schema files' closure (modules, plugins): how often a typical edit will miss the verdict.
   * Cold codegen per step: `measure-build-steps.ts --order pipeline` with an empty data root, `--records` on this branch vs without at the step 4 base (`7da70977e0`), under `--cpu-prof-md`, plus counters (records written, bytes, time in `putMany`, in `scanModuleImports`, in `serializeValue`, extraction vs evaluation). Added as a `RUN` step of the VM harness.
2. **Verdict** (§1): the key function + test (every input moves it; an unrelated file does not), the `verdict` table, `generateMigration` reading / writing it, snapshot threading from stage 1, the schema-file-set equivalence test. Tests in `migrations.test.ts`: a hit skips the child (counted), a schema edit misses and generates, a prompt / error result is never stored, `--custom` ignores it.
3. **Cold fixes** (§2), largest attributed first, each re-measured.
4. **VM before / after**: `steps-build-pipeline.sh` with C0, W0, W1, W2, W3 (+ the cold-codegen RUN step); before = main at the base, after = this branch. W2 must show the verdict missing and drizzle-kit generating; W0 / W1 / W3 must show it hitting.
5. Wiki: the measurements page's step 5 section, the track page's benchmark row and status, the overview checkboxes; then file the next main task with the page id.

## Expected (quiet VM)
| | W0 | W1 | W2 (schema edit) | W3 | C0 codegen |
| --- | --- | --- | --- | --- | --- |
| generate migrations, after 4 | 5.0 s | 4.8 s | ~4.5 s + the new migration | 5.9 s | ~5 s |
| After | bookkeeping only (~0.3–0.7 s, to measure) | same | unchanged (miss) | same as W0 (verdict shared from main's build) | unchanged (miss) |
| Codegen + migrations | 10.4 → ~5.5 s | 10.7 → ~6 s | unchanged | 13.9 → ~9 s | 21.8 → ≤ 18.4 s |

## Gates
* Correctness: W2 generates the same migration as without the verdict; a seeded new schema file (no other change) misses; `migrations-in-sync` and `schema-files-loadable` pass after every scenario.
* W0 / W3 spawn no drizzle-kit child and no probe (asserted by the span, logged).
* No cold regression against 18.4 s.

## Critical files
* `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts` (`generateMigration`).
* `plugins/database/plugins/migrations/core/` (`index.ts`, new `internal/drizzle-verdict.ts`, `schema-glob-patterns.ts`, `schema-load-probe.ts`).
* `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` (stage 2 takes the snapshot).
* `plugins/plugin-meta/plugins/plugin-records/core/internal/{store,module-graph,scan-imports,evaluate,serialize}.ts`, `cli/internal/sqlite-store.ts`.
* `plugins/plugin-meta/plugins/plugin-tree/core/internal/facet-records.ts` (parallel misses).
* `plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts`, `sidequests/clean-install/steps-build-pipeline.sh`.
* Reuse: `buildModuleGraph` / `recordKey` / `currentRecordStore` (plugin-records), `loadRepoSnapshot` (`tooling/core`), `createThreadPool` (`packages/thread-pool`), `SCHEMA_GLOBS`.

## Outcome (2026-11-04)

### What was built, and where it differs from the plan
* **The verdict** (§1) as planned: `framework/cli/plugins/migrations/cli/drizzle-verdict.ts`, a `verdict` table in the plugin-record store, keyed by the Merkle keys of the 127 schema files' closure + the config, probe and `migrations.ts` code, the tip, the journal, `bun.lock` and the runtime. It takes its own fresh snapshot (`loadRepoSnapshot`, ~0.2 s) after the bookkeeping instead of threading stage 1's, because codegen writes files in between (no stale blob can enter the key).
* **Found while measuring: the schema closure is large.** 1,699 modules over ~400 plugins; 185 of main's last 400 commits touch it (or the lockfile / `data/`), only 29 touch a schema file. A verdict alone would still run drizzle-kit after ~46 % of commits.
* **Added: the exact tip comparison** (not in the plan). drizzle-kit's own `generateDrizzleJson` over the loaded schema exports equals `schema.snapshot.json` exactly (canonical key order, `id` / `prevId` aside) — verified on the whole repo. The load probe, which already loads all 127 files, now also answers `matchesTip` (`probeSchema(root, { tip })`, `scripts/require-probe.ts`). Equal ⇒ a `generate` has nothing to diff, so drizzle-kit does not run. It is exact (not a cache), so it also covers cold builds and edits inside the closure. The probe refuses a `drizzle.config.ts` key it does not pass on (casing, filters).
* So drizzle-kit runs only when the schema really differs from the tip (or for `--custom` / `--migration-answers`). Order: bookkeeping → verdict (hit: done) → probe + comparison (equal: record the verdict, done) → drizzle-kit.
* Sub-spans of `generateMigration` in the build profile: `migrationBookkeeping`, `migrationVerdict`, `schemaLoadProbe`, `drizzleKit`; the build logs `drizzle-kit verdict hit | schema-equal | miss | bypassed`.
* **Cold (§2): attributed, no fix needed for the gate.** The step 4 "regression" was two single C0 samples: in isolation (measure-build-steps `--order pipeline`, empty data root and transpiler cache, VM) cold codegen is 12.7–18.0 s before step 4 and 11.5–13.0 s after (SQLite or in-memory store alike). Step 4 moved ~1 s of import scanning into `pluginRegistry` / `eagerTier` and saved about as much in `browserHostInfer`. Parallel extraction / evaluation is left to the next step (the cold gate is met).

### VM, quiet 6-core (`steps-build-pipeline.sh`; before = main `5380ed9f49`, after = it + this change)
Codegen + migrations = the build profile's window from `packageNames` start to `formatSources` end; median, seconds.

| Scenario | Codegen + migrations | `generateMigration` | Whole build `--skip-checks` |
| --- | --- | --- | --- |
| W0 warm, no change (×3) | 10.19 → 5.44 | 4.94 → 0.33 (hit) | 15.8 → 10.7 |
| W1 web edit (×3) | 11.56 → 5.82 | 5.11 → 0.30 (hit) | 20.4 → 13.3 |
| W4 server edit, outside the schema closure (×3) | 11.81 → 6.66 | 5.24 → 0.36 (hit; the first after W2: schema-equal 1.62) | 20.5 → 16.3 |
| W5 edit inside the schema closure, no schema file (new, ×3) | 15.72 → 12.88 | 5.06 → 1.24 (schema-equal: probe 0.9) | 23.5 → 21.0 |
| W2 schema edit (×3) | 10.30 → 11.27 | 4.77 → 5.44 (miss: probe 0.9 + drizzle-kit 4.1) | 19.9 → 20.1 |
| W3 fresh worktree (×2) | 13.70 → 7.77 | 5.52 → 0.38 (hit) | 33.7 → 26.1 |
| C0 cold, "Generating plugin registry" → "Running checks" (×1) | 17.9 → 15.7 | (schema-equal: 1.6) | 227.5 → 260.4 (cold `tsc repo` 208 → 243, single samples) |

* W2 pays ~0.7 s more than before: the verdict key (0.27 s) and the probe loading drizzle-kit's API. Accepted: a real schema change is ~7 % of commits.
* W5's codegen stays high because a `fields/text` edit legitimately re-evaluates every barrel importing it (step 4's records).

**Cold codegen alone (CC, measure-build-steps, wall / CPU s)**

| Step | Before step 4 | After (SQLite store) |
| --- | --- | --- |
| packageNames (cold facet extraction, serial) | 2.74 / 4.5 | 2.53 / 4.5 |
| pluginRegistry + eagerTier | 0.37 / 1.3 | 1.38 / 1.9 |
| browserHostInfer + coverage | 2.17 / 7.3 | 1.49 / 2.9 |
| slotDeclarations (web barrels imported) | 2.58 / 3.4 | 2.64 / 2.8 |
| pluginDocs (server / machine / central barrels) | 2.94 / 4.7 | 2.29 / 2.8 |
| Total (registry + manifest) | 12.75 (run 1: 18.0) | 11.55 (run 1: 13.0) |

What remains cold: barrel evaluation (~5 s, one thread loading ~11k modules) and serial facet extraction (~2.5 s).
