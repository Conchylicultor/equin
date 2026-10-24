# Incremental + coalesced + skip-in-flight git live-state loaders, with an isolated heavy-read gate

## Context

The most expensive live-state loaders on the box are the git-backed ones:
**edited-files** (avg ~19s, max ~68s) and **commits-graph** delta/graph (avg
~12–18s, max ~66s). Each spawns several git subprocesses and does a **full
recompute every time**, re-triggered on every git ref advance (`refHeadResource`)
and on file saves (`@parcel/watcher`), and fans out **once per open view**. All
of this work must first acquire the **host-wide heavy-read flock gate**
(`withHeavyReadSlot`, size `floor(cpus/4)` ≈ 2–4 for the *entire machine*). With
~16 worktrees and many open views, a single `main` advance fans
`refHeadResource` across every backend → dozens of full git recomputes serialize
2-at-a-time. This is the primary source of the `[heavy-read-acquire]` /
`[loader-acquire]` waits (avg ~3.4s, max ~45s) and the head-of-line blocker
behind stale UI delivery.

This builds directly on two prior efforts (read them — same methodology, same
seams):
- `research/2026-06-15-global-live-state-cascade-contention.md` — `debounceMs`,
  loader semaphore, endpoint concurrency/dedupe (the DB-side herd).
- `research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md` — the
  `withHeavyReadSlot` flock broker this plan refines.

**Intended outcome:** redundant git recomputes are eliminated (a notify that
finds unchanged git state does **no** git work and acquires **no** slot);
remaining real recomputes are coalesced across views and made incremental; and
no single worktree backend can starve the others at the gate. Heavy-loader
`maxMs` and `[heavy-read-acquire]` waits drop sharply with no user-visible
staleness.

**Decisions locked with the user:** full four-lever plan, staged; **per-worktree
gate isolation only** (host size stays `floor(cpus/4)`, tunable via the existing
`SINGULARITY_HEAVY_READ_CONCURRENCY` env). Implementation will be delegated to
agents per stage.

---

## The unifying primitive: a git-state-keyed result memo

Three of the four levers (incremental, skip-in-flight, coalesce) collapse into
**one abstraction**:

> Read a **cheap, ungated signature** → on signature match return the cached
> value **with no heavy slot acquired** → on miss, single-flight the gated
> recompute and cache the result keyed by that signature.

- **Incremental / skip-redundant-work**: matching signature ⇒ skip the entire
  gated `git log`/diff body.
- **Skip-if-in-flight**: an embedded `createInflight()` (keyed by worktreePath)
  folds stacked recomputes into one execution.
- **Coalesce fan-out**: keyed on **worktreePath** (not conversationId /
  attemptId), so N conversations and the delta+graph of one attempt collapse
  onto one compute + one cached value.

The cheap signature probe uses the **thin ungated `runGit`** (a `rev-parse` is
microseconds; `host-read-pool/CLAUDE.md` deliberately keeps cheap interactive git
ungated) and, where possible, reuses SHAs git-watcher already holds in memory.
**The memo short-circuits before `withHeavyReadSlot` is ever called** — a cache
hit acquires neither the per-worktree nor the host slot. That is the whole point:
the storm path becomes mostly memo hits.

### Where it lives — new plugin `plugins/infra/plugins/git-read-cache/`

A small server-side infra plugin exporting `createGitStateMemo`, mirroring
`host-read-pool` exactly (thin policy over a primitive; **server barrel only** —
it uses `node`/profiler, never browser-safe; **no default `ServerPluginDefinition`
export** so it stays out of `server.generated.ts`; covered by the existing
`plugin.** -> plugin.**` boundary edge).

Rejected alternatives:
- **Inside each loader** — scatters three near-identical state machines; the same
  anti-pattern `host-read-pool` exists to avoid.
- **In `commit-list/server`** — `runGit` lives there as a *thin ungated spawn*;
  adding stateful Maps + a profiler dependency violates that charter.
- **Generic `validityKey`/cache on `resource-runtime`** — over-scoped and
  high-risk. The runtime is deliberately dependency-minimal and its single-flight
  is concurrency-only by design. A signature keyed on a *domain* value
  (worktreePath) the runtime can't see (params are `{id}`/`{attemptId}`) would
  thread a hook through `getResourceValue`/`timedLoad` — the chokepoint all ~42
  resources flow through — for a benefit only 3 git loaders need. Revisit only if
  a 4th heavy git loader appears.

### Primitive shape — `git-read-cache/server/internal/git-state-memo.ts`

```ts
export interface GitStateMemo<T> {
  // signatureFn: cheap, UNGATED probe → fingerprint of every input the result
  //   depends on (runs on EVERY call; must stay ~sub-ms / one ungated rev-parse).
  // computeFn:  the expensive, gated recompute; runs ONLY on a signature miss.
  get(worktreePath: string, signatureFn: () => Promise<string>,
      computeFn: () => Promise<T>): Promise<T>;
  evict(worktreePath: string): void;            // subscription-lifecycle cleanup
}
export function createGitStateMemo<T>(opts: { name: string }): GitStateMemo<T>;
```

Internal: `Map<worktreePath, { signature: string; value: T }>` + an embedded
`createInflight()` (`@plugins/packages/plugins/inflight/core`). `get`:

1. `const sig = await signatureFn();` — cheap, ungated, no slot.
2. `const hit = cache.get(wt); if (hit?.signature === sig) return hit.value;`
3. miss ⇒ `inflight.run(wt, async () => { const v = await computeFn(); cache.set(wt, { signature: sig, value: v }); return v; })`.
   `computeFn` is where `withHeavyReadSlot` lives — the memo never touches the gate.

Optional `onResult?: (hit: boolean) => void` so loaders can emit a
`git-memo-hit`/`miss` marker via `chargeWait` (`runtime-profiler/core`, exactly as
`pool.ts:22`) for hit-rate verification.

Contract note: the signature is captured before the inflight, so a second caller
arriving with a *different* signature mid-flight shares the in-flight (≤1-event
stale) result; the next notify re-probes. This mirrors the runtime single-flight's
existing staleness-sharing contract — document it in the CLAUDE.md.

---

## Stage 1 — Per-worktree gate isolation (smallest, independent, ship first)

Add a small **per-process (= per-worktree) in-process `createSemaphore` in front
of the host gate** in `plugins/infra/plugins/host-read-pool/server/internal/pool.ts`.
This is the cleanest match to "a per-worktree budget so one backend cannot starve
others": each backend caps how many heavy ops it queues into the shared flock,
so 16 backends can present at most `16 × local` but no single one monopolizes the
shared queue.

```ts
const perWorktreeGate = createSemaphore(localSize());        // ~2–3
const pool = createHostSemaphore({ name: "heavy-read", size: heavyReadSize() });

export function withHeavyReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Local gate OUTSIDE the host gate: bound this backend's presence in the
  // shared flock queue, THEN compete host-wide. Charge each wait distinctly.
  return perWorktreeGate.run(
    () => pool.run(fn, (ms) => chargeWait("heavy-read-acquire", ms)),
    (ms) => chargeWait("heavy-read-local", ms),
  );
}
```

- `localSize()`: `max(1, ceil(heavyReadSize()/2))`, env-overridable via a new
  `SINGULARITY_HEAVY_READ_LOCAL_CONCURRENCY`. Constraint **1 ≤ local ≤ host** so
  it never deadlocks or fully serializes a worktree's legitimate burst.
- `createSemaphore` from `@plugins/packages/plugins/semaphore/core` (a core
  barrel, browser-safe, no new boundary edge). Keep `heavyReadQueueDepth()`;
  optionally add `localQueueDepth()`.
- **Host size stays `floor(cpus/4)`** (user decision). No round-robin in the
  broker (keep it dead-simple/crash-safe).

Independently shippable with no loader changes; lowest risk; fully reversible.

**Files:** `pool.ts`, `host-read-pool/CLAUDE.md` (document the two-tier gate).

---

## Stage 2 — commits-graph incremental (the split signature — the storm-path fix)

The highest-leverage change: the cross-worktree `main`-advance storm
(`watcher.ts:91` fans `refHeadResource.notify` → every on-screen attempt in ~16
worktrees → `compute-graph.ts`).

### Signatures (a faithful function of every input)

The result depends on exactly: `HEAD` sha, `main` sha, merge-base, branch name,
and (graph only) the `pushedShas` set.

- **Probe inputs** (ungated, microseconds):
  - `HEAD` — `runGit(["rev-parse","HEAD"])`.
  - `main` — **already in memory** in git-watcher's `lastKnownSha` Map
    (`watcher.ts:23`); expose `lastKnownMainSha()` (Stage 2.1) so the probe needs
    zero subprocess for main. Fallback: ungated `rev-parse main` if null
    (watcher not yet seeded — never trust a missing watcher as "main unchanged").
  - merge-base — derived from HEAD+main; covered by them. For the graph split we
    do read it via one ungated `merge-base main HEAD` (`readMergeBase`,
    `compute-graph.ts:22`), far cheaper than the 200-commit log.
  - `pushedShas` (graph) — already fetched via `listPushesForAttempt`
    (`resources.ts:90`); fold its sorted joined shas into the signature.
- **delta** signature: `${headSha}|${mainSha}`.
- **graph** signature: `${headSha}|${mainSha}|${pushedShas.sort().join(",")}`.

### The split-signature incremental reuse (key idea)

A `main`-advance changes `behind`/`behindCommits` but usually leaves the
merge-base and the entire `mergeBase..HEAD` **pending** set unchanged. The
expensive call is the max-200 `git log mergeBase..HEAD` (`compute-graph.ts:91`).
Split the cached graph state into two independently-validated halves:

- **Pending half** — key `${headSha}|${mergeBase}`: the `mergeBase..HEAD` log
  (max-200) + `ahead` + `mergeBase` + `branch`. **Expensive.**
- **Behind half** — key `${mainSha}|${mergeBase}`: the `HEAD..main` log (max-50)
  + `behind`. Cheaper.

Recompute path:
1. Cheap probe → `{ headSha, mainSha, mergeBase }` (all ungated).
2. Pending half: key match ⇒ reuse cached pending commits + ahead — **no gated
   log**. This is the `main`-advance fast path (HEAD/merge-base unchanged ⇒ the
   max-200 log is skipped). True `lastSha..HEAD` incrementality.
3. Behind half: key match ⇒ reuse cached behind commits + behind count.
4. Only the missing half/halves run their `git log` inside **one**
   `withHeavyReadSlot` (single slot per logical job per `host-read-pool/CLAUDE.md`
   — wrap the assembly of just the missing halves). Both hit ⇒ assembled
   `CommitsGraph` with **zero gated work, zero slot**.

Storm collapse: a `main` advance ⇒ `mainSha` changes, `headSha`/`mergeBase`
unchanged ⇒ pending half hits, only the cheap behind half recomputes. Across 16
worktrees: 16 cheap behind-logs instead of 16 max-200 pending-logs + 16
behind-logs.

### Structure

- **`compute-graph.ts`**:
  - Add `probeGraphState(wt, mainSha)` → `{ headSha, mainSha, mergeBase }` (ungated
    `rev-parse HEAD` + `merge-base`; reuse `readMergeBase`).
  - Split `computeGraph` into `computePendingHalf(wt, mergeBase)` and
    `computeBehindHalf(wt)`; gate only the missing set.
  - `computeGraph` holds a **bespoke two-half cache** (`Map<wt, {pending:{key,val},
    behind:{key,val}}>`) + its own worktree-keyed `createInflight` — its
    incremental structure is genuinely special, so it does NOT use the generic
    single-signature memo. Document this asymmetry.
  - `computeDelta` uses the **generic `createGitStateMemo`** with signature
    `${headSha}|${mainSha}` (delta is cheap; the memo gives it coalescing +
    skip-in-flight, see Stage 3).
- **`resources.ts`**: pass `mainSha` (from `lastKnownMainSha()`) + `pushedShas`
  into the compute functions; evict on `onLastUnsubscribe` (lines 63/84).

### Stage 2.1 — expose `lastKnownMainSha()` from git-watcher

`watcher.ts` already maintains `lastKnownSha.get("refs/heads/main")` (module-private).
Add a getter there, re-export from `git-watcher/server/index.ts`. commits-graph
already imports `@plugins/infra/plugins/git-watcher/server` (`resources.ts:2`) — no
new boundary edge.

**Files:** `compute-graph.ts`, `resources.ts`, `git-watcher/server/internal/watcher.ts`
(+ a `main-sha.ts` getter), `git-watcher/server/index.ts`, new `git-read-cache`
plugin.

---

## Stage 3 — commits-graph.delta + cross-view coalescing

Wire `computeDelta` through the generic `createGitStateMemo` (signature
`${headSha}|${mainSha}`). Coalescing falls out of worktree-keying:
- N attempts on one worktree share one delta compute.
- delta + graph of one attempt share the cheap probe; optional optimization: the
  graph's pending-half compute **write-throughs** the delta cache (delta is a
  by-product). Minimum viable: separate memo entries, probe runs twice
  (negligible).

Marginal benefit over Stage 2 (delta is only 3 cheap git calls) but completes the
coalescing story and removes the redundant `computeDeltaCore` that both the delta
resource and the graph resource run per attempt today.

**Files:** `compute-graph.ts`, `resources.ts`.

---

## Stage 4 — edited-files memo (coalesce + skip-in-flight; honest scope)

**No SHA-based incrementality exists for edited-files** — an uncommitted file
save changes the working-tree diff without moving HEAD/main/merge-base, so a SHA
signature would serve **stale** data (the "never serve stale" trap). The real
change signal is the **@parcel watcher** (`watch-edited-files.ts`), which already
debounces (200ms/2000ms ceiling) and serialized-JSON-compares before fanOut
(`recompute`, line 133). So the memo provides **coalescing + skip-in-flight
only**, with the **watcher as the cache writer**:

- The signature is a **monotonic generation counter per worktree**, bumped by the
  watcher on every completed recompute — *not* git state. The watcher already
  computes the files (`watch-edited-files.ts:131`); it writes
  `{ signature: ++generation, value: files }` into a memo where it sets
  `room.lastFiles` (in `openRoom` line 71 and `recompute` line 131), and deletes
  the entry in `closeRoom` (line 154).
- `getEditedFiles(wt)` (`get-edited-files.ts:68-72`) currently uses a bare
  worktree-keyed `createInflight` → `computeEditedFiles` (full 4-git-call recompute)
  **even when `room.lastFiles` already holds the answer**. Replace it with the
  shared memo: `signatureFn` returns the current generation; a read between file
  changes (e.g. a fresh conversation subscribing to an already-watched worktree)
  becomes a **pure cache hit with no git spawn**; a cold read (watcher hasn't
  computed yet) computes once via the embedded inflight (collapsing with
  `openRoom`'s compute if concurrent).

This reconciles the memo with the watcher: the loader stops being a redundant
recompute path and instead reads the watcher's latest-known-good list. Staleness
is unchanged from today (only the existing 200ms debounce window).

**Files:** new `edited-files-cache.ts` (shared memo + generation map, imported by
both `get-edited-files.ts` and `watch-edited-files.ts` — same plugin `internal/`),
`get-edited-files.ts`, `watch-edited-files.ts`.

---

## Correctness / staleness contract (the non-negotiable)

The memo must **never serve stale data**. Per loader:
- **commits-graph graph**: signature covers `{headSha, mainSha, mergeBase,
  pushedShas}` — every read input. Rebase (HEAD rewrite) ⇒ pending miss;
  force-push main ⇒ behind miss; new push ⇒ pushedShas change ⇒ miss.
- **delta**: `{headSha, mainSha}` — ahead/behind/merge-base all derived.
- **edited-files**: generation counter = "completed watcher computes"; a hit
  returns the latest `lastFiles`, never older than the last filesystem-settled
  state. Cold/first-subscribe race: loader misses and computes once via the
  shared inflight (collapses with `openRoom`).
- **Watcher-not-running fallback (commits-graph)**: `lastKnownMainSha()` null ⇒
  ungated `rev-parse main`.

## Memory / lifecycle

- Per-worktree `Map` entries are populated only for **subscribed** worktrees
  (live set ≈ on-screen attempts, ~16). Evict on the existing subscription
  lifecycle: commits-graph `onLastUnsubscribe` (`resources.ts:63/84` → `memo.evict`);
  edited-files `closeRoom` (`watch-edited-files.ts:154`). A re-subscribe re-probes
  cheaply (one cold compute) — acceptable.
- The graph two-half entry holds two arrays of ≤200/≤50 commit rows — trivial.
- **Composes with existing debounce**: `refHeadResource.debounceMs:300`
  (`ref-head-resource.ts:17`) and the edited-files watcher debounce reduce
  *notify* count; the memo reduces *work per surviving notify*. Complementary.
- **Composes with runtime single-flight** (`runtime.ts:382`, per `(key,
  paramsKey)` = per-attempt): nests cleanly above the loader; the memo coalesces
  *across* attempts on the same worktree and across the delta/graph split — a
  wider, worktree-keyed dedup sitting inside the loader. No double-execution, no
  deadlock.

---

## Files to create / modify

**Create:**
- `plugins/infra/plugins/git-read-cache/{package.json, CLAUDE.md}`
- `plugins/infra/plugins/git-read-cache/server/index.ts` — barrel:
  `export { createGitStateMemo }; export type { GitStateMemo }`
- `plugins/infra/plugins/git-read-cache/server/internal/git-state-memo.ts`
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-cache.ts`
- `plugins/infra/plugins/git-watcher/server/internal/main-sha.ts` (or a getter in `watcher.ts`)

**Modify:**
- `plugins/infra/plugins/host-read-pool/server/internal/pool.ts` (+ `CLAUDE.md`) — Stage 1
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/compute-graph.ts` — Stages 2–3
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/resources.ts` — Stages 2–3
- `plugins/infra/plugins/git-watcher/server/internal/watcher.ts` + `server/index.ts` — Stage 2.1
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` — Stage 4
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts` — Stage 4
- CLAUDE.md `Uses:`/`Exports:` blocks regenerate via `./equin build` (the
  `plugins-doc-in-sync` check requires it).

**Reuse (no change):** `createInflight` (`packages/inflight/core`),
`createSemaphore` (`packages/semaphore/core`),
`withHeavyReadSlot`/`createHostSemaphore` (host-read-pool / host-semaphore),
`runGit`/`LOG_FORMAT`/`parseGitLog` (`commit-list/server`), `chargeWait`
(`runtime-profiler/core`), `lastKnownSha` (`git-watcher`).

---

## Staged rollout (each independently shippable & reversible)

1. **Stage 1** — per-worktree gate isolation (`pool.ts` only). Stops one backend
   starving others under the *current* storm. Lowest risk.
2. **Stage 2** — `git-read-cache` primitive + commits-graph split-signature
   incremental. The cross-worktree `main`-advance fix — biggest win.
3. **Stage 3** — commits-graph.delta generic memo + cross-view coalescing.
4. **Stage 4** — edited-files watcher-generation memo.

Each stage: `./equin build` (both new plugins compile, barrels resolve,
`plugins-registry-in-sync` / `plugins-doc-in-sync` pass), then the verification
below. Delegate each stage to an implementation agent (Opus for Stage 2's
incremental logic; Sonnet acceptable for the more mechanical Stages 1/3/4).

---

## Verification

Methodology mirrors the two prior docs: `mcp__singularity__get_runtime_profile`
(kinds `db`/`loader`/`http`) + the durable slow-ops store + `query_db` on
`pg_stat_activity`.

**Baseline:** record `loader` `maxMs`/`count` for `commits-graph.graph`,
`commits-graph.delta`, `edited-files`; the `db [heavy-read-acquire]` aggregate
(avg ~3.4s / max ~45s); per-loader nested git spans.

- **After Stage 1:** new `db [heavy-read-local]` span appears; under a deliberate
  `main`-advance storm, `[heavy-read-acquire]` no longer concentrates in one
  worktree (`byParent`); host CPU stays unsaturated while the local gate absorbs
  each backend's burst.
- **After Stage 2 (storm test):** land a push so `refHeadResource` fans across
  ~16 worktrees (`watcher.ts:91`). Expect `commits-graph.graph` *gated*-compute
  `count` to drop sharply (pending-half hits), `maxMs` toward the cheap
  behind-half cost; `[heavy-read-acquire]` waits drop (most fan-out are memo hits
  acquiring no slot). Confirm hit-rate via the `git-memo-hit`/`miss` marker.
- **After Stage 3:** delta + graph of one attempt share the probe; redundant
  `computeDeltaCore` gone; N attempts on one worktree share one compute.
- **After Stage 4:** open a second conversation on an already-watched worktree →
  `edited-files` loader returns with no nested git spans (pure watcher-cache hit).
  Concurrent identical fetches → one compute (inflight contract preserved).

**No-stale checks (every relevant stage):**
- commits-graph: a local commit (HEAD moves) ⇒ chip updates promptly; force-push
  main ⇒ behind count updates.
- edited-files: save a file ⇒ next read reflects it after the 200ms debounce;
  revert ⇒ reflects again. The memo never returns a pre-save list once the
  watcher settles.
- `query_db` `pg_stat_activity` rollup during the storm ⇒ reduced collateral DB
  contention (the downstream goal of the prior two docs).
