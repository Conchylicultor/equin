# Agent launch → first reply, and `./equin build`: where the time goes

Benchmark + proposal only (task-1794941572-a4gu3c, onboarding audit item D5). No product code changed.
Machine: the user's Mac, 2026-11-17. Method: the perf page — split, then recurse into the biggest part.

## Sources (all existing; nothing was added)

| Data | Where | Window / n |
|---|---|---|
| Agent process events (`started`, `ready`, first `sdk/assistant`) | `~/.equin/state/sdk-agents/singularity/<conv>/events.jsonl` | 600 launches with a retained dir (of 2,007 in 20 days) |
| Conversation creation | DB `conversations.created_at` (main) | 20 days |
| Workspace prepare child | DB `supervised_job_runs` (`worktree.prepare`) | 1,428 launches since 2026-10-28 |
| Checkout kind and per-launch log | `~/.equin/worktrees/singularity/logs/worktree-prepare.jsonl` | 1,460 checkouts since 2026-10-28 |
| Spawn / fork jobs | DB `job_runs` (ring of 20) | last 20 launches |
| Build phases | `~/.equin/build-progress.jsonl{,.1,.2}` | 151 successful builds, about 7 h on 11-17 |
| Check pass inside builds | `~/.equin/check-progress.jsonl{,.1,.2}` | same window |
| Direct runs | two `./equin build` runs of this worktree, plus `claude -p` init runs in an empty dir and in the repo | — |

"First reply" is the first complete `assistant` message the agent writes. Streamed partial tokens are pushed to the browser but never persisted, so the first token itself is slightly earlier than this. That bias is under one block's generation time.

## 1. Agent launch timeline (new attempt in a worktree)

**Warm** means a ready spare checkout was claimed. **Cold** means there was no spare and the checkout was fresh. The 306 launches below are those with both an agent dir and a checkout-log line.

| Phase | Warm p50 | Warm p90 | Cold p50 | Cold p90 |
|---|---|---|---|---|
| Request → prepare child starts (waiting for a workspace slot) | 0.1 | 0.4 | 0.1 | 0.4 |
| Prepare child: process boot | 2.4 | 8.6 | 2.4 | 8.6 |
| Prepare child: checkout + install + index refresh | 5.7 | 36.6 | 29–51 † | 120–240 † |
| Prepare end → agent process started | 0.8 | 1.6 | 0.8 | 1.6 |
| **Created → agent process started (sum of the above)** | **8.3** | **30.1** | **32.7** | **113.6** |
| DB fork (runs in parallel, off the path) | 9–14 | — | 9–14 | — |
| Build before the agent starts | none | | none | |
| Agent started → Claude CLI ready (initialize) | 3.7 | 4.3 | 3.8 | 5.0 |
| MCP connect (lazy, in parallel; `system:init` lands after ready) | 0.1 | 0.2 | 0.1 | 0.2 |
| CLI ready → first assistant message | 3.8 | 6.2 | 4.3 | 5.9 |
| **Total: launch → first reply** | **16.5** | **40.4** | **40.8** | **133.5** |

† The cold row depends on how the checkout was made:

| How the checkout was made | n | p50 (s) | p90 (s) |
|---|---|---|---|
| Recycled tree | 123 | 28.8 | 129.7 |
| Cold install | 115 | 50.8 | 119.8 |
| No detail logged | 107 | 50.9 | 243.3 |
| Dependency store cloned | 12 | 64.4 | 241.4 |

Other measurements:

- **Model share of "ready → first message".** p50 is 3.9 s on Opus and 2.1 s on Sonnet. That part is model latency, and we do not control it.
- **Spare misses.** 25% of launches miss the spare (365 of 1,445).
- **Admission wait.** The worktree-prepare pool of 4 slots is not a bottleneck: p50 and p90 are 0 s, with a 292 s maximum once.

### Recursion

1. **The prepare child is the biggest part** (p50 8.7 s, p90 51.6 s over n=308). The hand-off around it is fast: 0.1 s before and 0.8 s after.
   - **Spare misses.** 81% of fresh checkouts started within 120 s of the previous checkout, with a median gap of 29 s. Spare hits have a median gap of 419 s. So misses are launch bursts: one task unblocks two or three, or a chain is armed. The pool keeps one spare (`SPARE_TARGET = 1`), so the second launch of a burst always goes cold, and the refill finishes after the burst.
   - **Child boot (2.4 s p50, 8.6 s p90).** `supervised-exec` boots a server plugin graph (`bootPluginGraph`) before running a few git commands and `./equin install`.
   - **Spare claim (5.7 s p50).** It switches to the attempt branch, which writes the diff since the spare's commit (the spare can be up to a day old). It then runs `./equin install` (measured 0.5–2.4 s even as a no-op) and the index refresh (about 1 s, documented). The p90 of 37 s is contention: bursts run their installs and checkouts at the same time (3 mutate slots, CPU).
   - **Measurement gap.** The prepare child records no per-step durations, only a start line and a result line. So the cold path (29–51 s p50) cannot be split further from existing data. Its known pieces are the recycled-tree reset (1.1 s, documented), dependency adoption or cold install (about 1,100 package clones), the index refresh, and burst contention. I did not add temporary instrumentation: the fix list starts with adding the spans.
2. **Claude CLI initialize (3.7 s).** `claude -p` measured from process start to `system:init` took 4.4–6.2 s in an empty temp dir and 4.4–4.9 s in the repo. The SessionStart hook costs 0.12–0.21 s and the binary starts in 0.02 s warm. So the cost is Claude Code's own startup, not our settings, hooks or repo. Only overlapping it can help (fix 6).
3. **First reply (2.6–4.3 s).** This is model time.

## 2. `./equin build` timeline

Successful builds on 11-17. The critical path is split at the end of the frontend (`viteBuild` leaves) and at publish (`artifacts:retain` enters). The check pass runs alongside codegen and the frontend, and publish waits for it.

| Phase | Main p50 | Main p90 | Worktree p50 | Worktree p90 |
|---|---|---|---|---|
| Preflight + codegen + frontend (to `viteBuild` end) | 15.9 | 36.6 | 18.7 | 57.3 |
| ↳ `viteBuild` (web artifacts), first build of a worktree | — | — | 11.4 | 20.6 |
| ↳ `viteBuild`, later builds | 5.7 | 16.0 | 6.6 | 14.6 |
| ↳ `artifacts:link` (first / later) | 0.2 | 7.1 | 5.1 / 3.0 | 6.8 / 7.4 |
| ↳ codegen steps (plugin docs, format, slot guard, package names…) | ~3 | ~8 | ~5 | ~15 |
| **Idle wait for the check pass after the frontend is done** | **1.0** | **4.7** | **14.8** | **40.5** |
| Deploy (adopt / restart backend + health probe) | 2.8 | 7.0 | 4.5 | 9.7 |
| **Total** | **20.8** | **44.9** | **43.1** | **108.8** |
| Total, first build of a worktree (n=28) | | | 55.9 | 181.7 |
| Total, later builds (n=58) | | | 39.9 | 88.5 |

The two builds I ran directly:

| Build | Total | Check pass |
|---|---|---|
| Cold: a fresh worktree whose tree equals main | 18.6 s | 8.2 s |
| Warm: the same build again, nothing changed | 7.0 s | 1.4 s |

So **a build with no changes is fast. The cost is the build after an edit**, which is what agents and new users actually run.

### Recursion

1. **The check pass in worktree builds** takes p50 20.3 s and p90 65.3 s. Only 6% of check results are reused, against 86% on main. Its time is the shared work every check waits on (`sharedWall`, per pass):

   | Shared work | Seconds |
   |---|---|
   | `plugin records` | 3–47 |
   | `slot naming` | 10–36 |
   | `registry codegen context` | 5–18 |
   | `enriched plugin tree` | 1–3 |

   This is why a dozen unrelated checks each report the same ~13 s (`config-v2:registrations-paired`, `active-data:*-chip-*`, `page-editor:*`, `companions-visible`, `config-origins-in-sync`, `plugins-registry-in-sync`…). They are all waiting on one pass.
   - **`slot naming`** in a check run is the **live** declaration pass (`slot-declaration-guard.ts`). Checks that hold live slot objects import every plugin barrel, and `importBarrel` admits **one import at a time, process-wide**. The build's generators no longer do this: they read the **evaluated barrel records** (`evaluated-barrels.ts`, `recordSlotNaming`). So a build pays for barrel evaluation twice, once by records for codegen and once live and serialized for the checks.
   - **`plugin records`** are content-addressed by module Merkle key. An edit to a widely imported module re-keys every record above it, so a common edit recomputes much of the tree (up to 47 s).
   - **`type-check`'s first run in a worktree** takes 12–21 s, then about 2 s (cold `tsbuildinfo`). One outlier took 181 s, which looks like host pressure.
2. **`artifacts:link` (3–5 s p50).** The link record is keyed on *every* input address. Any changed artifact re-links the whole fleet, regrouping every route chunk with one rolldown pass. That makes it O(fleet) on any web edit — the global-invalidation pattern the perf page warns about.
3. **`adoptDeploy` on a first build (5.3 s p50).** This is the backend restart and boot. I did not recurse into it (it is the server's own boot, already covered by `benchmark_boot` / cold-start tooling).

## 3. Proposed fixes, ranked by gain ÷ effort

| # | Cost it removes | Root cause | Structural fix | Expected gain | Size |
|---|---|---|---|---|---|
| 1 | Cold checkouts on 25% of launches | One spare (`SPARE_TARGET = 1`) against launch bursts of 2–4. 81% of misses come within 120 s of the previous checkout. | Size the pool to burst demand, not to 1. Derive the target from the launches about to happen (armed/unblocked tasks in the queue, recent burst size), and refill spares in parallel. Spares are cheap now that trees and dependency stores are recycled (about 170 MB each). This is prework moved off the path, not a cache over a slow path: the cold path stays and fix 4 targets it. | About 25–35 s p50 and 70–90 s p90 on the launches that miss today. That is about 7–9 s on the mean launch, and the launch p90 falls from about 40–130 s to about 40 s. | S |
| 2 | 15 s p50 / 40 s p90 idle wait on the check pass in every edited worktree build | Checks that read live slots re-import every barrel through a serialized `importBarrel` (`slot naming`, live pass). The build already has the same answer from evaluated records. | Move those checks onto the evaluated-barrel records and their slot naming, as codegen already did. Then delete the live declaration pass from the check run: one evaluation per pass, never two. | About 10–15 s p50 and 25–30 s p90 per worktree build after an edit. | M–L |
| 3 | 2.4 s p50 / 8.6 s p90 on every launch | The prepare child boots a server plugin graph to run git + `./equin install`. | Give `worktree.prepare` a lean entry with no plugin-graph boot (its work is git, fs and a child install). | About 2 s p50 and 7 s p90 per launch. | M |
| 4 | Cold checkout 29–51 s p50, 120–240 s p90 | Not attributable from existing data: the prepare child logs only start and result. | First add per-step spans to the prepare child (claim/add, switch, dependency adopt/clone, install, index refresh) on its existing log channel. Then fix the largest step. Suspected: dependency install and clone under burst contention. | Enabler. With fix 1, this only matters for the rare remaining miss. | S (spans) + ? |
| 5 | `artifacts:link` 3–5 s p50 on every web edit | The link key covers every address, so any change re-links the whole fleet. | Make the link incremental: key each route group on its own members' addresses and re-bundle only the groups whose members changed. | About 3–4 s per edited build. | L |
| 6 | Claude CLI initialize, 3.7 s on every launch | Claude Code's own startup. The same 4.4 s happens in an empty dir, so it is not our repo, settings or hooks. | Overlap it: start the agent process as soon as the checkout dir exists (after the claim's move), running in parallel with install and index refresh, and hold the first prompt until prepare ends. Risk: guard hooks need `node_modules`, so the first tool call must wait for install. | About 1.5–3 s per launch. | M |
| 7 | No launch timeline at all | Each phase leaves timestamps in a different store (DB rows, two jsonl channels, agent `events.jsonl`), and none of them persists the first token. | One per-launch phase record (created, prepare boot/steps/end, agent started, CLI ready, first streamed token), written by the spawn job. Users and the perf supervisor can then see a regression without a join like this one. | 0 s directly. It makes every fix above measurable. | S |

Not proposed:

- **A deadline on prepare, or a retry.** Neither explains the cost.
- **A shorter `PREPARE_WAIT_MS`.** The hand-off is already 0.8 s p50, so the 30 s wake is not on the path.
- **DB fork.** It runs in parallel and finishes before most agents reach their first tool call.

## Summary

- **Launch.** A new user's agent replies in about 16 s (p50) when a spare checkout is ready, and about 41 s (p50, up to 2+ min p90) when it is not. That happens for 1 launch in 4, almost always the second launch of a burst.
- **Where launch time goes.** The workspace prepare child is the largest part. Claude Code's own startup (3.7 s) and the model's first message (2–4 s) are a fixed floor of about 7 s.
- **Builds.** Edited builds in a worktree take 43 s p50 / 109 s p90. A third of that is idle time waiting on a check pass that re-imports every plugin barrel serially, instead of reading the records the build already computed.
- **Best value.** Fix 1 (S) for launches, and fix 2 (M–L) for builds.
