# Debounce `refHeadResource` to collapse the cross-worktree git-ref storm

## Context

This is **Change 2B** from `research/2026-06-15-global-live-state-cascade-contention.md`,
now unblocked: the `debounceMs` cascade primitive landed in
`plugins/framework/plugins/resource-runtime/core/runtime.ts` and was adopted on
`conversationsLiveResource` (Increment 1, commit `60de4d700`).

**The problem.** A `refs/heads/main` advance fires `refHeadResource.notify({ refName })`
synchronously in *every* worktree's server (the git-watcher watches `refs/heads/main`
in all worktrees — `watcher.ts:15`). Each notify cascades through three `dependsOn`
downstreams, every one of which spawns a git subprocess in its loader:

- `mainAheadCountResource` — `plugins/build/server/internal/main-ahead-resource.ts` (git rev-list)
- `commitDeltaResource` — `…/commits-graph/server/internal/resources.ts:52` (scoped to on-screen attempts)
- `commitsGraphResource` — `…/commits-graph/server/internal/resources.ts:73` (scoped to on-screen attempts)

So one main advance becomes `N_worktrees × (1 + on-screen chips)` simultaneous git
processes. A **rebase rewrites `refs/heads/main` many times in quick succession**
(`recompute()` in `watcher.ts:67` fires once per filesystem change event, calling
`notify()` on every distinct sha), multiplying the storm. This is the dominant
**cross-worktree** contention signal in the cascade-contention research.

**Intended outcome.** A burst of ref rewrites in one worktree collapses into a single
flush (one notify per `debounceMs` window) instead of one-per-rewrite — the biggest
cross-worktree relief in the design, at essentially zero risk.

## Why this is safe

- `refHeadResource` is `mode: "push"`, **not** keyed — it has no optimistic-mutation /
  delta-sync coupling. The primitive's one prohibition (don't debounce a keyed resource
  driving client reconciliation; debounce the source instead) does not apply.
- The three downstreams run their git loaders synchronously *within* each flush; the
  debounce only delays/coalesces *when* the flush fires. The FULL-absorbing /
  scoped-union coalescing in `mergePending` is unchanged.
- Fixed-window trailing semantics (timer is **not** re-armed within a window — see
  `scheduleNotify`, runtime.ts:508) guarantee a continuously-advancing ref still flushes
  at least every `debounceMs`; no starvation.
- Piggyback: if any non-debounced resource triggers a flush mid-window, the debounced
  entry's pending drains with it and its timer is cancelled (`flushNotifies`,
  runtime.ts:600) — so a fresh sha is never delayed beyond an already-happening flush.
- Worst case for a single isolated commit: the new ahead/behind delta on a commits-graph
  chip appears up to `debounceMs` later. For a git-state display this is imperceptible.

## The change

A single declarative field on the resource definition, mirroring the
`conversationsLiveResource` adoption (`tasks-core/server/internal/resources.ts:38`)
byte-for-byte in shape.

**File:** `plugins/infra/plugins/git-watcher/server/internal/ref-head-resource.ts`

```ts
export const refHeadResource = defineResource<{ sha: string | null }, Params>({
  key: "git-watcher.refHead",
  mode: "push",
  schema: RefHeadSchema,
  // A rebase rewrites refs/heads/main many times in quick succession; the
  // watcher notifies per distinct sha, cascading to mainAheadCount +
  // commitDelta/commitsGraph (git subprocesses) in every worktree. A fixed-window
  // trailing debounce collapses a rebase's rewrites into one flush per worktree —
  // the cross-worktree storm relief. Source is push (not keyed), so debouncing it
  // is safe. See research/2026-06-15-global-live-state-cascade-contention.md (Change 2B).
  debounceMs: 300,
  loader: async ({ refName }) => ({ sha: await readSha(refName) }),
});
```

`debounceMs: 300` per the research doc's recommendation (vs. 250 on the
higher-frequency `conversationsLiveResource` poller). No other code changes — the
primitive does all the work at the `scheduleNotify` chokepoint.

## Verification

The prompt asks to **measure the Increment-1 debounce on `conversationsLiveResource`
first**, then adopt 2B and re-measure. All measurement uses MCP tools against a busy
target (`singularity` or an active worktree).

**Step 0 — baseline the already-landed Increment 1** (before touching `refHeadResource`):
- `mcp__singularity__get_runtime_profile { kind: "loader" }` — record the invocation
  *count* for `conversations` / `attempts` / `tasks` loaders. The debounce should already
  show fewer invocations under load (coalesced), with average flat (no per-flush regression).
- `mcp__singularity__get_runtime_profile { kind: "db" }` — record `[acquire]` max and
  slow-acquire count, and the `byParent` attribution.
- `mcp__singularity__query_db { database: "singularity", sql:
  "SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity WHERE state='active' GROUP BY 1,2;" }`
  Confirm Increment 1 is behaving as designed before extending the pattern. If it is NOT
  helping, stop and revisit before adopting 2B.

**Step 1 — apply the change**, then `./equin build` (regenerates nothing schema-wise;
just rebuilds + restarts the server).

**Step 2 — after 2B:**
- `get_runtime_profile { kind: "loader" }` — `commitDelta` / `commitsGraph` /
  `mainAheadCount` loader *count* drops during a ref-rewrite burst, while average stays flat.
- **Storm test:** with a commits-graph chip on screen, deliberately rewrite
  `refs/heads/main` rapidly in another worktree (e.g. a small interactive-free rebase or a
  loop of trivial commits + resets on a scratch branch). Run
  `query_db { sql: "SELECT datname, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;" }`
  during the burst — the simultaneous active-backend peak across worktrees should drop
  vs. the same storm pre-2B.
- **No-stale check:** make a single isolated commit on a watched branch → confirm the
  commits-graph / main-ahead delta still updates within ~`debounceMs` (piggyback or the
  fixed-window flush), i.e. one rewrite still lands promptly.

## Critical files
- `plugins/infra/plugins/git-watcher/server/internal/ref-head-resource.ts` — add `debounceMs: 300` (the only edit).
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — the primitive (no change; `scheduleNotify`:498, `flushNotifies`:586).
- `plugins/tasks/plugins/tasks-core/server/internal/resources.ts:29` — the precedent adoption to mirror.
- Downstreams (no change; the cascade they participate in is what's being collapsed):
  `plugins/build/server/internal/main-ahead-resource.ts`,
  `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/resources.ts`.
</content>
</invoke>
