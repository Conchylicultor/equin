# Cold start track: plan for step 1 (measure)

## Context

Two goals, set by the user on 2026-10-23:

1. A new user who installs equin for the first time builds the app instantly. Today they wait through a full cold build.
2. Once equin has been installed once, cold builds never happen again.

This is a new track, separate from "Track: build and push speed" (block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851). That track makes the cold case bounded (memory, width) and less frequent. This one keeps the cold case off the user's critical path. Its last item already hands cold start to this task (task-1792792182-0i4wg5).

The track page goes in the wiki, as an agent page under "Build, check,..." (block-f0d24b10-…), next to the build-speed track. It follows the Track and Performance instructions: goal, exit criteria, status and next step, nested checkboxes, links to sub-pages, and a before/after benchmark. This research doc covers only this session's step.

## What is already known

### First install, measured on a fresh VM on 2026-10-26

`~/.equin-clean-install/si-clean-20261026-192621/01-install_old.log` comes from the data-dir migration rehearsal. The VM was a Tart macOS VM with 6 cores and 12 GB. The log has no per-line timestamps, so only some steps are timed.

| Step | Time |
| --- | --- |
| `install.sh` end to end | 432 s |
| mise tools (bun, go, rust) | 12 s |
| `bun install` (1,114 packages) | 4.8 s |
| menu-bar helper `cargo build --release` | 74 s |
| gateway `go build` | not timed |
| Always-run checks | 2.6 s |
| `tsc repo`: whole-repo type-check, 13,625 files | 197.7 s wall, 218 CPU-s, 5.4 GB, 7 batches |
| Web artifacts: 1,622 built, 0 reused | 50.2 s |
| Codegen, drizzle, restart, health probe | not timed |
| Xcode CLT, Claude Code download | not timed |

`install.sh` passes `--skip-checks`, but the type-check still runs.

The type-check is the largest piece we own. After it come the cargo build and the web artifacts. The user's figure of ~30 min is not explained by this log. Three candidates:

- the user's own host under fleet load (duress valve, grant waits);
- the first *agent worktree* build, which runs every check, not just the always-run ones;
- a slower network or machine.

The measurement has to tell these apart.

### Where cold comes from

The build-pipeline map gives three causes:

1. **A new host.** Every store is empty.
2. **A global input moves.**
   - Type-check: `tscEngineFp` plus global sources (the TypeScript version, compiler options, the `bun.lock` digest, `patches/`, producer sources). About 27 of 948 main commits in 30 days move it.
   - Web artifacts: the builder identity (`BUILDER_VERSION`, the builder's own `core/` digest, toolchain versions, the babel digest, the minify flag) re-addresses every artifact.
   - Vendor sets: the lockfile and esbuild.
3. **The store is lost.** Age-out after 14 days, count caps (the pruning bug fixed in 872d8f39a2), `reclaim: safe` sweeps, the data-dir migration.

### The stores are portable

These stores are host-wide and content-addressed, so an entry is valid on any machine with the same file text and engine:

- the type-check name records, contracts, lint results, run-base shards and walk-base shards;
- the web-artifacts store, the vendor sets and the CSS cache;
- `infra/deps`, keyed on its inputs: the gateway binary, the menu-bar helper and Chromium.

The per-worktree parts are stat shortcuts only. A miss there costs a re-hash, not a rebuild.

### Instrumentation already in place

| Source | What it has |
| --- | --- |
| `worktrees/<ns>/build-profile-<id>.json` | Spans, including `check:*` and `artifacts:*` |
| `check-<id>.log` | The type-check's internal phases and cost lines |
| op log | Waits |
| build log | `N built, M reused` |

No single place gives a phase-by-phase table with CPU-s and peak memory, and nothing records how much of a build's work was cold.

## Direction (hypothesis; the measurement confirms or corrects it)

- **Goal 2: main is the producer.** Every global move lands through a push, and main's auto-build after it is the first build on the new key. It pays the cold cost once per host, on no agent's critical path, and worktrees rebased on main reuse it.
- **What is still missing for goal 2:**
  - **(a) Single-flight per key.** A worktree that builds while main is still producing joins main's run instead of repeating it. The build-speed track lists this as "[Share]".
  - **(b) GC roots.** Pruning never evicts anything referenced by the current main tree, for every store. That generalises 872d8f39a2.
  - **(c) A "cold work" line on every build.** Per store: entries hit and missed, and why. This is how the exit criterion is measured, and a cold build then files a report.
- **Goal 1: ship the content-addressed entries for a main commit, not a prebuilt app.**
  - A seed pack holds the type-check entries, web artifacts, vendor sets and prebuilt deps binaries for that tree.
  - `install.sh` downloads it while the toolchain installs, verifies it, and imports it into the stores. The first build is then all hits.
  - Later updates move only the entries that changed, so cost stays O(changes).
- **How this squares with "no caching to hide a structural issue."** The cold case stays measured and bounded on its own: the build-speed track's target is under 10 min cold. Seeding removes the repeat payment and does not mask it.
- **ADR (plugins shared, runtime not).** These entries are derived from plugin source, not from runtime state, so they fit the ADR. Trust is the open point: a web artifact is executable code and a type-check result is a verdict. A pack must come from the same origin the user clones, pinned to the commit and signed. Never from peers.
- **Decision for the user, at that step and not now:** where packs are published (GitHub Releases on the canonical repo, or another host). Publishing is outward-facing.

## This session: step 1, measure

1. **Create the track page.**
   - An agent page "Track: cold start" under "Build, check,...", tagged "In progress".
   - Contents: global goal, proposed exit criteria (below), status, an overview checklist, and a sub-page "Cold start: measurements".
   - Cross-link both ways, as page links (`[[` mentions), so each shows in the other's backlinks:
     - the new track links to "Track: build and push speed" in its goal: that track bounds the cold case, this one keeps it off the critical path;
     - the build-speed track's cold-start items (its "[Frequency] What stays truly global" and "Cold start is its own track" lines) link to the new page. The build-speed track is an agent page, so this edit is allowed.
2. **Measurement A: first install, phase by phase, on the VM.**
   - Harness: `sidequests/clean-install/run.sh`, with `CLEAN_INSTALL_SH` set to the local `install.sh` and `--repo <bundle of main HEAD>`.
   - Add a step file that times each `==>` section of `install.sh`: CLT, mise, clone, tools, Claude Code, start, deps builds, build.
   - Copy back the guest's `build-profile-*.json`, `check-*.log` and `build-progress.jsonl`.
   - Two runs, to see the variance. Record wall time, CPU-s and peak memory per phase, plus how much of the time is network.
3. **Measurement B: the first agent build after install, cold, on this host (18 cores, 64 GB).**
   - Use an isolated data dir (the data-root env override that earlier benchmarks used for "isolated stores"; confirm its current name in `infra/paths`), a fresh worktree, and every check.
   - Run it once on a quiet host and once under normal fleet load, so the lack of resources is separated from the cold work.
   - Break it down by phase: install, codegen, migrations, type-check (tsc, lint, prepare), the other checks (top 10), web artifacts by stage, server and deploy.
4. **Measurement C: how often cold comes back today (the baseline for goal 2).**
   - Scan the last 30 days of this host's build and check logs:
     - the type-check lines `walk: full` / program-1 file counts;
     - `N built, M reused` for web artifacts;
     - vendor-set misses.
   - Classify each build that did O(repo) work by cause: global hash move (which input), empty or pruned store, builder version, a new worktree that started before main had built.
   - Count how many of them main had already paid for, which means a shared store would have avoided them.
5. **Write the results.**
   - Tables on the measurements sub-page, and a status of 3–5 lines on the track page.
   - Set the step 2 direction from the numbers: what share is type-check, what share web artifacts, what share deps builds and network; and whether goal 2's misses are mostly "main had it", "prune" or "author of a global change".
   - File the next task with `add_task`, giving the track page id. One task, not a chain.

No product code changes in this step. Two exceptions, if they are needed to measure: the VM step file, and a throwaway script that parses the logs. A permanent "cold work" line is step 2's work.

## Proposed exit criteria (to confirm with the user on the track page)

- **Goal 1.** On a fresh 6-core / 12 GB VM, the build step of `install.sh` finishes in under 30 s. It checks 0 type-check files and builds 0 web artifacts or deps binaries. What remains of the install is downloads.
- **Goal 2.** Over 30 days on the user's host, no agent build or push does O(repo) work for a key main had already built. The only cold payer is the build that introduces a new global key: once per host, and on main when it is not the author's own worktree.

## Verification

- Every number on the measurements sub-page cites its source: the VM run directory, the build id or profile path, the log scan script.
- Every number can be reproduced by re-running the same command.
- The VM breakdown's phases sum to within 5 % of the step's total wall time.
- Measurement B's profile spans cover at least 95 % of the build's wall time. Any gap is named.
- `read_page` on the new track page shows the required structure, and the build-speed track links to it.

## Result (2026-10-28)

Done as planned, with two deviations:
- The cold run on the host (measurement B) ran only under fleet load. No quiet window was available.
- The build-phase share table covers 30 days of build profiles, but the type-check cold-run classification covers 5.3 days. The type-check's log format only dates from 2026-10-22.

The numbers and the findings are on the wiki: "Track: cold start" (block-b7589f3e-29df-4462-bc17-0d5a8b2b9910) and its sub-page "Cold start: measurements" (block-051203b0-d315-4da6-8d26-955d55461de9). The harness is `sidequests/clean-install/steps-cold-start.sh`.

Next step: task-1793147895-hm52wo. Side finding: task-1793147863-rh7ai1 (a data root under a symlinked directory breaks the browser-host build).
