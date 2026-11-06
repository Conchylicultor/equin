# Build pipeline step 7 (v2): split the real-world build first, then fix by size

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1793964742-k0g8vg.
v1 (input, never reviewed): `2026-11-05-global-build-pipeline-step7-one-view-one-graph.md` — one file view and one module graph per build, ~1.5 s warm / ~2 s cold.

## Context
The quiet-VM numbers fell from step to step while main's auto-builds got slower: p50 42 → 83 s and p90 101 → 271 s, week of 10-19 vs week of 11-02. Nobody had split the real-world build. v1 removes duplicated codegen work, but it never asked where the real build's time goes, or how the remaining W0 6.1 s and cold ~38 s break down.

## 1. The real-world split (measured 2026-11-06 on the 18-core host)
Sources:
* `~/.equin/logs/op-log/op-log.jsonl`: every build's request → completion, with its admission waits (5,176 builds since 07-17).
* `~/.equin/worktrees/*/build-profile-<id>.json`: span profiles, 462 kept (50 main, 412 agent).
* `check-progress.jsonl` / `build-progress.jsonl`: timestamps for the spans the profile lacks.

**Main, per day (op log, successful builds; work = total − admission waits):**

| Day | n | Total p50 / p90 | Work p50 / p90 |
| --- | --- | --- | --- |
| 10-26 | 37 | 37 / 49 | 37 / 44 |
| 10-28 … 11-02 | 29–52/day | 50–65 / 109–188 | 50–65 / 64–171 |
| **11-03** | 16 | **110 / 421** | 90 / 421 |
| **11-04** | 70 | **133 / 591** | 108 / 479 |
| 11-05 | 95 | 69 / 158 | 60 / 109 |
| 11-06 | 8 | 30 / 52 | 30 / 52 |

* The weekly p50 of 83 s is mostly two incident days, 11-03 and 11-04. Those days landed step 3c and step 4 (cold records and artifacts after every push), and a main-checkout incident: a build raced a push and left 135 config overrides dirty, which failed later main builds (`main-tree-guard.ts`). Main has no profiles from before 11-05, so those days cannot be split further.
* The underlying drift: 37 s (10-26) → 50–60 s.

**Main, where it goes now** (50 profiles, 11-05 → 11-06; p50 / mean, s):

| Part | p50 | mean | share | Owner |
| --- | --- | --- | --- | --- |
| Host grant wait | 0 | 5.1 | 9 % | adaptive scheduler |
| Codegen + migrations | 13.4 | 14.1 | 26 % | this track (VM: 6 s; host load ≈ 2×) |
| Frontend | 6.6 | 7.8 | 14 % | this track |
| Checks after the frontend is done | 10.5 | 12.7 | 23 % | build-and-push speed |
| **Gap: checks done → publish** | **5.8** | **6.3** | **12 %** | **this track: carry-forward, unprofiled** |
| Deploy (restart, health probe, central) | 6.8 | 7.3 | 13 % | cold-start track |
| Total | 49.7 | 54.1 | | |

**Agent builds** (330 profiles since 11-02; p50 / p90 / mean, s; total p50 297):

| Part | p50 | p90 | mean | share | Owner |
| --- | --- | --- | --- | --- | --- |
| Host grant wait | 51.5 | 627 | 221.5 | **39 %** | adaptive scheduler |
| Checks after the frontend is done | 94.2 | 605 | 224.2 | **40 %** | build-and-push speed |
| Codegen + migrations | 26.6 | 119 | 52.3 | 9 % | this track (≈ 4× the VM: host load) |
| Frontend | 10.7 | 43 | 27.5 | 5 % | this track |
| Deploy | 11.9 | 42 | 19.6 | 3 % | cold start |

Agent builds are not getting slower: op-log work p50 343 → 295 → 357 → 152 s across the last four weeks. **79 % of an agent build belongs to the two sibling tracks.** This track's own steps are 14 %, and on the host they run at 2–4× their VM cost.

### Found 1: carry-forward is O(history) on every served build, unprofiled
* `carryForwardServedEntries` (`web-artifacts/cli/internal/carry-forward.ts`) recreates in staging every `artifacts/<name>` link of the live dist.
* Main's dist links **37,387** names. One build's own graph is ~2,000. Replaying the read and symlink side on main's live dist: **5.0 s** (0.5 s of it reads).
* The count only grows: 32,332 → 35,016 in 1.5 days (+~1.8k a day, one full fleet per builder-identity change).
* The original design (`research/2026-09-10-global-stale-tab-plugin-loading.md`) said the 14-day cache prune bounds the set. A later change made every dist link a prune root, so a carried target is never pruned, and so it is carried forever.
* Task task-1793773096-i6fsda already owns **how long** a stale tab must keep working (a product question, unanswered in its triage). **What this step owns is the cost:** re-creating the whole set on every build. That is O(history) per build where O(new names) is enough, whatever the retention window.

### Found 2: the demo's host snapshot re-seeds on most builds (new, 11-06)
* `artifacts:host-snapshots` (8fb90a3422, today) re-ran in 6 of the 8 profiled builds since it landed, **6–15 s each**, on the critical path.
* Its address covers every artifact of the demo worker's closure (298 server plugins), so any server edit in that graph re-runs the seed.
* Recorded as a finding for the next step. Not fixed here: whether the seed's address must really cover the whole closure is a question about what the seed reads. The answer needs its own measurement.

## 2. Fix: one address directory per served namespace (carry-forward O(new))
* **The design:**
  * A served namespace gets one persistent directory of `<name> → store` links, `<nsDir>/web-addresses/`.
  * Every dist's `artifacts` is a symlink to it.
  * Compose links this graph's ~2k names into it, creating only the names that are new.
  * Carry-forward of artifacts disappears; `assets/` (~33 copied files) stays as is.
* **Why it is the same guarantee:** today's dist after carry = (this graph) ∪ (previous dist's links whose target exists). The pool = (every graph composed into it) minus nothing. The difference:
  * a link whose target was pruned stays dangling, which is still an honest 404;
  * a failed build's links are added too: valid, content-addressed, harmless.
  * Retention stays exactly where it is: task-1793773096-i6fsda. With a pool, a retention rule later costs O(expired), not O(history).
* **Gapless and revertible as before.** Adding a link never changes what an existing name serves, because addresses are write-once. A reverted publish repoints at the previous release, whose `artifacts` is the same pool.
* **Changes:**
  * `core/internal/compose.ts`: a `links into` option (`addressDir`).
    * When set, it creates `staging/artifacts → addressDir` and links each name that is absent.
    * An existing name must already link the same store path, else it throws.
    * `materialize` (release) keeps the real directory, and the two options are exclusive.
  * `core/internal/staged-verify.ts`: scan the links compose made (the `links` list), not a listing of `artifacts/`. Listing the pool would lex the whole history.
  * `pipeline.ts` / `WebArtifactsPipelineOptions`: pass `addressDir` through.
  * Build CLI (`app-artifacts.ts`): a served target passes `addressDir` (from `distNames`).
    * The first build per namespace seeds the pool from the live dist's links (one-time O(history), then never again).
    * The artifacts half of carry-forward is gone; `carryForwardServedEntries` keeps assets only.
  * `served-dists.ts` (prune roots): a dist whose `artifacts` is a link to a pool is read through it.
    * The memo stamp is the pool's (inode, mtime), so the same pool under `web` and `web.live.*` is read once per change, not once per dist.
    * `web-addresses` is not a `web.*` dist name, so it never scans as a dist of its own.
  * `dist-publish.ts`: `keep()` / `revert()` / sweep remove a release with `rm -r`. Verify (test) that removing a release removes its `artifacts` link, never the pool it names.
* **Expected:** main's publish gap 5.8 s → ~0.3 s (compose's ~2k lstat), every served build. The prune's per-dist link reads drop from (dists × history) to (pools × history).

## 3. Cold and warm codegen: what v1 keeps
v1's items are kept, ordered by measured size, each only after its own measurement (v1 §0):
* §3 buffered record writes (~0.3 s cold);
* §1 one file view (−2 snapshot loads, ~0.5 s warm and cold);
* §5 the pre-barrel guard on the ledger (~0.25 s);
* §2 one module index (~0.8 s).

**Order in this session:** §2 above first, because it is measured and the largest real-world item this track owns. Then v1 §3 and §1, as far as the session allows. What does not land is listed on the track page as the next step.

**Cold frontend (22.7 s, ~95 % Babel + React Compiler CPU):** the native React Compiler is still not shipped. oxc-transform 0.157 and rolldown 1.3.0 (published 11-05) have no `reactCompiler` option (checked in their type declarations, 2026-11-06). The remaining levers are batching (−27 % CPU per artifact, measured in 3b) and the 1-unit grant on the 12 GB VM (`cpuBudget().B = 1`, step 6), which makes a real cold build there run its artifact pool on one thread. Both go on the page as the next step's candidates.

## Gates
* **Unit tests:**
  * compose with `addressDir`: absent names linked, existing equal kept, a mismatch throws;
  * the staged scan reads only the given links;
  * the pool seeded from a live dist;
  * the publish `keep`/`revert` never touch the pool;
  * the served-dists scan through a pool link.
* **A deployed build of this worktree** serves its app, and a second build adds 0 links. An old address (from the pool's seed) still serves through the gateway.
* `./equin check` passes, including `web-artifacts:map-in-sync`.
* **VM** (`steps-build-pipeline.sh`; before = main `9b417f528f`, after = this branch): C0, W0, W1, W3, CF, CC (3 alternating pairs). Warm must not regress. The VM's dists are young, so carry-forward is measured on the host instead: main's 37k pool, before vs after, on a replay.

## Critical files
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{compose,staged-verify,pipeline,served-dists}.ts`
* `plugins/framework/plugins/tooling/plugins/web-artifacts/cli/internal/carry-forward.ts`
* `plugins/framework/plugins/cli/plugins/build/cli/internal/{app-artifacts,dist-publish}.ts`
* `plugins/framework/plugins/tooling/plugins/web-artifacts/CLAUDE.md` (the served-dist invariants)

## Not the fix
* **Shortening retention to make the copy cheap.** That is a product decision (task-1793773096-i6fsda). It would still copy O(window) on every build.
* **Profiling the gap and moving on.** The span is added (`artifacts:carry`), but the cost has to go.
* **Making the gateway fall back to a carried directory.** It would need a gateway rebuild and restart, with the same result.

## Outcome (2026-11-06)
Landed: §2 (one address dir per served namespace) and v1 §3 (record writes held back to one transaction per flush). v1 §1, §2 and §5 were not done; they are the next step's candidates (below).

**Carry-forward, replayed on main's live dist on the host (37,387 links):**
* Before, every served build re-created all of them: **5.0 s** (0.5 s of it reads).
* After, a build's compose checks this graph's ~2,371 names in the address dir: **0.26 s**.
* The one-time seed from a legacy dist costs 12.4 s on the loaded host, once per namespace.
* A second build of this worktree added 0 links. The app serves through the link with no console error.

**Record writes:** a cold codegen made **3,691** SQLite write transactions (4.0 s on the loaded host). Now it makes 1 at the end of codegen, plus 1 at exit.

**Quiet VM** (`steps-build-pipeline.sh`; before = main `9b417f528f`, after = the same plus this branch; medians, s):

| Scenario | Before | After |
| --- | --- | --- |
| CC cold codegen alone, in-process (3 runs) | 14.26 / 12.59 / **12.69** | 11.94 / 10.13 / **10.06** |
| CC cold codegen alone, pooled (3 runs) | 11.77 / 11.99 / 11.67 → **11.77** | 9.33 / 9.48 / 9.49 → **9.48** |
| … pluginRegistry / eagerTier (in-process) | 1.53 / 0.81 | < 0.4 / < 0.4 |
| C0 cold hermetic build, "Generating plugin registry" → "Running checks" | 17.7 | **14.8** |
| W0 codegen + migrations / frontend / whole build | 5.57 / 1.89 / 10.27 | 5.68 / 2.11 / 10.60 |
| W1 | 5.59 / 3.27 / 12.35 | 6.19 / 3.61 / 13.42 |
| W3 | 7.79 / 2.48 / 22.0 | 8.34 / 2.81 / 25.0 |
| CF cold frontend alone, **in-process** (untouched by this change) | 43.2 (`artifacts:build` 29.8, `host-snapshots` 6.9) | 50.7 (`artifacts:build` 36.1, `host-snapshots` 7.4) |

* **The after-VM ran ~20 % slower on CPU-bound work.** CF's `artifacts:build` is code this branch does not touch, and it went 29.8 → 36.1 s.
  * So the cold gains above are understated.
  * Warm's +0.1–0.6 s is that drift, not a regression: warm builds start no pool and write a handful of records in one flush.
* **Cold now, on the quiet VM:** C0 codegen + migrations 14.8 s. The frontend is 22.7 s with 4 threads (step 3b) plus the new demo host snapshot (~7 s cold). The VM's 1-unit grant runs both pools on one thread (step 6), so a real cold build there is nearer the in-process 43 s.
  * **The exit criterion (≤ ~23 s) is not met.**

**Step 3a's "~6,000 store entries lost after publish":** never explained. Its sidequest (task-1793332598-4c8qrj) was dropped. The mechanisms it suspected have since been removed structurally, and the case never recurred:
* builds pin what they compose in a lease;
* the count cap bounds only unreferenced entries;
* an entry younger than a minute is never pruned.

**Next, by measured size:**
1. **The cold frontend.**
   * Babel + React Compiler is ~95 % of artifact CPU. There is still no native compiler: oxc-transform 0.157 and rolldown 1.3.0 have none.
   * Batching measured −27 % CPU per artifact in step 3b.
   * The VM grant of 1 unit decides whether the pools run at all.
2. **The demo host snapshot.** It took 6–15 s in 6 of the 8 real builds since it landed (11-06). Its address covers the worker's whole 298-plugin closure. Find out what the seed really reads.
3. **One file view per build** (v1 §1). `loadRepoSnapshot`'s untracked walk (`git ls-files --others`) is ~0.45 s per load on the host, and a build loads ~5 times. That cost is paid warm and cold.
4. v1 §2 (one module index) and §5 (the guard on the ledger).
