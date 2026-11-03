# Build pipeline step 3c: one repo snapshot per build, read by every step

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`), redesign item 3 ("Build pipeline: redesign", `block-5979c8a6-…`). Prior design: `research/2026-10-30-global-build-pipeline-step3b-batched-artifacts-and-repo-snapshot.md`, Part B (unchanged in v2). Task: task-1793637324-bhzbog.

## Context
A warm build with nothing changed still walks `plugins/` about 10 times: 157k `getdirentries` and 265k `access` calls on the quiet VM, about 4.5 s of sync `readdir` on the main thread. Each step decides on its own which files exist, mostly by walking the disk, and web-artifacts keeps a per-worktree mtime fingerprint file to avoid re-hashing what it walked. That cost is the same in every scenario (W0, W1, W3), and a fresh worktree starts with an empty fingerprint file.

This step adds one git-derived snapshot per build: the file list plus each file's blob id. Every step reads it, and the walks go away. It is also the prerequisite of the plugin records (item 4), which are keyed by the plugin's own blob ids.

## Walkers found (exploration, 2026-11-03)
| Walker | Where | Per build |
| --- | --- | --- |
| `findAllPluginDirs` + `hasPluginContent` (recursive `readdir`, about 2× the dir count) | `plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:130-196` | once per tree build: barrel-free, enriched, plus a 3rd direct `buildPluginTree` at `build/cli/internal/app-artifacts.ts:496` |
| `buildFsSnapshot` (its own `loadRepoFiles` and a `readdir` walk of every plugin dir) | `plugin-tree/core/internal/fs-snapshot.ts:72-96` | once per faceted tree |
| Per-node barrel `existsSync` probes | `plugin-tree.ts:389,400`; codegen `config-origin-gen.ts:99`, `slot-declaration-guard.ts:125`, `web-slot-contributions.ts:49`, `token-group-vars-gen.ts:135`, `fields-eager-gen.ts:85` | 4× plugins per pass |
| `walkFilesAsync` (always disk) | `parse-utils/core/helpers.ts:687`, used by `data-views-gen.ts:136`, `icon-manifest-gen.ts:130` | per plugin |
| `walkFiles`'s disk fallback | `parse-utils/core/helpers.ts:631` | when no ambient snapshot |
| `ensureDeps` `package.json` + `provision/index.ts` walk | `cli/plugins/bootstrap/cli/ensure-deps.ts:~250` | **3×** (bootstrap `cli/bin/index.ts:115`, then `app-artifacts.ts:399` and `:438`), not 2× |
| `listOwnFiles` / `ownHashFor` + glob-root walks + `FingerprintCache` | `web-artifacts/core/internal/own-files.ts`, `store.ts:355-405` | every web target, entry, browser-host member |
| Builder identity: `builderSource` (full read of web-artifacts `core/`), `findViteContributions` (depth-12 walk of `plugins/`) | `web-artifacts/core/internal/identity.ts:84-123`, `web-core/core/vite-contributions.ts:71` | once |
| Browser-host input hasher (sha256 of whole files, `readdirSync` per dir and per glob root) | `web-artifacts/core/internal/browser-hosts.ts:140-210` | once per host |
| `lsFilesSync` (a sync duplicate of `loadRepoFiles`) | `codegen/core/plugin-registry-gen.ts:214` | per registry pass |

These stay as they are, because they are not source walks: compose / staged-verify (the dist), the store and lease dirs, the Tailwind oxide scan (it reads the bytes of a stale artifact's own files, which is O(stale)), the checks' tree hash (see Scope).

## Design
### 1. `RepoSnapshot`: `RepoFiles` plus blob ids
In `plugins/framework/plugins/tooling/core/repo-files.ts`, next to `loadRepoFiles` and reusing `repoFilesOver`, `assertRepoPath` and `pathspec`:

```ts
interface RepoSnapshot extends RepoFiles {
  blobOf(path): string;             // throws for a non-member: never "" or null
  isSymlink(path): boolean;         // mode 120000
  hasDir(dir): boolean;             // derived from the path list
  childrenOf(dir): readonly { name: string; kind: "file" | "dir" }[];
}
loadRepoSnapshot(root, opts?: { extra?: readonly string[] }): Promise<RepoSnapshot>
```

* **Membership** is unchanged from `loadRepoFiles`: tracked plus untracked-not-ignored, minus deleted. Every checks-side rule about it holds, and `loadRepoFiles` becomes `loadRepoSnapshot` without the blobs, so there is one implementation.
* **Git calls (run in parallel):**
  * `git ls-files -s -z`: mode, blob and stage for every index entry. It does no stat.
  * `git ls-files -z --others --exclude-standard`: the untracked files.
  * `git diff-files -z --name-only --no-optional-locks`: tracked files that differ from the index. It uses lstat against git's stat cache, takes no `index.lock` and does no untracked walk.
  * Then one `git hash-object --stdin-paths` over the dirty, untracked and `extra` files only. That is O(changes).
* **A stat-dirty file whose content is unchanged** is simply re-hashed. Its id is still correct, and the cost is O(stat-dirty).
* **`extra`: the gitignored files a step really reads.** These are paths a writer reports, such as the per-composition registries `web-sdk/core/*.composition.<name>.generated.ts`. They are hashed and added to the set explicitly. The snapshot never silently drops a file that a hash used to cover.
* **Lifetime:** taken once per pass and handed around, never memoized in a module. This is `repo-files.ts`'s existing rule.
* **Failure:** any git failure throws, and so does a blob lookup on a non-member.
* **Pre-install safety:** `ensure-deps.ts` may not import this module. It receives plain data instead (§3).

### 2. Taken twice per build, in `run.ts`, and passed through `ArtifactHooks`'s options
* **S0, before stage 1** (next to `mainTreeBefore`, `run.ts:~1169`). It is read by:
  * `ensureDeps`;
  * the registry codegen;
  * `generateCompositionRegistry`;
  * stage 2's manifests and docs.

  These steps need membership. They read contents from disk as they do today, and no step adds a plugin mid-build, so S0 is valid for all of them.
* **S1, at the start of stage 3, after codegen and format have written**, with `extra` set to the composition registries stage 1 wrote. `generateCompositionRegistry` returns its path.
  * The frontend reads blob ids from S1, so a committed generated file that codegen rewrote is hashed by its new content.
  * Cost: one more git listing, about 0.2–0.5 s of git CPU (its untracked enumeration is itself a C walk). The alternative, amending S0 from the writers' own reports, would save that, but it trusts every writer (drizzle-kit, the authored-override seed) to report what it wrote. I chose correctness here. Revisit only if the measurement says the second listing matters.
* `measure-build-steps.ts` and the standalone codegen CLIs take their own snapshot at the start.

### 3. Consumers
**a. Plugin tree.** `buildPluginTree(pluginsRoot, { repo, … })`: `repo` becomes **required**, so no caller can reach the disk walk.
* `findAllPluginDirs` comes from `repo.hasDir` / `childrenOf` / `under`. The hollow-shell rule (`hasPluginContent`) becomes "has a member path below it, outside `node_modules`, dot-dirs and `plugins/`". Because membership comes from git, a leftover untracked `node_modules` cannot make a plugin.
* The barrel probes and `collectCoreFields`' existence checks use `repo.has`.
* `buildFsSnapshot(root, dirs, repo)` builds `dirs` from `childrenOf` (no `readdir`) and reads only member files.
  * `FsSnapshot.dirs`' element type narrows from `Dirent` to a `{ name, isFile(), isDirectory() }` interface. Its consumers are `walkFiles`, the structure facet and the cross-refs facet.
* **Memos:** `buildBarrelFreeTree` / `buildEnrichedTree` / `buildStructureTreeOnce` move from a per-root `Map` to a per-repo `WeakMap`. That is the existing `contextsByRepo` pattern at `plugin-registry-gen.ts:443`, and it gives one tree per snapshot.
* `app-artifacts.ts:496`'s direct third faceted build reuses the memoized barrel-free tree.
* The server's watcher-invalidated `structure-tree-cache.ts` takes a `loadRepoFiles` per rebuild (one git listing in place of a walk).

**b. Codegen.** `buildRegistryGenContext(root, repo)`: `repo` becomes required and is threaded from `regen-pipeline.ts:122`, which creates the context once.
* The generators' per-node `existsSync` barrel probes use `ctx.repo().has(…)`.
* `data-views-gen` and `icon-manifest-gen` take the file list from `repo.under`.
* `lsFilesSync` is deleted where the caller holds a snapshot, and kept only where no async caller exists, with a comment saying why.
* **Helpers:** `walkFilesAsync` is deleted. `walkFiles` keeps its snapshot path, and its disk fallback stays only for the callers outside the build that set no snapshot.

**c. `ensureDeps`.** The input set becomes a pure filter, `depInputsOf(paths)` (every `package.json` and `provision/index.ts` under the workspace roots).
* The build's two calls hand it `S0.all()` as plain data.
* The bootstrap call, which runs before any command, lists through one pathspec-limited `git ls-files -z --cached --others --exclude-standard -- <workspace roots>`. That is allowed: `spawn/core` is in its pre-install allowlist.
* The signature still stats each input, so an edit made after install is seen.
* The `readdirSync` recursion is deleted. The filter is the one source of "what counts as a dep input"; only the listing differs.

**d. Web-artifacts.**
* **Each artifact's own hash** is `sha256` over the sorted lines `rel \t blob` of its own files. Those come from `S1.under(root)` filtered by the existing `isSkippedDir` / `isSkippedFile` rules and `!isSymlink`, plus `package.json`.
* Glob roots hash `S1.under(rel)` the same way.
* **`FingerprintCache` is deleted**: the load/save in `store.ts`, `cachedAggregateHash`, and the `fingerprints/<wt>.json` files (reaped once). A fresh worktree then knows every address at once.
* **The builder identity** reads `builderSource` blob ids from S1 and finds the vite contributions with `S1.glob("plugins/**/vite/index.ts")`, so the depth-12 walk goes away.
* **The browser-host input hasher** uses blob ids and `childrenOf` for its directory listings, in place of sha256 and `readdirSync`.
* **The pooled build workers** receive each target's file list in the request, which is serializable. Their `listOwnFiles` call (`vite-builder.ts:551`, for the Tailwind candidates) reads that list.
* **The address format changes, so `BUILDER_VERSION` goes 8 → 9.** It is a one-time, fleet-wide cold rebuild, and the intended one: the artifacts' bytes stay the same, only their addresses change.
* **New loud guard in `inline-audit.ts`:** every repo module a build bundles must be a member of the snapshot it was addressed from. A gitignored file pulled in through an `import.meta.glob`, or a writer that forgot to report into `extra`, now fails the build and names the file. Before, it was silently hashed off disk; after, it would be silently omitted. The guard makes it loud instead.

### Scope
* **In:** §1–3.
* **Out:**
  * **The checks' tree hash** (`computeTreeHash`, `read-set.ts`, `repo-view.ts`). The track page now files it under this item. Its own study (`research/2026-10-29-global-type-check-tree-hash-follows-the-change.md`) measured under 1 % of a build. It needs a persisted index plus a watcher decision (fsmonitor, about 219 daemons, against one host-wide watcher). It runs in the check subprocess, which would need S1 passed in as a file. I propose that as its own step, on top of this snapshot.
  * **`core.untrackedCache`.** It would make git's untracked listing O(changed dirs). It is a shared repo config change, so it will be measured on the VM only and proposed, not applied.

## Gates
* **Equivalence, scripted** (`web-artifacts/scripts/own-files-equivalence.ts`, one-off): for every target of the main composition and of one other composition, the old walk's file set equals the new set.
  * The only expected difference is gitignored files, which must equal the `extra` list.
  * Also: the old `findAllPluginDirs` returns exactly the new plugin dirs.
* **Byte-identical outputs on the main composition:** generated registries, docs and manifests (`git status` clean after a build), and the artifact bytes. Only the addresses change.
* **VM, quiet 6-core** (`sidequests/clean-install/steps-build-pipeline.sh`, `BUILD_PIPELINE_STEPS="baseline install lib w0 w1 w3"`, median of 3):
  * Before is main at this branch's base; after is this branch.
  * Record codegen and frontend per step, and the whole build with `--skip-checks`.
* **`fs_usage` on one W0, before and after:** a new harness step `fsu` that runs `sudo fs_usage -w -f filesys` filtered to the build's process tree, and counts `getdirentries`, `access`, `stat` and `open`.
  * Target: `getdirentries` down about 10× (from 157k) and `access` down sharply.
  * Expected: W0/W3 codegen + frontend drop by most of the ~4.5 s walk cost.
  * W3 gains extra, because the fingerprint file no longer starts empty.
* **No cold regression:** one CF run. Cold is not this step's target, but the address change must not cost anything there.

## Implementation order
1. `loadRepoSnapshot` + tests (dirty, untracked, deleted, a symlink, an `extra` ignored file, an unmerged path, a git failure that throws).
2. Plugin tree + codegen threading (required `repo`, `WeakMap` memos). Run the plugin-tree and codegen tests, the plugin-dir equivalence, and a docs/registries byte diff.
3. `ensureDeps` filter.
4. Web-artifacts: own hash from blobs, glob roots, identity, browser host, worker file lists, the `FingerprintCache` deletion, the `BUILDER_VERSION` bump, the audit guard. Then the equivalence script and the web-artifacts tests.
5. Wire S0/S1 in `run.ts`. Then `./equin build`, the app via `browser_*` (agent manager, pages, the lumen demo boots), `./equin check`, a `--composition` build (the composition registry's `extra` path), and a hermetic build.
6. Add the harness `fsu` step. VM before/after, then the measurements page, the track page's benchmark and status, and the next main task (plugin records, item 4) filed with the page id.

## Critical files
* `plugins/framework/plugins/tooling/core/repo-files.ts` and `types.ts`.
* `plugins/plugin-meta/plugins/plugin-tree/core/internal/{plugin-tree,fs-snapshot}.ts` and `server/internal/structure-tree-cache.ts`.
* `plugins/plugin-meta/plugins/parse-utils/core/{helpers,snapshot-scope}.ts`.
* `plugins/framework/plugins/tooling/plugins/codegen/core/`:
  * `regen-pipeline.ts`, `plugin-registry-gen.ts`, `barrel-free-tree.ts`, `enriched-tree.ts`;
  * the per-node probe sites listed above.
* `plugins/framework/plugins/cli/plugins/bootstrap/cli/ensure-deps.ts`.
* `plugins/framework/plugins/cli/plugins/build/cli/{run.ts,internal/app-artifacts.ts}`.
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/`:
  * `own-files.ts`, `store.ts`, `identity.ts`, `browser-hosts.ts`, `pipeline.ts`, `plan.ts`, `inline-audit.ts`, `vite-builder.ts`;
  * `core/constants.ts`.
* `plugins/framework/plugins/web-core/core/vite-contributions.ts`.
* `sidequests/clean-install/steps-build-pipeline.sh`.

## Outcome (2026-11-03)

What was built, and where it differs from the plan above:

* **`loadRepoSnapshot`** (`tooling/core/repo-files.ts`), as designed: `ls-files -s` + `--others` + `--deleted` + `diff-files`, then one `hash-object --stdin-paths` for the changed files. `loadRepoFiles` shares its membership rule (`membership`).
* **Plugin tree**: `findAllPluginDirs`, `hasPluginContent`, the barrel probes, `collectCoreFields` and the fs-snapshot directory walk all read the file set. `repo` is an option of `buildPluginTree`: with none, the tree lists git itself, so no caller can reach a disk walk; `PluginTree.repo` carries the set to its consumers (`sourceFilesIn` replaced `walkFilesAsync`, deleted). The structure facet reads its folder list from the snapshot. The enriched tree reuses the barrel-free tree's set (one listing per process); the build lists once in stage 1 (`repoFiles` span, ~0.2 s).
* **ensureDeps**: one rule (`isDepInput`), two listings. The build's two calls filter stage 1's set; the bootstrap call keeps its walk, because git's untracked listing measured slower than it (0.65 s vs 0.4 s on the loaded host) and nothing has listed the repo yet when it runs.
* **Web-artifacts**: addresses from blob ids (`OwnSources`), the `FingerprintCache` deleted, the glob patterns per module memoized by blob id (`glob-patterns.json`, shared, merged on save). The builder identity reads `vite/` contributions and its own source by blob id (`isViteContributionPath`, tested against the walk). The inline audit now holds a bundle to the exact hashed files (`ownFiles` + `globFiles` on the target), which is what makes "a file outside the snapshot" loud. No `BUILDER_VERSION` bump was needed: the address function itself changed, so every address is new.
* **Not changed**:
  * The browser-host input hasher. It now covers only the Service Worker's few modules, so it is no `plugins/` walk.
  * `loadBabelContributions`' walk. It runs once per builder process, and only when something is stale.
  * `extra` stayed unused: the composition registries are read by the registry artifact directly, never through an own-file address. The inline audit would name one that is.
* **Equivalence** (`web-artifacts/scripts/own-files-equivalence.ts`): 1,641 plugins, 2,488 artifact roots, the snapshot's own-file lists equal the old walk's. Generated registries are unchanged after a build; docs changed only for the new exports.

**VM, quiet 6-core, median of 3** (W3: 2), seconds:

| Scenario | Codegen + migrations, before → after | Frontend | Whole build `--skip-checks` |
| --- | --- | --- | --- |
| W0 no change | 18.1 → 16.2 | 1.83 → 1.65 | 23.2 → 21.1 |
| W1 web edit | 27.0 → 14.3 (before run noisy) | 6.2 → 2.9 | 41.2 → 20.9 |
| W3 fresh worktree | 22.4 → 17.5 | 3.1 → 2.3 | 38.4 → 31.4 |
| CF cold frontend | n/a | 35.0 / 39.1 / 78.6 → 34.8 / 32.3 / 32.5 | n/a |

* `artifacts:detect` 0.53 → 0.07 s, plus the new `artifacts:snapshot` 0.32 s.
* `bun install` (ensureDeps) 0.14 → 0.01 s.
* `plugin registry` 0.42 → 0.23 s.
* `dataViews` 0.29 → 0.18 s; `iconManifest` 0.78 → 0.54 s.
* `slot declaration guard` 2.67 → 2.20 s.

**fs_usage, one W0 build** (the harness's new FSU step; counted per thread):

| | before | after |
| --- | --- | --- |
| `getdirentries`, build process, without the `tsc repo` thread | 139k | 64k |
| `getdirentries`, `tsc repo` thread (build-speed track) | 76k | 76k |
| `getdirentries`, git children | 83k | 67k |
| `access`, build process | 216k | 189k |
| `lstat`, build process (almost all `tsc repo`) | 482k | 482k |

The 10× target on `getdirentries` was **not met**. What remains on the build's main thread is no longer a walk of ours:
* Bun's module resolver importing the ~11k barrel modules (the directories read are `web/`, `internal/`, `components/` — the barrels' own trees). This is redesign item 4 (plugin records: no barrel import to know a plugin's facts).
* The `tsc repo` pass, which `--skip-checks` still runs (the build-speed track).
* Small leftovers: the bootstrap ensureDeps walk (~0.13 s), `discoverCollectedDirs`' two sync `git ls-files` (its sync callers), and `scanStagedModules` reading the dist.

Leftover on disk: `~/.equin/cache/web-artifacts/fingerprints/` (2.8 GB on this host) is no longer written by this code. It is not deleted automatically, because checkouts on older code still write and read it until they rebase.
