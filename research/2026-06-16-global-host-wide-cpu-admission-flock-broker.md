# Host-wide CPU admission for heavy git/fs reads (flock slot-broker)

## Context

The prior live-state cascade work (`research/2026-06-15-global-live-state-cascade-contention.md`)
tamed the **DB-side** herd: `debounceMs` on `conversationsLiveResource`/`refHeadResource`,
the dead queue→conversations edge removed, a per-worktree loader semaphore at `wrapLoad`,
and per-route endpoint concurrency. Pool-wait max fell ~10.8s → ~1.2s.

But intermittent multi-second slow ops persist (observed 21:43–21:50). They are no longer
DB-bound — they are **CPU/IO-bound git-subprocess and filesystem work**: `edited-files`
(~13.7s), `GET /api/review/plugin-changes` (~13.6s), `GET /api/code/:worktree/push` (~10s),
`commits-graph.delta` (~6s), `plugin-view/tree` (~6s). These spikes steal cores from
Postgres backends and inflate innocent queries (notifications, conversations_v, tasks_v) as
collateral.

**Root cause:** every concurrency bound today is **per-worktree** (the loader semaphore is
module-level per server; endpoint concurrency is per-route per-process). But the contended
resources — the box's CPU cores and the one embedded Postgres — are **global** across the
~16 live worktree servers on one machine. A per-worktree cap of N still allows ~16×N
concurrent git/tar/JSONL spawns. We need a **cross-process** bound on CPU-heavy subprocess
work.

**Intended outcome:** at most a small, host-wide number of CPU-heavy read operations run at
once across all worktrees, so no cross-worktree storm (a `main` ref advance fanning
`commits-graph.delta` out to ~16 worktrees, a burst of review/code-explorer navigations) can
saturate every core. Heavy-op latency under load drops; cheap interactive queries stop being
starved. No user-visible regression on the uncontended path.

## Decision: flock slot-broker (chosen over gateway / central / advisory locks)

The gate must live **server-side, wrapping the operation**, because the worst storm
(`commits-graph.delta`, a **push-mode** resource — confirmed: `commits-graph.delta` /
`commits-graph.graph` both `mode: "push"`) computes during the WS notify flush with **no HTTP
request** — so a **gateway** admission gate is structurally blind to it. Only wrapping the work
itself covers push-mode loaders and HTTP endpoints uniformly.

Mechanism trade-offs considered:

- **`flock(2)` slot-broker (CHOSEN).** The repo already gates host-wide build CPU with
  `flock` (`plugins/framework/plugins/cli/bin/host-semaphore.ts`, `withHostSlot`): N lock
  files under `~/.singularity/build-slots/`, crash-safe because flock auto-releases when the
  fd closes **or the holding process dies**. The one blocker: its acquire is a **synchronous**
  `ffi.flock(fd, LOCK_EX)` — fine in the one-shot CLI, but it would **freeze a long-running
  server's event loop**. Fix: move the blocking flock into a tiny **broker subprocess** the
  server `await`s (async, no event-loop block). Fully self-contained per worktree — testable
  end-to-end without touching shared infra, no DB/network dependency, crash-safe by
  construction.
- **Central-runtime semaphore** — cleanest reuse of existing pieces, but central runs one
  host-wide instance from `main`; it **cannot be sandboxed/tested in a worktree** and needs a
  main merge to take effect. Rejected for the iterative workflow.
- **Gateway admission (Go)** — blind to push-mode loaders (above). Rejected.
- **Postgres advisory locks** — add load to the very resource we're protecting; no precedent.
  Rejected.

## End state

A clean **pair** of concurrency primitives: in-process `createSemaphore` (exists) and its
cross-process twin `createHostSemaphore`, both exposing `{ run(fn, onWait?) }`. One shared
host-wide `heavy-read` pool instance wraps the five CPU-heavy operations.

### Change 1 — `createHostSemaphore` primitive (new plugin `packages/host-semaphore`)

New pure-library plugin, sibling of `packages/semaphore`. Exposed from a **`server` barrel**
(not `core`): it uses `bun:ffi` + `node:fs` + `Bun.spawn`, none browser-safe, so a `core`
barrel would let web import it and break the bundle. No `ServerPluginDefinition` default
export (like `semaphore`), so it does not enter `server.generated.ts`.

```
plugins/packages/plugins/host-semaphore/
├── package.json                        # @singularity/plugin-packages-host-semaphore (private)
├── CLAUDE.md                           # cross-process twin of semaphore; broker model; crash-safety
├── server/
│   ├── index.ts                        # barrel: export { createHostSemaphore }; type HostSemaphore
│   └── internal/host-semaphore.ts      # parent-side: spawn broker, await "granted", run fn, release
└── scripts/broker.ts                   # broker subprocess — the ONLY place a blocking flock lives
```

**API (mirrors `Semaphore` exactly):**
```ts
export interface HostSemaphore {
  run<T>(fn: () => Promise<T>, onWait?: (waitMs: number) => void): Promise<T>;
}
export function createHostSemaphore(opts: { name: string; size: number }): HostSemaphore;
```

**`host-semaphore.ts` (parent side) — `run`:**
1. `Bun.spawn(["bun", BROKER_PATH], { stdin:"pipe", stdout:"pipe", stderr:"inherit", env: { HOST_SEM_SLOTS_DIR, HOST_SEM_SIZE } })`.
   `BROKER_PATH = join(import.meta.dir, "..", "..", "scripts", "broker.ts")` (the on-disk
   resolution pattern proven by `plugins/database/plugins/embedded/scripts/start.ts`). The
   parent computes `HOST_SEM_SLOTS_DIR = join(SINGULARITY_DIR, name + "-slots")` from
   `SINGULARITY_DIR` (imported legally from `@plugins/infra/plugins/paths/server`) and passes
   it via env — so **`broker.ts` imports nothing cross-plugin** (only `node:fs/path/os`,
   `bun:ffi`), sidestepping any boundary-scan question and staying independently testable.
2. `await` the literal `"granted\n"` line from `broker.stdout` (async — event loop not
   blocked). If stdout closes with no token → throw (fail loud); `finally` still cleans up.
3. `onWait?.(performance.now() - t0)` once at acquisition, before `fn`.
4. `try { return await fn() } finally { broker.stdin.end(); broker.kill(); await broker.exited }`
   — closing stdin gives the broker EOF → it exits → flock releases. Rejecting `fn` never
   leaks a slot (same contract as `createSemaphore`).

**`scripts/broker.ts` (the blocking flock lives here, child has no event loop):**
- Read `HOST_SEM_SLOTS_DIR`, `HOST_SEM_SIZE` (N). `mkdirSync(dir, { recursive:true })`
  (idempotent, race-safe). `dlopen` libc (`darwin ? "libc.dylib" : "libc.so.6"`), `flock`
  symbol; `LOCK_EX=2`, `LOCK_NB=4` (copy from `withHostSlot`).
- `fds = [slot-0.lock … slot-(N-1).lock].map(f => openSync(f, "w"))`.
- Non-blocking sweep: first `flock(fd, LOCK_EX|LOCK_NB) === 0` wins. If none free, **block**
  on `flock(fds[pid % N], LOCK_EX)` (blocking OK here).
- `process.stdout.write("granted\n")` — **guard EPIPE**: a failed write means the parent died
  → exit immediately (release).
- Then drain `Bun.stdin.stream()` to EOF (parent never writes); on EOF / SIGTERM → `exit(0)`.
  Closing fds releases the flock.

### Change 2 — shared `heavy-read` pool + `withHeavyReadSlot` (new plugin `infra/host-read-pool`)

The pool *instance* (fixed name + size) and the profiler span depend on `runtime-profiler`
and `host-semaphore` — concerns a bare primitive shouldn't carry — so they live in a small
server-side infra plugin. Pure library, no routes, no default export.

```
plugins/infra/plugins/host-read-pool/
├── package.json
├── CLAUDE.md
└── server/{index.ts (export { withHeavyReadSlot }), internal/pool.ts}
```

**`pool.ts`:**
```ts
import { createHostSemaphore } from "@plugins/packages/plugins/host-semaphore/server";
import { recordSpan } from "@plugins/infra/plugins/runtime-profiler/core";
import { cpus } from "node:os";

function heavyReadSize(): number {
  const env = process.env.SINGULARITY_HEAVY_READ_CONCURRENCY;
  if (env) { const n = parseInt(env, 10); if (n > 0) return n; }
  return Math.max(1, Math.floor(cpus().length / 4));   // ~4 on an 18-core box; matches build-pool convention
}
const pool = createHostSemaphore({ name: "heavy-read", size: heavyReadSize() });

export function withHeavyReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  return pool.run(fn, (waitMs) => recordSpan("db", "[heavy-read-acquire]", waitMs));
}
```

**Span:** `SpanKind` is the closed union `"http" | "db" | "loader"` (confirmed); a 4th kind
is a central-core change, so **reuse `"db"`** with the distinguishing label
`[heavy-read-acquire]` — exactly the `db [loader-acquire]` precedent in
`server-core/core/resources.ts:105`. It stacks beside `[acquire]` / `[loader-acquire]` in
`get_runtime_profile kind:"db"`, is attributed to the enclosing http/loader entry by
`recordSpan`, and auto-feeds the durable slow_ops store via the existing `db`-threshold
`onSlowSpan` hook — so a saturated gate stays loud, never silent.

**Size:** `floor(cpus/4)`, env-overridable via `SINGULARITY_HEAVY_READ_CONCURRENCY` (mirrors
`SINGULARITY_BUILD_CONCURRENCY`). Conservative start; document that it can rise toward
`floor(cpus/2)` if profiling shows the gate is the bottleneck while CPU is unsaturated.

### Change 3 — wrap the five heavy operations (gate at OPERATION level, one slot per logical job)

Import `withHeavyReadSlot` from `@plugins/infra/plugins/host-read-pool/server` at each site.
**Avoid nesting** — one slot per logical job (flock is per-fd, so a nested wrap would consume
two slots for one job, not deadlock, but it violates the budget). The audited transitive
calls are resolved below.

1. **`getEditedFiles(wt)`** — `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts`.
   Wrap the whole body (4 git calls + untracked-file reads): `return withHeavyReadSlot(async () => { …existing… })`.
2. **`computeDelta` / `computeGraph`** — `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/compute-graph.ts`. **Most important** (the push-mode
   cross-worktree cascade). `computeGraph` calls `computeDelta` then 3 more `runGit` calls, and
   both are exposed via push resources (`commits-graph.delta`, `commits-graph.graph`).
   **Refactor to gate once, no nesting:** extract an un-gated `computeDeltaCore(worktreePath)`
   (the current `computeDelta` body). Public `computeDelta = (wt) => withHeavyReadSlot(() => computeDeltaCore(wt))`.
   `computeGraph = (wt, shas) => withHeavyReadSlot(async () => { const delta = await computeDeltaCore(wt); … })`
   — one slot spanning delta + the log fan-out.
3. **`handlePush` (plugin-changes)** — `plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts`.
   Wrap the push-only heavy section (`resolveParentSha` + the two `extractPluginsAtSha`
   `git archive | tar` + `computePluginChanges`). Do **not** wrap `handleWorkingTree` — it
   calls the now-gated `getEditedFiles` (would double-wrap). If `handlePush` also calls the
   gated `getRangeFiles` (Change 3.4), wrap only the `extractPluginsAtSha`/`computePluginChanges`
   portion there to avoid nesting.
4. **`getRangeFiles`** — `plugins/code-explorer/server/internal/get-push-files.ts`. Wrap the
   body (two diff calls + parse); leave the single cheap `resolveParentSha` `rev-parse` ungated.
5. **`buildPluginTree`** — `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`.
   Wrap the `buildPluginTree(PLUGINS_DIR, …)` call (filesystem walk); keep the cheap in-memory
   `toApiNode`/tally outside the gate.

### Change 4 — consolidate duplicate git-spawn helpers (structural cleanup, separate from the gate)

Three byte-identical private `run()` helpers duplicate the canonical `runGit`
(`plugins/primitives/plugins/commit-list/server/internal/run-git.ts`, exported from
`@plugins/primitives/plugins/commit-list/server`). Replace the private `run()` in
`get-edited-files.ts` and `get-push-files.ts` with imports of `runGit`. Leave the bespoke
spawns in `handle-plugin-changes.ts` (`--git-common-dir`, the `archive | tar` pipe) inline.

**Keep the gate out of `runGit`.** Gating lives at the operation level (Change 3); `runGit`
stays a thin, ungated spawn so cheap interactive git (e.g. a lone `rev-parse` off the cascade
path) is never serialized behind a 14s archive.

## Critical files

- `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts` — new primitive (parent).
- `plugins/packages/plugins/host-semaphore/scripts/broker.ts` — new broker subprocess (blocking flock).
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` — shared pool + `withHeavyReadSlot` + span.
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/compute-graph.ts` — `computeDeltaCore` extraction + gate (most contended).
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` — wrap + use `runGit`.
- `plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts` — wrap push section.
- `plugins/code-explorer/server/internal/get-push-files.ts` — wrap + use `runGit`.
- `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` — wrap `buildPluginTree`.
- Reference (unchanged): `plugins/framework/plugins/cli/bin/host-semaphore.ts` (FFI/slot-file convention; CLI keeps its sync flock — it's a one-shot process, the broker buys it nothing).

## Risks / edge cases

- **Broker spawn latency vs op duration.** Each `run` spawns `bun broker.ts` (~10–40ms cold)
  — negligible against 100ms–14s ops, but pure tax on a fast uncontended op. **Ship
  always-spawn first**, measure `[heavy-read-acquire]`; if spawn cost dominates the
  uncontended path, add an in-process non-blocking `flock(LOCK_NB)` fast-path in the parent
  (a single non-blocking syscall is microseconds — not a thread freeze) and spawn the broker
  only when all slots are busy.
- **Parent dies while broker still waiting.** Broker blocked in `flock(LOCK_EX)`, parent
  SIGKILLed → when the lock frees the broker acquires, `write("granted")` hits EPIPE → exit
  (release); also stdin EOF terminates the drain loop. Implement **both** the EPIPE-on-write
  guard and the stdin-EOF exit. Worst case: a brief one-slot over-hold that self-heals.
- **FFI portability.** `dlopen` target differs darwin/linux; copy the
  `process.platform === "darwin" ? "libc.dylib" : "libc.so.6"` branch verbatim. `LOCK_EX/NB`
  identical on both.
- **Slot-dir / file races.** `mkdirSync(recursive:true)` and `openSync(f,"w")` are both
  race-safe across concurrent worktrees (idempotent; file content never read, only flock state).
- **Nesting audit.** Resolved: `handlePush`↛ re-wrap gated `getRangeFiles`/`getEditedFiles`;
  `computeGraph` calls un-gated `computeDeltaCore`. Re-audit before finalizing.
- **No central-core / migration / registry-root changes.** Two new pure-library plugins,
  covered by the existing `allow("plugin.** -> plugin.**")` boundary edge; web→server
  isolation auto-enforced. Add both `CLAUDE.md`s; `./equin build` regenerates
  `docs/plugins-*.md` (the `plugins-doc-in-sync` check requires it).

## Verification (self-contained — this worktree, no central/main-merge needed)

1. `./equin build` → both new plugins compile, barrels resolve, broker path valid,
   `plugins-registry-in-sync` / `plugins-doc-in-sync` pass. App at `http://<worktree>.localhost:9000`.
2. **Functional smoke:** open a conversation → commits-graph chip, edited-files, review
   plugin-changes, code-explorer push view, and plugin-view tree all still render correctly
   (broker grants + releases on the happy path).
3. **Cross-worktree storm:** advance `main` (a push) so `git-watcher`'s `refHeadResource` fans
   `commitDelta`/`commitGraph` across all on-screen commits-graph chips in ~16 worktrees at
   once — the exact contention this fixes. Optionally add concurrent `GET /api/plugin-view/tree`
   + edited-files fetches across worktrees.
4. **Signals — `mcp__singularity__get_runtime_profile` (kinds `db`/`loader`/`http`) + the
   durable slow_ops store:**
   - A new `db [heavy-read-acquire]` aggregate appears; in-flight heavy ops never exceed
     `size` (acquire-wait grows under storm while box CPU stays unsaturated — the gate working).
   - `commits-graph.graph`/`.delta` and `edited-files` **loader** `maxMs` (and nested git/db
     spans) drop materially vs an unbounded run — the box no longer thrashes ~16× git fan-outs.
   - No regression: interactive `db` SQL spans and ungated `runGit` calls unchanged (gate is
     strictly operation-level, never leaked into `runGit`).
5. **Crash-safety:** kill a worktree backend mid-op → `~/.singularity/heavy-read-slots/*.lock`
   release (next acquire elsewhere succeeds immediately; `lsof` shows no lingering holders).
