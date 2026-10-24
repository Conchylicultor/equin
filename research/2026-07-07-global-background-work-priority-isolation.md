# Priority isolation of heavy background work (launches, builds, cleanup) vs the interactive main app

**Date:** 2026-07-07 · **Category:** global (plugins + cli + gateway) · **Status:** planned

## Context

Heavy background work runs at the same CPU/IO priority as the interactive main backend and starves it. Even ONE agent launch degrades main: the launch pipeline (DB fork ~18.5s avg ×100 runs, worktree checkout, frontend/server build, server boot) and maintenance jobs (`worktree-cleanup.reap-stale` ~108s avg ×210 runs) saturate the host — a single `./equin build` alone fans across all 18 cores (loadAvg1 hit 14–21 during single launches). During these windows main's interactive paths stall: `flushNotifies` 14.5s avg over 4,716 slow hits (max 990s), boot-snapshot 14s avg (max 137s), trivial SELECTs take seconds. The `slow_ops` data is victim-shaped: waits attributed to `read-admit` / `loader-acquire` / `db-acquire` gates with Postgres nearly idle (1–6 active backends) — **host starvation, not slow queries** (re-validated live 2026-07-07 via `query_db`; victim samples fresh as of 2026-07-06).

**Why concurrency gates can't fix this:** every existing mitigation (`heavy-read`, `worktree-mutate`, CLI build slots) bounds *how many* heavy ops run at once. But one build legitimately uses all cores — the success criterion "ONE launch causes no degradation" is unreachable on the rate axis. The missing mechanism is **OS scheduling priority**: background work must yield to main. Zero `nice`/`taskpolicy`/QoS usage exists anywhere in the repo today.

### Key structural facts (verified)

- Launch = `createConversation` (`plugins/conversations/server/internal/lifecycle.ts:152`) enqueues two parallel graphile jobs: `database.fork` + `conversations.spawn`. The graphile worker runs **inside main's own bun process** (`JOB_CONCURRENCY=4`, `plugins/infra/plugins/jobs/server/internal/constants.ts:14`) — so `pg_dump|pg_restore` and `git worktree add` are children of main, at main's priority.
- The DB fork (`plugins/database/plugins/admin/server/internal/fork.ts:51-78`) is the **only heavy launch step with zero admission control** — `JOB_CONCURRENCY=4` alone permits 4 concurrent dump|restore pairs.
- The agent's tmux session command is forked by the **shared tmux server**, so demotion must be embedded in the session command string, not the spawning client (`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:730-747`).
- The interactive HTTP path holds no flock gate (checkout/fork are deferred to jobs) — load-bearing for the priority-inversion analysis below.

### Host experiments (2026-07-07, this box: arm64, 6 P-cores + 12 E-cores)

Fixed-CPU foreground probe, elapsed:

| Condition | ms |
|---|---|
| idle box | 8,238 |
| vs 20 default-priority spinners | 12,986 |
| vs 20 `taskpolicy -c utility` spinners | 13,446 — **utility gives ZERO protection** |
| vs 20 `taskpolicy -b` (darwinbg) spinners | **5,876 — full protection** (bg pinned to E-cores) |

- `taskpolicy -b` is inherited by children (verified). `-B -p <pid>` un-demotes a live process.
- darwinbg IO throttle: no measurable penalty on an uncontended disk (400MB write ≈0.75–0.8s under default / `-b` / `-b -t 0`) — it only bites under IO contention, which is exactly when bg should yield.
- Caveat: the sandboxed Claude Bash tool cannot run `taskpolicy -x/-X/-p` (seatbelt blocks `setiopolicy_np`); the spawn form `taskpolicy -b -- <cmd>` works sandboxed. `ps` PRI is useless for verifying QoS (everything defaults to PRI 20) — verify by behavior.

## Design: two complementary layers

**Layer 1 — demote background work to darwinbg (`taskpolicy -b`).** The primary fix. Background subtrees run on the 12 E-cores; the 6 P-cores stay free for main. Not work-conserving (bg stays on E-cores even when the box is idle) — accepted: success criteria explicitly allow longer launch/cleanup wall-clock, and 12 E-cores is ample compute.

**Layer 2 — a named `db-fork` host admission gate.** Closes the one ungated hole and bounds the residual Layer 1 can't reach: the **pg server-side** restore work runs in postgres backends (children of the postmaster, not our spawns — un-demotable). Gate waits are charged as a named profiler wait layer (`db-fork-acquire`), mirroring `worktree-mutate-acquire`, satisfying the "no anonymous slowness" criterion. Note the repo's slow-ops stance (`plugins/debug/plugins/slow-ops/CLAUDE.md`): victims still file slow-ops but the `waits` breakdown names the gate — attribution, not suppression.

### Decision points taken (revisit if wrong)

1. **Whole-agent-session demotion** (not just known-heavy subprocesses): the tmux session command is the one choke point covering everything an agent ever runs (claude CLI, builds, tests, rg). Escape hatch: `SINGULARITY_NO_SPAWN_PRIORITY=1`.
2. **Gateway demotes non-main backends during boot, then un-demotes on ready** (`-b` at spawn, `-B -p <pid>` after `/api/health/ready`): boot burst on E-cores, steady-state worktree-app browsing back on all cores. Sequenced last (needs gateway rebuild + user-run `./equin start`).

## Implementation tasks (ordered)

### Task 1 — new plugin `packages/spawn-priority` (Layer-1 helper)

New: `plugins/packages/plugins/spawn-priority/server/{index.ts, internal/spawn-priority.ts}` + `CLAUDE.md`. Mirror `host-semaphore`'s shape (server-only barrel, inert default export).

```ts
const TASKPOLICY = "/usr/sbin/taskpolicy";
// darwinbg: E-core pinning + bg IO throttle. THE single tunable flag point.
// If an IO-heavy spawn (pg_dump/pg_restore, 77MB checkout) crawls under the bg IO
// throttle, relax to ["-b","-t","0"] (keeps E-core CPU, lifts the disk throttle;
// tested to run on this host) and re-measure. Do NOT use "-c utility": zero CPU
// protection (measured 2026-07-07).
const DEMOTE_FLAGS = ["-b"];
function prefixTokens(): string[] {
  if (process.env.SINGULARITY_NO_SPAWN_PRIORITY === "1") return [];
  if (process.platform === "darwin" && existsSync(TASKPOLICY)) return [TASKPOLICY, ...DEMOTE_FLAGS, "--"];
  return ["nice", "-n", "10"]; // non-darwin fallback (CPU only); fail-open
}
export function backgroundArgv(argv: string[]): string[] { return [...prefixTokens(), ...argv]; }
export function backgroundPrefix(): string { const t = prefixTokens(); return t.length ? t.join(" ") + " " : ""; }
```

### Task 2 — Layer 2: `db-fork` gate

New: `plugins/database/plugins/admin/server/internal/fork-gate.ts`, mirroring `plugins/infra/plugins/worktree/server/internal/mutate-gate.ts` byte-for-byte plus a gauge (held-counter pattern from `plugins/infra/plugins/host-read-pool/server/internal/pool.ts`):

```ts
const gate = createHostSemaphore({ name: "db-fork", size: forkSize() }); // default 2, env SINGULARITY_DB_FORK_CONCURRENCY
let held = 0;
registerGateGauge("db-fork-acquire", () => ({ active: held, queued: gate.depth(), max: forkSize() }));
export function withDbForkSlot<T>(fn: () => Promise<T>): Promise<T> {
  return gate.run(async () => { held++; try { return await fn(); } finally { held--; } },
    (waitMs) => chargeWait("db-fork-acquire", waitMs));
}
```

In `fork.ts`, wrap **only** the `pg_dump | pg_restore` block (spawns + `Promise.all` + failure handling) — the cheap admin-pool ops (exists/drop/CREATE/graphile-DROP/RENAME) stay outside the slot. Size 2 rationale: demoted clients cost ~nothing; the un-demotable server-side restore is ≤2 pg backends (~2 cores) while single/double launches still flow. `withDbForkSlot` stays internal (no barrel export). The fork job runs under a `job database.fork` entry span, so `chargeWait` attributes correctly (context-less fallback also exists in the recorder).

New edges: `database/admin → {packages/host-semaphore, infra/runtime-profiler}` — DAG-safe (host-read-pool already holds this pair; neither target imports database/admin).

### Task 3 — apply demotion at each spawn site

- **3a — agent tmux session** (`tmux-runtime.ts` ~L729): `const claudeCmd = backgroundPrefix() + cmdParts.join(" ")`. Must be in the command *string* (shared tmux server forks the pane). Fixed literal prefix, shell-safe. Everything the agent runs inherits darwinbg.
- **3b — fork subprocesses** (`fork.ts`): `Bun.spawn(backgroundArgv(["pg_dump", …]))` and `Bun.spawn(backgroundArgv(["pg_restore", "-d", temp]))`. Optional hardening: `PGOPTIONS=-c max_parallel_maintenance_workers=0` in `subprocessEnv` to curb server-side parallel index builds.
- **3c — worktree git ops** (`plugins/infra/plugins/worktree/server/internal/worktree.ts`): wrap the `git worktree add` (setupWorktree ~L71) and `git worktree remove` (removeWorktree ~L106) spawns with `backgroundArgv`. Both are always background (checkout runs in the deferred `conversations.spawn` job; removal is cleanup/reap). This also covers `worktree-cleanup.reap-stale`, whose reaps go through `removeWorktree`.
- **3d — agent builds** (`plugins/framework/plugins/cli/bin/commands/build.ts`): when `slotKind === "build"` (branch ≠ main), wrap the tsc worker spawns (~L1049) and `bun run build` vite spawn (~L1070) with `backgroundArgv`. Belt-and-braces vs 3a (a user-run `./equin build` in an agent worktree from their own terminal is covered too; nested taskpolicy is harmless). Main-branch builds (`exempt`) are NOT demoted — the user is waiting on them. `execBuffered(cmd, …)` (build.ts:249) takes argv arrays, and cli/bin already imports `@plugins/*` barrels (verified), so `execBuffered(backgroundArgv(cmd), …)` just works.
- **3e — gateway backend boot** (`gateway/worktree.go` `startBackend` ~L836, **sequence last**): on darwin, for every worktree except `singularity` and `central`, prefix argv with `/usr/sbin/taskpolicy -b --` (taskpolicy execs in place, so `cmd.Process.Pid` is the bun pid). When the gateway confirms `/api/health/ready` (it already polls this before hot-swap), run `taskpolicy -B -p <pid>` (best-effort; the gateway daemon is unsandboxed so `-p` works). Boot burst on E-cores; steady-state serving on all cores. ⚠ Requires gateway rebuild + **user-run `./equin start`** — deploy 1–4 + 3a–3d first via `./equin build`, treat 3e as a fast-follow.

### Task 4 — give `worktree-mutate` a gauge (minor consistency fix)

`mutate-gate.ts` charges `worktree-mutate-acquire` but registers no gate gauge (unlike host-read-pool). Add the held-counter + `registerGateGauge("worktree-mutate-acquire", …)` so it shows up in gauges/flight-recorder alongside `db-fork-acquire`.

## Files

- **New:** `plugins/packages/plugins/spawn-priority/server/{index.ts, internal/spawn-priority.ts}`, `plugins/packages/plugins/spawn-priority/CLAUDE.md`, `plugins/database/plugins/admin/server/internal/fork-gate.ts`
- **Edit:** `plugins/database/plugins/admin/server/internal/fork.ts`, `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`, `plugins/infra/plugins/worktree/server/internal/worktree.ts`, `plugins/infra/plugins/worktree/server/internal/mutate-gate.ts`, `plugins/framework/plugins/cli/bin/commands/build.ts`, `gateway/worktree.go` (3e, last)
- Run `./equin build` after Tasks 1–4 (registry + plugins-doc regeneration).

## Knobs (env vars — host-level, restart-fine; matches host-read-pool/build-slot precedent)

- `SINGULARITY_DB_FORK_CONCURRENCY` — fork gate size (default 2)
- `SINGULARITY_NO_SPAWN_PRIORITY=1` — disable all demotion (A/B harness + escape hatch)

## Risks / inversion analysis

1. **Demoted holder of a flock slot starved while holding it** — no inversion vs interactive main: every gate (`worktree-mutate`, `db-fork`, build slots) has only *background* waiters; main's interactive HTTP path holds none (fork/checkout deferred to jobs). A starved holder delays only other background work — allowed by the success criteria.
2. **Demoted `pg_dump` holds a repeatable-read snapshot on main's DB longer** — conflicts only with DDL (migrations, boot-time); mildly lags VACUUM xmin. Bounded by the size-2 gate. Acceptable.
3. **Un-demotable server-side restore** — bounded by Layer 2 + optional PGOPTIONS.
4. **darwinbg IO throttle stretches IO-heavy spawn wall-clock under disk contention** → longer gate holds. Bounded (only bg waiters queue). Escape hatch: `DEMOTE_FLAGS = ["-b","-t","0"]`. Watch `db-fork-acquire` / `worktree-mutate-acquire` hold times after deploy.
5. **taskpolicy missing / non-darwin** — helper falls back to `nice -n 10`, then no-op; spawns never break.
6. **Nested demotion** (3a session ∘ 3d build) — harmless re-application.
7. **Demoted boot vs the gateway readiness timeout** (hit in production 2026-07-07, hours after 3e landed): an E-core-pinned boot under host load needs >15s just to bind its socket, so the gateway's readiness deadline SIGKILLed healthy demoted boots four times in a row — a self-amplifying spawn-kill loop (each kill discards near-complete work and re-adds load) that turned one cold page load into a ~2-minute outage. **Fixed:** `waitReady` now escalates before killing — on base-deadline expiry with the backend either answering HTTP (503 = alive, mid-boot) or spawn-demoted, the gateway lifts the demotion (`taskpolicy -B`) and extends the wait by `-ready-timeout-max`; only a silent never-demoted backend is declared wedged at base (crashes still short-circuit via exitCh). See `gateway/worktree.go` (`waitReady`, `awaitBackendReady`).

## What NOT to do

- Don't demote main's bun backend (it *is* the interactive server) — only its individual heavy spawns.
- Don't use `-c utility` or `-c background` — measured useless / untested semantics; `-b` is the verified mechanism.
- Don't demote main-branch (`exempt`) builds or the `singularity`/`central` backends.
- Don't put the cheap admin queries inside the db-fork slot.
- Don't lower `JOB_CONCURRENCY` (bounds cheap jobs too — wrong axis).
- Don't run `./equin start` for 3e without the user.
- Don't infer QoS from `ps` PRI (everything reads 20).

## Verification

Deploy Tasks 1–4 via `./equin build`, then:

1. **Mechanism sanity** — repeat the probe experiment (fixed-CPU probe vs N `taskpolicy -b` spinners → probe stays ~idle-fast). Spawn-form taskpolicy works in sandboxed Bash; anything using `-p`/`-x` must run via tmux or `dangerouslyDisableSandbox`.
2. **Before/after harness** — `benchmark_boot` (MCP, worktree `singularity`) baseline on an idle box; then launch a REAL throwaway agent (create conversation on a scratch task) and run `benchmark_boot` on main *during* the launch window; compare `bootSnapshotTotalMs`, `eventLoopMaxMs`, per-loader `waits`. Repeat with 3 concurrent launches. (`loadConcurrency` only saturates the heavy-read flock gate, not host CPU — the real launch alongside it is the true harness.)
3. **Health pane** — `~/.singularity/worktrees/singularity/logs/health.jsonl`: `eventLoopMaxMs` stays low on main through the launch window.
4. **Victim slow-ops stop advancing** — via `query_db` on `singularity`: snapshot `MAX(last_seen_at)` for `operation LIKE 'deliver:%'`, `flushNotifies`, `[acquire]` before; confirm not advancing across the launch window after the fix.
5. **Attribution** — `get_runtime_profile` during a 2-concurrent-launch window shows `db-fork-acquire` (and `worktree-mutate-acquire`) as named wait layers on the fork/spawn job spans — no anonymous queueing.
6. **A/B control** — re-run (2) with `SINGULARITY_NO_SPAWN_PRIORITY=1` to isolate the demotion effect.
7. After 3e lands (gateway rebuild + user-run `./equin start`): re-run (2)-(4); also confirm a ready backend is back at default (browse the worktree app; `taskpolicy -B` already applied).

## Prior work

- `research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md` — heavy-read gate (reads only)
- `research/perfs/2026-07-02-worktree-mutation-host-gate-DESIGN.md` — worktree-mutate gate (implemented, unvalidated; this task's verification doubles as its validation)
- `research/2026-06-04-cli-host-build-concurrency-limit.md` — CLI build slots
- `research/perfs/2026-07-02-launch-background-worktree-setup-DESIGN.md` — launch work moved off the HTTP path
- `research/perfs/2026-07-02-worktree-checkout-clonefile-DESIGN.md` — future origin fix for checkout cost (out of scope here; this plan is the priority/containment layer that makes launches invisible regardless)
