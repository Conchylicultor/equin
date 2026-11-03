# Build pipeline step 3b (v2): the cold artifact build off one thread, then the repo snapshot

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). v1: `…-step3b-batched-artifacts-and-repo-snapshot.md`.

**v1 → v2.** v1 bet on batching: one Rolldown run per wave, to remove per-run setup. Phase 0 measured where a cold artifact build's time goes, and setup was not the main cost. Part A is redesigned below. Part B (the repo snapshot) is unchanged and moves to the next session.

## Phase 0 results (quiet 6-core VM, 2026-11-02)
* **The cold frontend alone** (`scripts/measure-frontend-cold.ts`: the pipeline from an empty data root, nothing beside it) takes **41.5 / 41.6 / 39.6 s**.
  * Of that, 32.5–34.2 s is `artifacts:build` (1,937 artifacts).
  * Compose is 0.7 s. The 4 s seen in 3a's cold runs was contention with the parallel checks: `build --hermetic` now refuses `--skip-checks`, so a cold build always runs its checks beside the frontend.
* **Per artifact** (`scripts/measure-artifact-build.ts`, 60 web artifacts):

  | Variant | ms/artifact |
  | --- | --- |
  | full `buildArtifact` | 26.2 |
  | single vite run, Babel | 18.9 |
  | single vite run, no Babel | 4.6 |
  | batched, Babel | 13.7 |
  | batched, no Babel | 0.7 |

  * Babel with the React Compiler is about 95% of a batched build's CPU.
  * Setup per run is about 4 ms.
  * The post-build steps (audits, sourcemaps, Tailwind candidates, publish) are about 7 ms.
* **The pipeline was single-threaded.** Its "concurrent" builds share one JS thread, because Babel runs on it. 1,937 × \~18 ms ≈ the measured 34 s.
* **Splitting the work** (`scripts/spike-build-threads.ts`, 1,100 web artifacts, batched):
  * 1 process 22.5 s, 3 processes 11.1 s, 6 processes 12.9 s, 6 threads 12.2 s.
  * One run already keeps \~1.7 cores busy (Rolldown's native threads), so about ⅔ of the cores saturate the machine.
  * Small batches do not scale at all (240 artifacts: 6.3 → 4.7 s), because each worker pays its own JIT warm-up.
* **The long tail is small:** the slowest artifact is 1.1 s (data-view's web), the 10 slowest are 15% of the total.
* **A native React Compiler** (the React team's Rust port, merged into oxc 0.135, June 2026) is not in the installed Rolldown 1.2.15 binding. It would remove most of the 95%. Follow-up.

## Part A as built
1. **Babel only where a contribution applies.**
   * The `vite/` contribution contract (web-core `BabelContribution`) gains a required `appliesTo({ id, code })`.
   * The React Compiler applies to `.tsx`/`.jsx`, a `use[A-Z0-9]` token, or `"use memo"`. Element-picker applies to `.tsx`/`.jsx`.
   * The builder's own `babelContributionsPlugin` (`web-artifacts/core/internal/babel-transform.ts`) replaces `@vitejs/plugin-react` with its production options.
   * Byte-identical on a 120-artifact sample (`scripts/babel-equivalence.ts`). Cold frontend 41.5 → 33.2 s.
2. **A pooled builder.**
   * `packages/thread-pool` (cli barrel) provides `createThreadPool` / `serveThreadPool`: lazy, warm workers, one request each, a loud contained failure.
   * Web-artifacts gets an `ArtifactBuilder` seam in the pipeline and `createArtifactBuildHandler` (core), `bin/build-worker.ts`, and `createPooledArtifactBuilder` / `idealArtifactBuildThreads` (cli).
   * The build CLI runs about ⅔ of the cores' worth of threads, clamped to its grant, and admits the pipeline for that many units.
   * Cold frontend: 2 threads 24.2 s, 3 21.2 s, **4 18.9 s**, 6 21.0 s. Peak RSS 2.9 → 4.1 GB.
3. **The `scripts` boundary row may import `cli`** (as `bin` does).

## Not done in this step, in order of value
* **Native React Compiler (oxc)**, once the bundler ships it: removes most of the remaining CPU.
* **Batching** (v1's A1): each worker builds its share as multi-entry runs. Measured −27% CPU per artifact, at the cost of per-module owner routing for the audits, externals and CSS.
* **Part B, the repo snapshot**, as in v1.

## Verification
* Tests: `packages/thread-pool` (5), `web-core/core` (contract + the repo's contributions), web-artifacts `babel-transform`. 229 in all.
* `./equin build` green. The agent manager and the lumen demo were checked in the browser: the worker host booted on the pooled artifacts, every worker-tree module returned 200, and there were no console errors.
* VM before/after (C0/C1, W0, W1, W4, CF) on the track page.
