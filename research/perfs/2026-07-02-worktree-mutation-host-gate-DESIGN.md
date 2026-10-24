# Bound host-wide `git worktree` mutations (add/remove) — throughput gate (DESIGN)

**Status:** Implemented + `./equin build` green (all 60 checks) — **NOT yet validated on
data.** The required Phase-2 launch-during-reap trace has **not** run: the box was saturated
(load 40–42 / 18 cores) at implementation time, so the worktree backend could not finish cold
boot (15 s readiness) to deploy, and a heavy 6-way git-churn trace on an already-saturated box
would be both antisocial and noise-contaminated. Deploy + trace are **pending box quiescence**.
Do NOT promote to Completed until the trace lands (per the perfs-doc currency rule). Continues
[`issue-launch-conversation-slow.md`](./issue-launch-conversation-slow.md) (the deferred
Phase-2 throughput follow-up, `task-1782991245011-l3m3an`). Cost-axis origin filed as
`task-1783010164482-y7qec2`.

**Gate size on this box:** `cpus().length` = 18 → `max(2, floor(18/6))` = **3** (as designed).

## Context

The interactive-latency origin fix already landed: `git worktree add` (the ~3.8 s / 77 MB /
8385-file checkout) was moved **off** the `POST /api/conversations` response into the durable
`conversations.spawn` job (`plugins/conversations/server/internal/spawn-job.ts`). Perceived
launch latency dropped from 3.8–13 s to ~0.39 s.

What remains is a **worker-throughput** concern, not interactive latency. The checkout *job*
still competes for machine disk/CPU bandwidth, and it runs concurrently with
`worktree-cleanup.reap-stale`'s repeated `git worktree remove` (each ~1.2 s of 77 MB `rm`).
The Phase-2 controlled trace (issue doc, 2026-07-02) established the mechanism precisely:

- There is **no git repo-global lock** — concurrent `git worktree add`s run in *parallel*
  (`git reset --hard` against the *new* worktree's own index, `GIT_DIR=<newpath>/.git`).
- But they contend for **disk/CPU bandwidth**: K concurrent adds stay ~baseline through K=4
  (each ~3.8 s) and **degrade at K≥6** (each ~5.6 s). A foreground add run *during* a 6-way
  remove/add churn — mirroring the reap's `pMap(limit=6)` — slows **3.20 s → 7.72 s median /
  10.67 s max (+141 %)**.
- The reap runs `pMap(limit=6)` over ~226 stale worktrees = **~58 s of continuous 6-way heavy
  removes**, monopolizing disk for the whole window and starving any concurrent spawn job.

**Altitude (per the perfs skill — the honest version).** This gate is a **boundary invariant +
containment**, and for two of the three cost sources that is the *correct* altitude, not a
stop-too-low:

- **Launch-vs-launch:** N concurrent launches each need a real checkout — legitimate demand, no
  no-op/wasted work. You cannot make N parallel 77 MB checkouts free; bounding concurrency is the
  only lever, and a host-wide invariant is the correct form.
- **Launch-vs-reap:** `reap-policy.ts` fires the expensive 77 MB `git worktree remove` **only**
  for done + pushed + clean + ≥72 h (or ≥30 d) worktrees — legitimate, necessary, correct garbage.
  Gate 2 (legitimacy) *passes*: this GC should happen at that rate. There is **no illegitimate
  work to eliminate** — the removes only *collide* with demand, and scheduling/bounding a
  legitimate-vs-legitimate collision is the sanctioned containment.

- **⚠️ The one inherited-not-revalidated assumption (Phase-0 violation):** "the checkout is
  **irreducible** — an agent needs a full working tree." A worktree shares the object store; the
  77 MB is the **checked-out working tree (8385 files)**, paid by *both* `add` and `remove`. If a
  typical agent modifies only a **subtree**, `sparse-checkout` / partial checkout would cut the
  per-op cost **at the source**, shrinking add *and* remove together and largely *dissolving* the
  contention — making this gate a **backstop, not the fix**. This is the true **cost-axis origin**
  and it is asserted, not proven. It must be re-validated (what fraction of the tree does an agent
  actually touch?) or explicitly deferred — see Follow-ups. Until then, this doc ships the gate as
  the invariant/containment and does **not** claim to have found the origin.

## Mutation surface (why one choke point covers everything)

`git worktree remove` routes through **one** function; `git worktree add` through **two** sites
(`setupWorktree` is not the sole `add` — the staging-land path has its own inline spawn). All
live in `plugins/infra/plugins/worktree/server/internal/worktree.ts` **except one**:

- **`setupWorktree()`** (`worktree.ts:57`) — the primary `git worktree add`. Runtime caller:
  `spawn-job.ts` (the durable job). (`discover.ts` is build-time checks — irrelevant to load.)
- **`removeWorktree()`** (`worktree.ts:99`) — the only `git worktree remove`. Callers:
  - `reapAttempt` (`reap.ts:41`) → used by the reap job (`reap-job.ts`, `pMap(6)`),
    `handle-delete.ts`, and `handle-bulk-delete.ts`.
  - staging land / push (`config_v2/plugins/staging/server/internal/land.ts:120,127`).
- **`land.ts:59`** — a **second, inline** `git worktree add` (`Bun.spawn`) that bypasses
  `setupWorktree` (it wants its own branch, no tsbuildinfo/mise steps). This is the only `add`
  outside `worktree.ts` (confirmed by repo-wide grep). Low-frequency + single-flight
  (`config-v2.land-defaults` `dedup: "singleton"`), but for the invariant to actually hold
  ("no unbounded host-wide worktree-mutation storm for *any* caller") it must be gated too —
  see design §1.

These callers live in **multiple processes** (reap + staging land on `main`; spawn jobs and
manual deletes across backends), so an **in-process** semaphore cannot bound them. The
host-wide `flock` semaphore is the only primitive that bounds *across* processes.

## Design

Mirror the established `host-read-pool` precedent
(`plugins/infra/plugins/host-read-pool/server/internal/pool.ts`), which is itself a thin
policy layer over the generic `createHostSemaphore`
(`plugins/packages/plugins/host-semaphore/server`).

### 1. A dedicated `worktree-mutate` host semaphore (primary fix)

A **separate** host semaphore from `heavy-read` — deliberately not the same gate:

- `heavy-read` bounds cheap-ish interactive **reads** (`edited-files`, `commits-graph`, code
  navigation). Worktree mutations are heavy **writes** (3.8 s checkout, 1.2 s rm). Routing a
  3.8 s write through the read gate would **head-of-line-block** interactive reads behind it —
  the opposite of what we want. Two independent budgets keep read latency and write throughput
  decoupled.

Place the pool instance **inside `infra/worktree`** (co-located with the two functions it
gates — the single consumer), not a new plugin. New file
`plugins/infra/plugins/worktree/server/internal/mutate-gate.ts`:

```ts
import { createHostSemaphore } from "@plugins/packages/plugins/host-semaphore/server";
import { chargeWait } from "@plugins/infra/plugins/runtime-profiler/core";
import { cpus } from "node:os";

function mutateSize(): number {
  const env = process.env.SINGULARITY_WORKTREE_MUTATE_CONCURRENCY;
  if (env) { const n = parseInt(env, 10); if (n > 0) return n; }
  return Math.max(2, Math.floor(cpus().length / 6)); // 18 CPUs -> 3; conservative
}

const gate = createHostSemaphore({ name: "worktree-mutate", size: mutateSize() });

// Wrap the heavy `git worktree add`/`remove` subprocess. The acquire-wait is
// charged to the enclosing profiler entry (job/http) so a saturated gate stays
// attributable in get_runtime_profile / slow-ops, mirroring host-read-pool.
export function withWorktreeMutateSlot<T>(fn: () => Promise<T>): Promise<T> {
  return gate.run(fn, (waitMs) => chargeWait("worktree-mutate-acquire", waitMs));
}
```

Then wrap **only the `Bun.spawn(... "worktree", "add"/"remove" ...)` step** inside
`setupWorktree` and `removeWorktree` with `withWorktreeMutateSlot(...)`. Keep the idempotent
`existsSync` early-return, the tsbuildinfo copy, and `mise trust` **outside** the gate (they're
cheap / not the disk offender). This covers spawn, reap, manual delete, and the `removeWorktree`
side of staging land automatically.

**Also gate `land.ts:59`** (the second inline `git worktree add`) so the invariant is airtight:
`export { withWorktreeMutateSlot }` from the `infra/worktree/server` barrel and wrap that spawn
in staging land. This is the *only* new cross-plugin surface (one named export); `land.ts`
already imports `removeWorktree` from the same barrel, so no new dependency edge.

**Not a per-id mutex.** The gate bounds *concurrency*, not same-id races: two `setupWorktree(id)`
calls for the same id (a retried durable job racing a fresh enqueue) can still both hold a slot
and race the identical `git worktree add`. That is the pre-existing benign race already handled
by the `existsSync`-treated-as-success branch (`worktree.ts:79-83`) — the gate neither fixes nor
worsens it, and must not be assumed to serialize per id.

**Size rationale (from the trace):** K=4 concurrent adds stay ~baseline; K≥6 degrades ~+75 %/op
and drives the +141 % under-churn number. A host-wide bound of **~3** keeps the box in the flat
region while still allowing genuine parallelism. Env-overridable
(`SINGULARITY_WORKTREE_MUTATE_CONCURRENCY`), matching `SINGULARITY_HEAVY_READ_CONCURRENCY`
convention. Final value confirmed by the trace below.

**Safety (verified against the primitive):** `HostSemaphore.run` releases its slot in a
`finally` on both fast and slow paths (`host-semaphore.ts:107-110,137-145`) and re-rejects with
`fn`'s error — so `setupWorktree`/`removeWorktree` throwing loudly on a nonzero git exit never
leaks a slot. No nesting/reentrancy (each function acquires once; no caller already holds this
gate) ⇒ no deadlock. `chargeWait` degrades to a standalone span when there is no active entry
(job context), so the graphile-job callers are fine.

### 2. Lower the reap's per-tick concurrency (complementary — the "yield/bounded per tick")

The host gate is the hard bound, but a 226-target reap presenting **6** continuous waiters can
still crowd the shared flock queue ahead of an interactive spawn. Mirroring host-read-pool's
**two-tier** per-caller cap, lower the reap's `pMap` limit in `reap-job.ts:39` from `6` to **the
gate size (~3)** (or a small constant `≤` the gate). The reap stays a good citizen: it can never
occupy more than its share of the host gate, always leaving headroom for a launch's checkout.

**Second-order coupling to re-derive (do not assume ratio-scaling):** a `pMap` worker runs the
*whole* `reapAttempt` serially (git-remove → DB-drop → config-rm → registry-rm). Lowering `pMap`
*and* adding a front-of-pipeline gate wait means the independent DB-drop/config/registry work is
now more tightly coupled to git-mutate contention. So the reap's total wall-time under the new
gate is **not** the old "58 s × 6/3" — it must be **re-measured** in the trace, not assumed. The
rise is acceptable (background maintenance; the goal is *no disk monopolization*, not a faster
reap), but the number should come from data. If the coupling proves material, an alternative is
to keep `pMap` higher and rely on the host gate alone for the git bound — decide from the trace.

> The manual `handle-bulk-delete.ts` path already bounds its own concurrency; it now also
> inherits the host gate for free. No change needed there beyond the shared gate.

## Files to change

- **New:** `plugins/infra/plugins/worktree/server/internal/mutate-gate.ts` — the pool instance
  + `withWorktreeMutateSlot`.
- `plugins/infra/plugins/worktree/server/internal/worktree.ts` — wrap the two `Bun.spawn` git
  mutation steps in `withWorktreeMutateSlot`.
- `plugins/infra/plugins/worktree/server/index.ts` — re-export `withWorktreeMutateSlot` (one
  named export; the only new cross-plugin surface, needed for `land.ts`).
- `plugins/config_v2/plugins/staging/server/internal/land.ts` — wrap the inline `git worktree
  add` at `:59` in `withWorktreeMutateSlot`.
- `plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts` — `pMap(targets, 6, …)`
  → `pMap(targets, 3, …)` (or a named constant tied to the gate size).

## Verification — Phase-2 launch-during-reap trace (required before promoting)

Reproduce the issue doc's controlled methodology, gate **off** vs **on**:

1. **Controlled harness (throwaway worktrees, scratchpad paths, cleaned up after — never touch
   real worktrees).** Mirror the existing `idxlock-*` harness from the issue doc: spin a 6-way
   `removeWorktree`/`setupWorktree` churn and time a foreground `setupWorktree`.
   - **Baseline (gate off):** `SINGULARITY_WORKTREE_MUTATE_CONCURRENCY=999` → expect the prior
     **+141 % under-churn degradation** (3.2 s → ~7.7 s median).
   - **Gate on (size 3):** expect the foreground add to stay near baseline (no ~7.7 s tail),
     because total concurrent heavy mutations are capped at 3.
   - Sweep sizes 2/3/4 to pick the knee (flat per-op cost vs. throughput).
2. **Live check on the deployed worktree:** trigger a real reap (or the bulk-delete path) and
   fire several launches concurrently; read `get_runtime_profile`:
   - `conversations.spawn` `workMs` should no longer spike into the tens of seconds during a
     reap; the new `worktree-mutate-acquire` wait span makes the gate queue observable and
     attributable.
   - Confirm `worktree-cleanup.reap-stale` no longer holds 6 concurrent removes.
3. `./equin build` green (all checks) before and after.

**Counterfactual exit test (Phase 4):** under the same load, does the fix make the pile-up
**not hurt** (bounded, fair sharing) rather than **not happen**? Yes — and that is the intended
altitude (containment). The origin (irreducible checkout) is unchanged; we are bounding
contention, which is the correct remaining lever now that the interactive path is already off
the checkout.

## Follow-ups

- **[cost-axis origin — the real root] Prove or refute checkout irreducibility. → DONE 2026-07-02,
  assumption REFUTED — see [`2026-07-02-worktree-checkout-clonefile-DESIGN.md`](./2026-07-02-worktree-checkout-clonefile-DESIGN.md).**
  Measured: agents modify **< 1 %** of the 8475-file tree (median ~5–8 files, max 72). But
  *sparse-checkout is dead* — the mandatory `./equin build` type-checks/reads the **whole
  tree** (fraction *read* ≈ 100 %; `setupWorktree` even seeds `.tsbuildinfo` for exactly this
  reason), so a partial tree is a *broken* worktree, not a cheaper one. The cost is still reducible,
  just via a lever this doc didn't consider: the tree must be **present** but on APFS need not be
  physically **copied**. A single directory-granular `clonefile(2)` materializes all 8475 files as
  copy-on-write in **~0.24 s vs ~3.8 s checkout (16×; 80× under load)**, and stays flat under
  contention (metadata-only, no disk-write monopolization) ⇒ it *dissolves* the launch-vs-reap
  collision this gate only *bounds*. Clean integration proven feasible (`git worktree add
  --no-checkout` + clonefile from a warm `main` template + `read-tree HEAD` → clean worktree), with
  a correct checkout fallback for stale-template / non-APFS. `cp -c` per-file clonefile does **not**
  win (per-file metadata bound). **This gate stays** as the containment backstop (fallback add +
  remove side + non-APFS hosts); clonefile is the origin cure for the add cost — keep both.
- **[rate-axis smell] Hourly full re-classification.** `collectReapable` re-runs 24-way
  `getGitHygiene` git spawns over *every* inactive attempt *every* hour (`reap-policy.ts:94`) —
  redundant recompute for worktrees unchanged since the last tick. Not the dominant 77 MB cost,
  but worth a `git-read-cache`-style memo keyed on the worktree's git state.
- Strict priority (launch spawn preempting reap) — flock grants are ~FIFO, not priority. The
  two-tier cap gives *fairness*, not preemption; true priority is unwarranted for a
  worker-throughput (non-interactive) concern.
