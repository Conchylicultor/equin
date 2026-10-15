# Push lock: the whole critical section runs under the interactive grant, so normalize stops waiting for E-cores

Status: built 2026-10-15 (att-1792076013-4od6sx). Benchmark (interleaved, 3 runs each, load 12–32): forced normalize 74.8 / 150.1 / 44.7 s in the background → 18.2 / 11.7 / 12.0 s under the interactive grant; main `/api/search` latency during the runs p50 36 → 19 ms, p95 46 → 24 ms (no-run baseline 39 / 46 ms), so no degradation. Note: the benchmark called `normalizeGeneratedArtifacts` on a dirty tree, which amends HEAD with everything dirty (`git add -A`), not only what it regenerated; push only calls it on a clean tree. Wiki: Mental model → Performances → Build, check,… → "Track: build and push speed" (item "[Lock] Incremental codegen (normalize) inside the lock").

## Context

The track's premise was that normalize (forced codegen + migration generation after the rebase) is 113–282 s of mostly redundant WORK inside the push lock, to be fixed by keying each generator on its inputs. Re-measured before building that (op log, 21 pushes since Phase 1 landed, 2026-10-15T02:05Z → 14:53Z):

| step | median | p90 |
|---|---|---|
| normalize | 109 s | 255 s |
| checks | 187 s | 1396 s |
| lock hold | 466 s | 1557 s |

Normalize is 20 % of all hold time. Its work, measured on this host under load (load avg 13–26), the same tree, the only variable being the process's darwinbg tier:

| | background (what push does today) | foreground |
|---|---|---|
| `regen-generated` pipeline (in-process, all steps) | 71.5 s wall (16 s user) · 25 s at load 13 | **7.8 s** wall (4.4 s user) |
| `regen-migrations` (drizzle-kit generate, subprocess) | 29.2 s · 33.0 s | **5.1 s** · 5.0 s |

So normalize is ~13 s of work; the other 100–250 s is waiting for the 12 E-cores the whole agent fleet runs on. Rate × cost: the rate (one forced normalize per push) and the cost (~13 s) are both modest; the wall is a priority bug.

Why it happens: an agent session is darwinbg as a whole, and Phase 1 (8f89aee0c4) made **`withHostGrant({ lane: "interactive" })`** promote its holder to the foreground. But push takes that grant only around its check subprocess (`push/cli/run.ts` `runRebasedChecks`). Everything else in the critical section — rebase, `ensureDeps`, normalize, the merge and pushes — runs unadmitted at the inherited background tier, while every queued push waits on it.

## Design

**The push lock's critical section is one interactive grant.** Acquire `withHostGrant({ lane: "interactive", max: cpuBudget().B, hooks: profiler.grantHooks() })` immediately inside `withPushLock` (both arms: worktree and `--from-main`), and pass that grant down to `runRebasedChecks` → `runCheckSubprocess({ grant })`, which already takes one. No new concept: the lane is already the priority (Phase 1's rule), this only stops the push from holding the lock outside its lane. Consequences:

- normalize, rebase, install and ff/push run in the foreground and are admitted CPU like the checks are (they spend CPU while the box queues on them; today they spend it unaccounted);
- the `host-grant` wait moves from inside `checks` to right after `granted`, as its own op-log wait — the profile then shows it instead of folding it into `checks`;
- `runRebasedChecks` no longer acquires: it takes `grant: Grant`, so "checks under an interactive grant" stays true by construction (it cannot be called without one).

`normalize-inherited` (step 1b, before the lock, marker-gated, normally a no-op) stays outside: it holds nothing anyone waits on.

## Discarded: incremental (input-hashed) generators inside the lock

The track proposed keying each generator on a hash of its inputs (`@inputs-hash`). Discarded for now:

- **Gate 4 (cost vs saving):** after the fix the whole forced normalize is ~13 s of a ~5–8 min hold; the next lever (type-check, checks p90 1396 s) is an order of magnitude larger.
- **It would be a global fingerprint.** The expensive generators (plugin docs 5.7 s, slot declarations 6.9 s in the background run) import every barrel; their input set is effectively the whole plugin tree, so any branch × any main movement invalidates them — O(N) on almost every push, which the Performance instructions rule out. Making them truly O(changes) means per-plugin doc generation, a redesign not worth 10 s today.
- Noted, not done: inside the lock each generator runs TWICE — normalize writes it, then its `*-in-sync` check re-renders it (`migrations-in-sync` re-runs drizzle-kit). A few CPU-s of duplicate work in the parallel check pass; recorded on the wiki as a follow-up.

## Critical files

- `plugins/framework/plugins/cli/plugins/push/cli/run.ts` — `withPushLock` call sites (worktree + `--from-main`), `runRebasedChecks`
- `plugins/framework/plugins/cli/plugins/push/CLAUDE.md` — critical-section step list (6 → "the whole section holds one interactive grant")
- `plugins/infra/plugins/host/plugins/host-admission/CLAUDE.md` — "The push mutex" paragraph ("it takes an interactive CPU grant separately for its nested checks")

## Verification

1. Benchmark (before/after on the wiki): the forced normalize (`normalizeGeneratedArtifacts(root, { force: true })` minus the amend) 3× in the background vs 3× under `withHostGrant({ lane: "interactive" })`, interleaved, same tree, load recorded.
2. `./singularity build` (checks incl. type-check) green.
3. After landing: the op log's `normalize` step on the next pushes (expect median ≲ 20 s vs 109 s) and the `host-grant` wait now visible before `rebase`.
