# Build pipeline step 10: a build with nothing changed should do close to nothing

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1793990348-xsfvxl. Previous step: `2026-11-06-global-build-pipeline-step9-fresh-boot-and-snapshot-key.md`. Input (not a commitment): `2026-11-05-global-build-pipeline-step7-one-view-one-graph.md`.

## Context
After step 9 a W0 build (nothing changed) is ~10.4 s whole on the quiet VM, a fresh worktree's first build ~27 s. Nobody had split the current whole build since steps 7–9. Goal: split W0 / W1 / W3 top-down, fix by measured size, cold (CC, C0) must not regress.

## 1. The split (quiet VM, main `c2f1e35875`, W0 ×3, `--skip-checks`)
Build profile spans, ms (three runs). Wall 10.41 / 10.67 / 11.33 s; the profile covers 9.6–10.5 s of it, the rest is CLI start-up.

| Part | W0 | W0-prime (a worktree's first build = W3) |
| --- | --- | --- |
| **Parallel stage** (critical path = `tsc:repo`) | tsc 2.1–2.6 / frontend 1.7–2.1 | tsc **10.9** (full type-check walk: none recorded in the checkout) / frontend 4.1 |
| `adoptDeploy` (backend asked to keep running) | **1.21–1.31** | **4.4** |
| `pluginDocs` | **1.24–1.36** | 1.8 |
| `seedAuthoredOverrides` | **0.75–1.04** | 1.75 |
| repo snapshot loads: `repoFiles`, `migrationVerdict`, 2 inside the evaluations, `artifacts:snapshot` | ~0.25 + 0.28 + ~0.5 + 0.37 ≈ **1.4** | ≈ 2.3 |
| `browserHostInfer` + `Coverage` | 0.81–0.89 | 0.86 |
| `slotDeclarations` | 0.53 | 0.99 |
| `artifacts:compose` (inside the parallel stage) | 0.67–0.75 | 1.8 |
| `packageNames` / `formatSources` / `exemptRuleIds` / `propagateConfig` | 0.36 / 0.25 / 0.18 / 0.13 | 0.97 / 0.80 / 0.26 / – |
| CLI start-up before the build's clock (two bun processes, each walking `plugins/` for ensureDeps ~0.17 s, plus module load) | ~0.8–1.3 | ~2.7 |

W1 (a web edit, ×3) and W3 (a fresh worktree, ×2), same run, ms:

| Part | W1 | W3 |
| --- | --- | --- |
| Wall | 13.9–15.4 s | 29.0–29.3 s |
| `tsc:repo` (critical path) | 4.8–5.9 s | 11.5–12.4 s |
| `adoptDeploy` | 1.29–1.39 | 4.84–5.92 |
| `seedAuthoredOverrides` | 0.80–0.92 | 1.92–2.05 |
| `pluginDocs` | 1.12–1.40 | 1.70–1.78 |
| `slotDeclarations` | 0.88–1.33 | 0.89–0.91 |
| snapshot loads (`repoFiles` + `migrationVerdict` + `artifacts:snapshot` + 2 in evaluations) | ~0.9 | ~2.3 |

What each big part is (code + VM CPU profile of the build process):
* **`adoptDeploy`**: the running backend answers "would a fresh process run exactly my code?" by re-walking its whole server import closure (`source-digest/shared/digest.ts` `closureChangedSince`): 5,365 files read, import-scanned and resolved, on every build. Host measure of the parts: reading the bytes ~0.94 s, scanning 0.15 s, but `stat` of every file 20 ms and re-resolving all 18,751 imports 42 ms. The bytes are only needed to learn each file's imports, and a file whose inode change time predates the process start has the same bytes as when it was last scanned.
* **`seedAuthoredOverrides`**: reorder's `seedWhen` ("seed only a slot with ≥ 2 items") is a function, so it is not in the evaluated records. ~95 reorderable slots with < 2 items have no override file, so every build imports every barrel LIVE (`loadConfigDescriptorsByOriginPath({ live: true })`) just to call it again.
* **Snapshot loads**: `loadRepoSnapshot` runs 5 times per build in one process (each: `ls-files -s`, `status` with the untracked walk, `diff-files` lstat of every tracked file). The writing pass re-lists before each evaluation only to key manifests codegen itself wrote.
* **`tsc:repo`**: belongs to the build-and-push-speed track (type-check worker, tree hash; W3's 10.9 s is its per-checkout walk state). It is the parallel stage's critical path, so frontend savings do not shorten W0 until it does. This step only splits it (worker wall vs slot wait vs process start) and records it there.

## 2. Fixes, by size (this track)

### a. Adoption reads what changed, not the whole closure (W0 −1.1 s, W3 −4 s)
* `closureChangedSince` keeps, per process, each scanned file's facts — its import specifiers and their resolutions — keyed by the file's `(ino, size, ctimeMs)` from the stat it already does. A file whose stamp is unchanged is not read again: its specifiers are the memo's, re-resolved (`Bun.resolveSync`, cheap), so a new shadowing file or a re-pointed package still changes the walk exactly as before.
* Same rule, same answer: the walk still visits every file of the closure, still stats it against `sinceMs`, still lstat's package entries. Only the read + scan of an unchanged file is skipped — its bytes cannot differ (the ctime argument the judgement already rests on).
* The digest's prewarm (`closureOf`, run at boot over the same walk) feeds the same memo, so the first adoption after a boot is cheap too.
* Not a fingerprint: O(closure) stats (~20 ms), O(changed files) reads.

### b. `seedWhen` as data (W0 −0.7 s, W3 −1.7 s)
* `requiresAuthoredOverride.seedWhen` becomes a declarative condition the evaluated record carries (reorder's: `{ minItems: { field: "items", count: 2 } }`), evaluated by codegen. The live barrel import and its `liveDescriptor` path are deleted: inexpressible, not cached.

### c. One file view per build (W0 −~1.0 s)
* The step 7 plan's §1: the build's snapshot plus a write ledger filled by `writeGenerated` (and every other codegen/migration/format write). `phaseRepo()` answers the view instead of re-listing; drizzle-verdict and the frontend take the view instead of their own load.
* Loud check: a file a later reader keys whose blob differs from the view fails the build by name (the frontend stage compares the paths it keys).
* Done only if (a), (b) leave it the biggest; its risk is a write that escapes the ledger.

### d. `pluginDocs`, then compose and start-up — split first, fixed by size
* `pluginDocs` 1.3 s: enriched tree from records, render of ~1,700 `CLAUDE.md`, the two global docs, `mainComposition`/`mainBundle` computed repeatedly (~0.45 s inclusive in the profile), reading every existing doc to compare.
* compose 0.7 s (`scanStagedModules` re-reading staged modules) sits behind `tsc:repo` in W0: lower priority.

## Not the fix
* A whole-build "nothing changed" fingerprint that skips codegen: global, invalidated by any edit, hides the per-step costs.
* Skipping adoption (always restart, or never ask): either restarts the backend for nothing or serves stale code.
* Caching barrel imports for `seedWhen`: the function should not need a live import at all.

## Gates
* Tests: source-digest (`closure-since.test.ts`, `digest.test.ts`), restart-skip judge, config_v2 / codegen seeding tests, reorder directive.
* A server edit still restarts the backend (W4); an untouched build still adopts; a new file shadowing an import still counts as changed (unit test).
* Generated config overrides unchanged (`config:overrides-authored`, `config-origins-in-sync`).
* VM (`steps-build-pipeline.sh`): before = this run (`si-clean-bp10-before`), after = the branch: W0 ×3, W1 ×3, W4 ×3, W3 ×2, CC (cold must not regress), alternating where it matters.

## Critical files
* `plugins/packages/plugins/source-digest/shared/digest.ts` (walk memo), `plugins/build/plugins/restart-skip/shared/judge.ts`.
* `plugins/config_v2/core/internal/{types,define-config}.ts`, `plugins/reorder/shared/directive.ts`, `plugins/framework/plugins/tooling/plugins/codegen/core/authored-override-seed.ts`, `config-origin-gen.ts`.
* `plugins/framework/plugins/tooling/core/repo-files.ts`, `codegen/core/{codegen-pass,write-generated}.ts`, `cli/plugins/build/cli/internal/app-artifacts.ts`, `migrations/cli/drizzle-verdict.ts`, `web-artifacts/core/internal/pipeline.ts`.
* Harness: `sidequests/clean-install/steps-build-pipeline.sh` (`BUILD_PIPELINE_W0_FULL=0` skips the ~19 min full build).

## Outcome (2026-11-06)
Landed (a), (b), (c) and a smaller `pluginDocs` fix; (d) beyond that is the next step's.

**What changed**
* **(a) Adoption.** `closureChangedSince` remembers each scanned file's import specifiers under its stat stamp (`ino:size:ctime`, only when the stamp before and after the read agree), and memoizes the `node_modules` entry lookups per (directory, package) within one walk (they were ~11,000 `lstat`s for ~1,400 package imports). Every walk still stats every file against the instant and re-resolves every import. A boot warm-up (`restart-skip.closure`) walks the entry closure once. A memo walk of the 5,368-file closure on the host: 0.64 → 0.36 s (stats 0.15, resolution 0.08); the first, reading walk ~1–3 s.
* **(b) `seedWhen` is data** (`SeedCondition { field, minLength }`, validated against the config's fields at `defineConfig`); the seeder no longer imports every barrel live.
* **(c) The build's repo view** (`tooling/core` `openRepoView`): one snapshot per build, updated by the writers' notes (`noteRepoWrites`: `writeGenerated`, docgen and config-origin unlinks, package names, the formatter, relocate's restamp, migrations through `noted-fs.ts` plus the migrations dir after the drizzle-kit child, `bun.lock` after an install). The evaluations and the drizzle verdict read it; the frontend's own snapshot checks every answer read off it (`assertAgrees`) and fails the build naming any file a writer did not note (it caught an edit made during one of this session's builds).
* `pluginDocs` resolves the main composition once instead of three times.
* `tsc:repo` now logs its split (slot wait, worker wall, CPU) for the next step.

**Quiet VM, paired: base `c2f1e35875` and this branch in two worktrees of ONE VM, alternating, runs 2–4** (s; codegen + migrations = `packageNames` start → `formatSources` end):

| | Base | After |
| --- | --- | --- |
| W0 whole build | 9.68 / 9.71 / 9.81 | **7.88 / 8.02 / 8.06** |
| W0 codegen + migrations | 4.82 / 4.85 / 4.91 | **3.78 / 3.83 / 3.93** |
| … `seedAuthoredOverrides` | 0.63–0.66 | **0.03** |
| … `slotDeclarations` / `pluginDocs` | 0.48 / 1.15–1.17 | **0.26 / 0.92–0.99** |
| … `migrationVerdict` | 0.27 | **0.07** |
| `adoptDeploy` | 1.23–1.24 | **0.75–0.76** |
| W3 (fresh worktree) codegen + migrations, 2 pairs | 7.17 / 8.59 | **4.35 / 4.93** |
| W3 whole | 22.7 / 27.5 | 21.8 / 26.6 |

* Confounds in the W0 pairs: the after worktree's git index had just been refreshed (`repoFiles` + `artifacts:snapshot` ~0.3 s cheaper, untouched code), and its uploaded files were dirty (`formatSources` +0.15 s). Net, the change is worth ~1.5 s of W0.
* Separate VMs, before → after (the first after-run, without the `node_modules` memo): W0 whole 10.41–11.33 → 8.18–8.25 s, codegen + migrations 5.30–5.79 → 3.55–3.60; W1 13.87–15.41 → 11.00–12.23, 5.93–6.51 → 4.15–4.26; W3 29.0–29.3 → 21.3–21.4, 9.1–9.5 → 4.3–4.6.
* **Cold codegen (CC) does not regress:** base 12.63 / 9.95 s, after in-process 11.72 / 9.77, pooled 8.63 / 9.17.

**Found, not fixed**
* **W3's 5–6 s `adoptDeploy` is the fresh backend's first boot.** No process runs before the build: the adoption request itself makes the gateway cold-start one (its process starts at the request). Skipping adoption for an idle namespace and starting it through the restart route was built and measured: `restartBackend` 5.0–7.3 s against adoption's 5.8–6.3 s, so the deploy waits for that boot either way. Reverted; the boot is the cold-start track's.
* **`tsc:repo` is now the W0 critical path by itself** (1.95–2.2 s, frontend 1.55–1.7 s behind it), and W1's (4.2–5.7 s) and W3's (9–11 s: no walk recorded in a fresh checkout). Build-and-push-speed track.
* What is left of W0 codegen (~3.8 s) is thin: `pluginDocs` 0.93, `browserHostCoverage` + `Infer` 0.8, `packageNames` 0.35, the repo snapshot 0.25 (now once), `slotDeclarations` 0.26, `formatSources` 0.25. Then `adoptDeploy` 0.75 (stats, re-resolution, loaded modules, children) and `artifacts:compose` 0.65–0.85 behind `tsc:repo`. CLI start-up before the build's clock (two processes each walking `plugins/` for `ensureDeps`, plus module load) is ~0.8 s.
